// Test set for "Ask the city". Run against a live server: API=http://localhost:8787 node eval.mjs
// A question passes if every MUST group appears in the tour. A group is a path or a list of acceptable paths.
// Each must group is also checked against the stage-2 candidate list, so a failure says whether the
// right file was never retrieved (retrieval miss) or was seen and skipped (selection miss).
const API = process.env.API || "http://localhost:8787";
const RUNS = Number(process.env.RUNS || 1); // >1 to check stability
const SLUG = "excalidraw__excalidraw";
const P = "packages/excalidraw/";
const CASES = [
  {
    q: "How does undo work?",
    // history.ts keeps the stacks; store.ts captures each change (history.ts imports it); delta.ts holds the reversible diffs.
    must: [`${P}history.ts`, ["packages/element/src/store.ts", "packages/element/src/delta.ts"]],
    nice: [`${P}actions/actionHistory.tsx`, "packages/element/src/store.ts", "packages/element/src/delta.ts"],
  },
  {
    q: "How is live collaboration end-to-end encrypted?",
    // Portal.tsx calls encryptData before broadcasting; Collab.tsx calls decryptData on receive.
    must: [`${P}data/encryption.ts`, ["excalidraw-app/collab/Collab.tsx", "excalidraw-app/collab/Portal.tsx"]],
    nice: ["excalidraw-app/collab/Portal.tsx", "excalidraw-app/collab/Collab.tsx", "excalidraw-app/data/index.ts", `${P}data/reconcile.ts`],
  },
  {
    q: "How does text-to-diagram turn a prompt into a drawing?",
    // Revised: mermaid.ts is only a 52-line config. The real path is TextToDiagram.tsx -> useTextGeneration /
    // TTDStreamFetch (LLM call) -> common.ts (convertMermaidToExcalidraw + insertToEditor).
    must: [[`${P}components/TTDDialog/TextToDiagram.tsx`, `${P}components/TTDDialog/TTDDialog.tsx`], `${P}components/TTDDialog/common.ts`],
    nice: [`${P}components/TTDDialog/hooks/useTextGeneration.ts`, `${P}components/TTDDialog/utils/TTDStreamFetch.ts`, `${P}components/TTDDialog/MermaidToExcalidraw.tsx`, `${P}mermaid.ts`],
  },
];

const short = (p) => p.replace(/^packages\//, "").replace(/^excalidraw-app\//, "app/");
const groups = (c) => c.must.map((g) => (Array.isArray(g) ? g : [g]));

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
    got.forEach((p) => console.log(`        ${groups(c).some((g) => g.includes(p)) ? "*" : c.nice.includes(p) ? "+" : " "} ${p}`));
    for (const g of missing) {
      const seen = g.some((p) => cands.has(p));
      console.log(`        missing ${g.map(short).join(" | ")}  -> ${seen ? "SELECTION miss (was a candidate)" : "RETRIEVAL miss (never a candidate)"}`);
    }
    if (r.debug?.droppedPaths?.length) console.log(`        dropped: ${r.debug.droppedPaths.join(", ")}`);
    if (r.debug?.repaired?.length) console.log(`        repaired: ${r.debug.repaired.map((x) => `${x.from} => ${x.to}`).join(", ")}`);
    console.log(`        "${r.answer}"`);
  }
}
console.log(`\n${pass}/${total} passed`);
