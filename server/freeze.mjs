// Freeze the demo answers: ask each demo question with the real model, keep an answer only if its
// tour passes the checks in demo-cases.mjs, and save it to server/answers/ and web/public/answers/.
// usage: OPENAI_API_KEY=sk-... OPENAI_MODEL=gpt-4.1 node freeze.mjs
// env: TRIES (default 3) attempts per question.
// Re-run after re-baking the city: answers frozen for another city version are discarded.
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import OpenAI from "openai";
import { askCity } from "./ask.mjs";
import { CASES, SLUG, missingGroups } from "./demo-cases.mjs";
import { normQuestion, readFrozenFile, writeFrozenFile } from "./answers.mjs";

if (!process.env.OPENAI_API_KEY) { console.error("Set OPENAI_API_KEY"); process.exit(1); }
const MODEL = process.env.OPENAI_MODEL || "gpt-4.1-mini";
const TRIES = Number(process.env.TRIES || 3);
const here = path.dirname(fileURLToPath(import.meta.url));
const city = JSON.parse(await fs.readFile(path.join(here, "cities", `${SLUG}.json`), "utf8"));
const openai = new OpenAI();

// Keep earlier answers only if they were frozen for this exact city version.
const prev = await readFrozenFile(SLUG);
const answers = prev?.citySha === city.sha ? { ...prev.answers } : {};
if (prev && prev.citySha !== city.sha) console.log("City was re-baked since the last freeze: starting fresh.");

const failed = [];
for (const c of CASES) {
  let saved = false;
  for (let attempt = 1; attempt <= TRIES && !saved; attempt++) {
    const out = await askCity({ openai, model: MODEL, city, question: c.q, log: () => {} });
    const paths = out.stops.map((s) => s.path);
    const missing = missingGroups(c, paths);
    if (missing.length) {
      console.log(`  try ${attempt}/${TRIES} FAIL  ${c.q}  missing ${missing.map((g) => g.join(" | ")).join("; ")}`);
      continue;
    }
    answers[normQuestion(c.q)] = {
      question: c.q,
      answer: out.answer,
      stops: out.stops.map(({ path: p, symbol, why }) => ({ path: p, symbol, why })),
      model: MODEL,
      frozenAt: new Date().toISOString(),
    };
    saved = true;
    console.log(`FROZEN  ${c.q}`);
    out.stops.forEach((s, k) => console.log(`        ${k + 1}. ${s.path}${s.symbol ? `  (${s.symbol})` : ""}\n           ${s.why}`));
    console.log(`        "${out.answer}"`);
  }
  if (!saved) failed.push(c.q);
}

await writeFrozenFile(SLUG, { slug: SLUG, citySha: city.sha, answers });
console.log(`\nWrote ${Object.keys(answers).length} answers to server/answers/${SLUG}.json and web/public/answers/${SLUG}.json`);
console.log("Read the tours above before committing: they are what voters will hear.");
if (failed.length) {
  console.log(`\nNot frozen (failed ${TRIES} tries): ${failed.join(" | ")}\nThose questions still go to the live model.`);
  process.exit(1);
}
