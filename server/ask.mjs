// "Ask the city": two-stage, graph-guided retrieval.
//   Stage 1 (scout): the model reads the whole manifest and names 4-6 seed files.
//   Expand:          the server adds every file the seeds import or are imported by (the real code path).
//   Stage 2 (guide): the model sees only that neighbourhood + its import edges and writes a 3-5 stop tour
//                    that follows the chain from entry point to the lowest layer.
// Why: one-shot picking stayed on one layer and missed files with indirect names (eval: 0/3).
// The files it missed were all one import away from files it did pick.
import { buildManifest } from "./analyze.mjs";

const MAX_CANDIDATES = 90;

const lineFor = (b) =>
  `${b.path} | loc ${b.loc} | churn ${b.churn}${b.exports.length ? ` | exports ${b.exports.join(",")}` : ""}${b.doc ? ` | ${b.doc}` : ""}`;

const SEED_SCHEMA = {
  name: "seeds",
  strict: true,
  schema: {
    type: "object", additionalProperties: false, required: ["seeds"],
    properties: {
      seeds: {
        type: "array",
        description: "4-6 files most likely involved, spanning UI/entry, core logic, and low-level layers.",
        items: { type: "string", description: "Exact path from the manifest." },
      },
    },
  },
};

const TOUR_SCHEMA = {
  name: "city_tour",
  strict: true,
  schema: {
    type: "object", additionalProperties: false, required: ["answer", "stops"],
    properties: {
      answer: { type: "string", description: "1-2 spoken sentences answering the question. No markdown, no file paths." },
      stops: {
        type: "array",
        description: "3-5 files ordered along the code path: entry point -> core logic -> lowest layer.",
        items: {
          type: "object", additionalProperties: false, required: ["path", "why"],
          properties: {
            path: { type: "string", description: "Exact path from the candidate list." },
            why: { type: "string", description: "One spoken sentence, under 25 words, on this file's role." },
          },
        },
      },
    },
  },
};

const scoutPrompt = (city) => `You are the scout for Gitropolis, a 3D city where every building is a source file of ${city.repo}.
Given a question, name the 4-6 files most likely involved in answering it.
- Cover different layers: where it starts (UI, action, entry point), the core logic, and the lowest level (data structures, storage, crypto, algorithms).
- Small files with indirect names can matter: read the exports, not just the file names.
- Use ONLY paths from the manifest, copied character-for-character.

MANIFEST (path | loc | churn | exports | header doc):
${buildManifest(city)}`;

const guidePrompt = (city, cands, edges) => `You are the narrator of Gitropolis, a 3D city where every building is a source file of ${city.repo}.
Districts are folders. Height = lines of code. Red heat = churn (commits in the last year).
Below is the neighbourhood of the code relevant to the question: candidate files and the import edges between them ("A -> B" means A imports B).
Write a guided tour of 3-5 stops that answers the question.
Rules:
- Follow the real code path: start where the feature begins (UI or action), then the core logic, then the lowest layer that actually does the work. Use the import edges to find that chain; consecutive stops should usually be connected by an edge.
- Use 4 or 5 stops when the path has that many meaningful layers. Skip generic helpers (types, constants, i18n, icons, utils) unless they are the answer.
- Every file you mention in "answer" must be one of the stops.
- Use ONLY paths from the candidate list, copied character-for-character.
- For questions about risk, complexity, or hotspots, use the loc and churn numbers.
- Speak like a friendly tour guide. Refer to files by plain name without extension (e.g. "the history module"). No markdown.
- If nothing is relevant, say so in "answer" and return an empty stops array.

CANDIDATES (path | loc | churn | exports | header doc):
${cands.map(lineFor).join("\n")}

IMPORT EDGES:
${edges.join("\n")}`;

