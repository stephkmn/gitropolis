// The demo questions and what a correct tour must visit. Shared by eval.mjs (testing) and
// freeze.mjs (which only saves a demo answer after it passes these checks).
// A must group is a path or a list of acceptable paths; every group must appear in the tour.
export const SLUG = "excalidraw__excalidraw";
const P = "packages/excalidraw/";

export const CASES = [
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
    // mermaid.ts is only a 52-line config. The real path is TextToDiagram.tsx -> useTextGeneration /
    // TTDStreamFetch (LLM call) -> common.ts (convertMermaidToExcalidraw + insertToEditor).
    must: [[`${P}components/TTDDialog/TextToDiagram.tsx`, `${P}components/TTDDialog/TTDDialog.tsx`], `${P}components/TTDDialog/common.ts`],
    nice: [`${P}components/TTDDialog/hooks/useTextGeneration.ts`, `${P}components/TTDDialog/utils/TTDStreamFetch.ts`, `${P}components/TTDDialog/MermaidToExcalidraw.tsx`, `${P}mermaid.ts`],
  },
  {
    q: "Which files are the riskiest to change?",
    // App.tsx is #1 in both size (11.5k lines) and churn (108 commits in the last year).
    must: [`${P}components/App.tsx`],
    nice: [`${P}types.ts`, "packages/element/src/binding.ts"],
  },
];

export const groups = (c) => c.must.map((g) => (Array.isArray(g) ? g : [g]));
export const missingGroups = (c, paths) => groups(c).filter((g) => !g.some((p) => paths.includes(p)));
