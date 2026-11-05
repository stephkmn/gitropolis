// Test set for "Ask the city". Run against a live server: API=http://localhost:8787 node eval.mjs
// A question passes if every MUST file appears in the tour.
const API = process.env.API || "http://localhost:8787";
const SLUG = "excalidraw__excalidraw";
const CASES = [
  {
    q: "How does undo work?",
    must: ["packages/excalidraw/history.ts", "packages/element/src/store.ts", "packages/element/src/delta.ts"],
    nice: ["packages/excalidraw/actions/actionHistory.tsx"],
  },
  {
    q: "How is live collaboration end-to-end encrypted?",
    must: ["excalidraw-app/collab/Collab.tsx", "packages/excalidraw/data/encryption.ts"],
    nice: ["excalidraw-app/collab/Portal.tsx", "packages/excalidraw/data/reconcile.ts"],
  },
  {
    q: "How does text-to-diagram turn a prompt into a drawing?",
    must: ["packages/excalidraw/components/TTDDialog/TTDDialog.tsx", "packages/excalidraw/mermaid.ts"],
    nice: ["packages/excalidraw/components/TTDDialog/utils/TTDStreamFetch.ts"],
  },
];

let pass = 0;
for (const c of CASES) {
  const r = await fetch(`${API}/api/ask`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ slug: SLUG, question: c.q }),
  }).then((r) => r.json());
  if (r.error) { console.log(`ERROR  ${c.q}: ${r.error}`); continue; }
  const got = r.stops.map((s) => s.path);
  const missing = c.must.filter((m) => !got.includes(m));
  const niceHit = c.nice.filter((m) => got.includes(m)).length;
  const ok = missing.length === 0;
  pass += ok;
  console.log(`${ok ? "PASS" : "FAIL"}  ${c.q}  (${r.ms} ms, nice ${niceHit}/${c.nice.length}, dropped ${r.dropped})`);
  got.forEach((p) => console.log(`        ${c.must.includes(p) ? "*" : c.nice.includes(p) ? "+" : " "} ${p}`));
  if (missing.length) console.log(`        missing: ${missing.join(", ")}`);
  console.log(`        "${r.answer}"`);
}
console.log(`\n${pass}/${CASES.length} passed`);