// Map a model-returned path to a real one: exact, then unique suffix, then unique basename, then small typo.
function makeResolver(paths) {
  const set = new Set(paths);
  const byBase = new Map();
  for (const p of paths) { const b = p.split("/").pop(); (byBase.get(b) ?? byBase.set(b, []).get(b)).push(p); }
  const lev = (a, b) => {
    if (Math.abs(a.length - b.length) > 2) return 99;
    const d = Array.from({ length: b.length + 1 }, (_, i) => i);
    for (let i = 1; i <= a.length; i++) {
      let prev = d[0]; d[0] = i;
      for (let j = 1; j <= b.length; j++) { const t = d[j]; d[j] = Math.min(d[j] + 1, d[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1)); prev = t; }
    }
    return d[b.length];
  };
  return (raw) => {
    const p = String(raw).trim().replace(/^\.?\//, "");
    if (set.has(p)) return { path: p, how: "exact" };
    const suffix = paths.filter((x) => x.endsWith("/" + p) || p.endsWith("/" + x));
    if (suffix.length === 1) return { path: suffix[0], how: "suffix" };
    const base = byBase.get(p.split("/").pop()) ?? [];
    if (base.length === 1) return { path: base[0], how: "basename" };
    const close = paths.filter((x) => lev(x, p) <= 2);
    if (close.length === 1) return { path: close[0], how: "typo" };
    return null;
  };
}

export async function askCity({ openai, model, city, question, log = console.log }) {
  const B = city.buildings;
  const index = new Map(B.map((b, i) => [b.path, i]));
  const incoming = new Map();
  B.forEach((b, i) => b.imports.forEach((j) => (incoming.get(j) ?? incoming.set(j, []).get(j)).push(i)));
  const resolveAll = makeResolver(B.map((b) => b.path));
  const chat = (system, schema) =>
    openai.chat.completions.create({
      model, temperature: 0,
      response_format: { type: "json_schema", json_schema: schema },
      messages: [{ role: "system", content: system }, { role: "user", content: question }],
    });

  // Stage 1: scout
  const t0 = Date.now();
  const s1 = await chat(scoutPrompt(city), SEED_SCHEMA);
  const rawSeeds = JSON.parse(s1.choices[0].message.content).seeds;
  const seeds = [...new Set(rawSeeds.map((p) => resolveAll(p)?.path).filter(Boolean))];
  const t1 = Date.now();

  // Expand: seeds + 1-hop neighbours, ranked by how many seeds touch them.
  // Generic hubs (types, utils, constants, i18n, icons: imported by 60+ files) carry no signal about
  // a specific feature, so they are never expanded through and edges into them are left out.
  const inDeg = B.map((_, i) => (incoming.get(i) ?? []).length);
  const isHub = (i) => inDeg[i] > 60;
  const score = new Map();
  const bump = (j, w) => !isHub(j) && score.set(j, Math.max(score.get(j) ?? 0, 0) + w);
  for (const s of seeds) score.set(index.get(s), 1000);
  for (const s of seeds) {
    const i = index.get(s);
    B[i].imports.forEach((j) => bump(j, 1 + B[j].churn / 1000));
    if (inDeg[i] <= 15) (incoming.get(i) ?? []).forEach((j) => bump(j, 1 + B[j].churn / 1000)); // who calls it
  }
  // Second hop, downward only (what first-hop files import), so a tour can reach the lowest layer
  // even when the scout only found the entry point. Capped and scored below every first-hop file.
  const hop2 = new Map();
  for (const [i, s] of score) {
    if (s >= 1000 || isHub(i)) continue;
    for (const j of B[i].imports) if (!score.has(j) && !isHub(j)) hop2.set(j, (hop2.get(j) ?? 0) + 0.1);
  }
  [...hop2.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([j, w]) => score.set(j, w));
  const candIdx = [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, MAX_CANDIDATES).map(([i]) => i);
  const candSet = new Set(candIdx);
  const cands = candIdx.map((i) => B[i]);
  const edges = [];
  for (const i of candIdx) for (const j of B[i].imports) if (candSet.has(j) && !isHub(j)) edges.push(`${B[i].path} -> ${B[j].path}`);

  // Stage 2: guide
  const s2 = await chat(guidePrompt(city, cands, edges), TOUR_SCHEMA);
  const raw = JSON.parse(s2.choices[0].message.content);
  const t2 = Date.now();

  const resolveCand = makeResolver(cands.map((b) => b.path));
  const seen = new Set();
  const dropped = [], repaired = [];
  const stops = [];
  for (const s of raw.stops) {
    const r = resolveCand(s.path) ?? resolveAll(s.path);
    if (!r) { dropped.push(s.path); continue; }
    if (r.how !== "exact") repaired.push({ from: s.path, to: r.path, how: r.how });
    if (seen.has(r.path)) continue;
    seen.add(r.path);
    stops.push({ path: r.path, why: s.why, index: index.get(r.path) });
  }

  const out = {
    answer: raw.answer,
    stops: stops.slice(0, 5),
    dropped: dropped.length,
    ms: t2 - t0,
    debug: {
      seeds, rawSeedsDropped: rawSeeds.filter((p) => !resolveAll(p)),
      candidates: cands.map((b) => b.path), edges: edges.length,
      droppedPaths: dropped, repaired, msScout: t1 - t0, msGuide: t2 - t1,
      tokens: (s1.usage?.total_tokens ?? 0) + (s2.usage?.total_tokens ?? 0),
    },
  };
  log(`[ask ${city.slug}] "${question}"\n  seeds: ${seeds.join(", ")}\n  candidates: ${cands.length}, edges: ${edges.length}\n  tour: ${out.stops.map((s) => s.path).join(" -> ")}${dropped.length ? `\n  DROPPED: ${dropped.join(", ")}` : ""}${repaired.length ? `\n  repaired: ${repaired.map((r) => `${r.from} => ${r.to} (${r.how})`).join(", ")}` : ""}\n  ${out.debug.msScout} + ${out.debug.msGuide} ms`);
  return out;
}
