// Test set for "Ask the city" (cases live in demo-cases.mjs). Run against a live server: API=http://localhost:8787 node eval.mjs
// Sends fresh:true, so it always tests the live model, never the frozen demo answers.
// A question passes if every MUST group appears in the tour. A group is a path or a list of acceptable paths.
// Each must group is also checked against the stage-2 candidate list, so a failure says whether the
// right file was never retrieved (retrieval miss) or was seen and skipped (selection miss).
import { CASES, SLUG, groups } from "./demo-cases.mjs";

const API = process.env.API || "http://localhost:8787";
const RUNS = Number(process.env.RUNS || 1); // >1 to check stability

const short = (p) => p.replace(/^packages\//, "").replace(/^excalidraw-app\//, "app/");

let pass = 0, total = 0;
for (let run = 1; run <= RUNS; run++) {
  for (const c of CASES) {
    total++;
    const r = await fetch(`${API}/api/ask`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ slug: SLUG, question: c.q, fresh: true }),
    }).then((r) => r.json());
    if (r.error) { console.log(`ERROR  ${c.q}: ${r.error}`); continue; }
    const got = r.stops.map((s) => s.path);
    const cands = new Set(r.debug?.candidates ?? []);
    const missing = groups(c).filter((g) => !g.some((p) => got.includes(p)));
    const ok = missing.length === 0;
    pass += ok;
    const niceHit = c.nice.filter((m) => got.includes(m)).length;
    console.log(`${ok ? "PASS" : "FAIL"}  ${c.q}  (${r.debug?.msScout}+${r.debug?.msGuide} ms, ${r.debug?.tokens} tok, nice ${niceHit}/${c.nice.length})`);
    console.log(`        seeds: ${(r.debug?.seeds ?? []).map(short).join(", ")}`);
    console.log(`        candidates: ${cands.size}, edges: ${r.debug?.edges}`);
    r.stops.forEach(({ path: p, symbol }) => console.log(`        ${groups(c).some((g) => g.includes(p)) ? "*" : c.nice.includes(p) ? "+" : " "} ${p}${symbol ? `  (${symbol})` : ""}`));
    for (const g of missing) {
      const seen = g.some((p) => cands.has(p));
      console.log(`        missing ${g.map(short).join(" | ")}  -> ${seen ? "SELECTION miss (was a candidate)" : "RETRIEVAL miss (never a candidate)"}`);
    }
    if (r.debug?.droppedPaths?.length) console.log(`        dropped: ${r.debug.droppedPaths.join(", ")}`);
    if (r.debug?.grounded?.length) console.log(`        grounded: ${r.debug.grounded.map((g) => `${g.symbol} -> ${g.definer.split("/").pop()}`).join(", ")}`);
    if (r.debug?.repaired?.length) console.log(`        repaired: ${r.debug.repaired.map((x) => `${x.from} => ${x.to}`).join(", ")}`);
    console.log(`        "${r.answer}"`);
  }
}
console.log(`\n${pass}/${total} passed`);
