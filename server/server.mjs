import express from "express";
import cors from "cors";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { analyzeRepo, parseRepoUrl, cityPath, exists } from "./analyze.mjs";
import { askCity } from "./ask.mjs";
import { loadFrozen, normQuestion } from "./answers.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const CITY_DIR = path.join(here, "cities");
const PORT = process.env.PORT || 8787;
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini"; // any model that supports json_schema structured outputs
const openai = process.env.OPENAI_API_KEY ? new OpenAI() : null;

await fs.mkdir(CITY_DIR, { recursive: true });
const cities = new Map();   // slug -> city (memory cache)
const inflight = new Map(); // slug -> Promise<city>
const answers = new Map();  // slug|question -> answer (keeps demo answers stable + cheap)
const frozen = new Map();   // slug -> Map(normQuestion -> frozen answer), loaded from server/answers/

async function getFrozen(slug, city) {
  if (!frozen.has(slug)) frozen.set(slug, loadFrozen(slug, city));
  return frozen.get(slug);
}

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

app.post("/api/ask", async (req, res) => {
  try {
    const { slug, question } = req.body ?? {};
    if (!question || typeof question !== "string" || question.length > 300) throw new Error("Ask a question (max 300 chars)");
    const city = await getCity(String(slug));
    if (!city) throw new Error("Unknown city; load it first");
    const key = `${slug}|${normQuestion(question)}`;
    if (!req.body.fresh) {
      const hit = (await getFrozen(String(slug), city)).get(normQuestion(question));
      if (hit) return res.json(hit);
      if (answers.has(key)) return res.json(answers.get(key));
    }
    if (!openai) throw new Error("OPENAI_API_KEY is not set on the server");
    const out = await askCity({ openai, model: MODEL, city, question });
    answers.set(key, out);
    res.json(out);
  } catch (e) {
    console.error(e);
    res.status(400).json({ error: e.message });
  }
});

app.listen(PORT, () => console.log(`gitropolis server on :${PORT} (llm: ${openai ? MODEL : "OFF"})`));
