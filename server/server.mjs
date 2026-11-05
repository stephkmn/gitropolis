import express from "express";
import cors from "cors";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { analyzeRepo, buildManifest, parseRepoUrl, cityPath, exists } from "./analyze.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CITY_DIR = path.join(here, "cities");
const PORT = process.env.PORT || 8787;
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini"; // any model that supports json_schema structured outputs
const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;

await fs.mkdir(CITY_DIR, { recursive: true });
const cities = new Map();   // slug -> city (memory cache)
const inflight = new Map(); // slug -> Promise<city>
const answers = new Map();  // slug|question -> answer (keeps demo answers stable + cheap)

async function getCity(slug) {
  if (cities.has(slug)) return cities.get(slug);
  const file = cityPath(CITY_DIR, slug);
  if (!exists(file)) return null;
  const city = JSON.parse(await fs.readFile(file, "utf8"));
  cities.set(slug, city);
  return city;
}

const app = express();
app.use(cors());
app.use(express.json({ limit: "100kb" }));

app.get("/api/health", (_req, res) => res.json({ ok: true, llm: !!openai, model: MODEL }));

app.post("/api/city", async (req, res) => {
  try {
    const { slug } = parseRepoUrl(req.body?.repoUrl);
    const cached = await getCity(slug);
    if (cached) return res.json(cached);
    if (!inflight.has(slug)) {
      inflight.set(slug, analyzeRepo(req.body.repoUrl, { log: (m) => console.log(`[${slug}] ${m}`) })
        .then(async (city) => {
          await fs.writeFile(cityPath(CITY_DIR, slug), JSON.stringify(city));
          cities.set(slug, city);
          return city;
        })
        .finally(() => inflight.delete(slug)));
    }
    res.json(await inflight.get(slug));
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message });
  }
});

const SCHEMA = {
  name: "city_tour",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["answer", "stops"],
    properties: {
      answer: { type: "string", description: "1-2 spoken sentences answering the question. No markdown, no file paths." },
      stops: {
        type: "array",
        description: "2-5 files, ordered so the tour tells a story (entry point -> core logic -> storage/low level).",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["path", "why"],
          properties: {
            path: { type: "string", description: "Exact path copied from the manifest." },
            why: { type: "string", description: "One spoken sentence, under 25 words, on this file's role in the answer." },
          },
        },
      },
    },
  },
};

const systemPrompt = (city) => `You are the narrator of Gitropolis, a 3D city where every building is a source file of the GitHub repo ${city.repo}.
Districts are folders. Building height = lines of code. Building heat (red) = churn: commits touching the file in the last year.
Given a question, pick the 2-5 buildings that best answer it and narrate a short guided tour.
Rules:
- Use ONLY paths that appear in the manifest, copied character-for-character.
- Order stops to tell a story: where it starts (UI/action), then the core logic, then the lowest level (data, storage, algorithms).
- Prefer files in different districts when they are genuinely involved; it makes the tour more vivid.
- For questions about risk, complexity, or hotspots, use the loc and churn numbers.
- Speak like a friendly tour guide. Refer to files by plain name without extension (e.g. "the history module"). No markdown.
- If the manifest has nothing relevant, say so in "answer" and return an empty stops array.

MANIFEST (path | loc | churn | exports | header doc):
${buildManifest(city)}`;

app.post("/api/ask", async (req, res) => {
  try {
    const { slug, question } = req.body ?? {};
    if (!question || typeof question !== "string" || question.length > 300) throw new Error("Ask a question (max 300 chars)");
    const city = await getCity(String(slug));
    if (!city) throw new Error("Unknown city; load it first");
    const key = `${slug}|${question.trim().toLowerCase().replace(/[?.!\s]+$/, "")}`;
    if (answers.has(key)) return res.json(answers.get(key));
    if (!openai) throw new Error("OPENAI_API_KEY is not set on the server");

    const t0 = Date.now();
    const completion = await openai.chat.completions.create({
      model: MODEL,
      temperature: 0.2,
      response_format: { type: "json_schema", json_schema: SCHEMA },
      messages: [
        { role: "system", content: systemPrompt(city) }, // stable prefix -> prompt caching
        { role: "user", content: question },
      ],
    });
    const raw = JSON.parse(completion.choices[0].message.content);
    const index = new Map(city.buildings.map((b, i) => [b.path, i]));
    const seen = new Set();
    const stops = raw.stops
      .filter((s) => index.has(s.path) && !seen.has(s.path) && seen.add(s.path)) // drop hallucinated/duplicate paths
      .slice(0, 5)
      .map((s) => ({ ...s, index: index.get(s.path) }));
    const out = { answer: raw.answer, stops, dropped: raw.stops.length - stops.length, ms: Date.now() - t0, usage: completion.usage };
    console.log(`[ask ${slug}] "${question}" -> ${stops.map((s) => s.path).join(", ")} (${out.ms} ms, dropped ${out.dropped})`);
    answers.set(key, out);
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`gitropolis server on :${PORT} (llm: ${openai ? MODEL : "OFF"})`));
