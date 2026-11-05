// Pre-bake cities so the demo never waits on a cold server.
// usage: node bake.mjs https://github.com/excalidraw/excalidraw [more urls...]
// Writes server/cities/<slug>.json and web/public/cities/<slug>.json
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeRepo } from "./analyze.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const outDirs = [path.join(here, "cities"), path.join(here, "..", "web", "public", "cities")];
const urls = process.argv.slice(2);
if (!urls.length) urls.push("https://github.com/excalidraw/excalidraw");

for (const url of urls) {
  const t0 = Date.now();
  const city = await analyzeRepo(url, { log: (m) => console.log(`  ${m}`) });
  for (const d of outDirs) {
    await fs.mkdir(d, { recursive: true });
    await fs.writeFile(path.join(d, `${city.slug}.json`), JSON.stringify(city));
  }
  const top = [...city.buildings].sort((a, b) => b.churn - a.churn).slice(0, 3).map((b) => `${b.path} (${b.churn})`);
  console.log(`${city.repo}: ${city.stats.files} files, ${city.stats.loc} loc, ${city.stats.edges} import edges, ${city.districts.length} districts, ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  hottest: ${top.join(", ")}`);
}
