// Frozen demo answers: real model output from a passing run, saved to disk and committed.
// They make the demo questions instant and identical every time, and they survive Render
// restarting or sleeping (its disk and memory are wiped then; files in the repo are not).
// The same file is copied to web/public/answers/ so the frontend can play these tours
// without waking the server at all.
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
export const ANSWER_DIRS = [path.join(here, "answers"), path.join(here, "..", "web", "public", "answers")];

// Must match normQuestion in web/src/App.jsx. Tolerates case, punctuation and spacing, which is
// what differs between a clicked suggestion and a spoken question.
export const normQuestion = (q) => String(q).toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

export async function readFrozenFile(slug) {
  const file = path.join(ANSWER_DIRS[0], `${slug}.json`);
  if (!existsSync(file)) return null;
  return JSON.parse(await fs.readFile(file, "utf8"));
}

// Returns Map(normQuestion -> answer) for a city, with building indexes attached.
// An answer whose files no longer exist in the city (e.g. after a re-bake) is skipped.
export async function loadFrozen(slug, city) {
  const data = await readFrozenFile(slug).catch((e) => { console.error(`[frozen ${slug}] unreadable: ${e.message}`); return null; });
  const out = new Map();
  if (!data) return out;
  if (data.citySha && city.sha && data.citySha !== city.sha) console.warn(`[frozen ${slug}] answers were frozen for city ${data.citySha.slice(0, 7)}, city is ${city.sha.slice(0, 7)}`);
  const index = new Map(city.buildings.map((b, i) => [b.path, i]));
  for (const [key, a] of Object.entries(data.answers ?? {})) {
    const stops = a.stops.map((s) => ({ ...s, index: index.get(s.path) }));
    if (stops.some((s) => s.index === undefined)) { console.warn(`[frozen ${slug}] skipping "${a.question}": files missing from city`); continue; }
    out.set(key, { answer: a.answer, stops, dropped: 0, ms: 0, frozen: true, debug: { frozen: true, model: a.model, frozenAt: a.frozenAt } });
  }
  return out;
}

export async function writeFrozenFile(slug, data) {
  const json = JSON.stringify(data, null, 2) + "\n";
  for (const d of ANSWER_DIRS) {
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, `${slug}.json`), json);
  }
}
