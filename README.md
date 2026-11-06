# Gitropolis

Fly through any GitHub repo as a 3D city, then ask it questions out loud. The camera flies to the code that answers and a narrator explains.

- **Buildings** are source files. Height is `sqrt(lines of code)`. Color is commits in the last year (cool to hot), and the top 5% get glowing roofs.
- **Districts** are folders, laid out as a squarified treemap. Single-child folder chains are collapsed.
- **Bridges** appear when you click a building: cyan arcs for what it imports, magenta for what imports it. Monorepo aliases are resolved from tsconfig `paths` and workspace `package.json` names.
- **Ask the city** (`server/ask.mjs`) runs in two stages, both using structured outputs:
  1. *Scout:* the model reads the whole manifest (path | loc | churn | exports | header doc) and names 4–6 seed files.
  2. *Expand:* the server adds the seeds' import-graph neighbours: the files they import, the files that import them, and one more hop downward. Generic hub files (imported by 60+ files) are skipped.
  3. *Guide:* the model sees only that neighbourhood plus its import edges, and writes a 3–5 stop tour along the real code path.
  Paths the model returns are matched exactly, then by unique suffix, unique basename, or a small typo. Anything still unmatched is dropped and logged.

## Run locally

```bash
# backend
cd server && npm install
export OPENAI_API_KEY=sk-...        # required for Ask the city
export OPENAI_MODEL=gpt-4.1-mini    # any current model that supports json_schema structured outputs
npm start                           # http://localhost:8787

# frontend
cd web && npm install
npm run dev                         # http://localhost:5173 (talks to localhost:8787 by default)
```

Controls: drag to orbit, scroll to zoom, click a building to inspect it, **hold Space to talk** (Chrome), Esc to end a tour.

## Pre-bake cities (do this for every demo repo)

```bash
cd server && node bake.mjs https://github.com/excalidraw/excalidraw https://github.com/owner/other
```

This writes `server/cities/<slug>.json` (so `/api/ask` knows the city) and `web/public/cities/<slug>.json` (instant load, with no wait for a cold server). Commit both.

## Test set

```bash
cd server && API=http://localhost:8787 node eval.mjs
```

The script runs the three demo questions and checks that the tour visits the files it must visit. Re-run it after every prompt change.

## Deploy

**Backend → Render** (Web Service, Node)
- Root directory: `server`. Build: `npm install`. Start: `npm start`.
- Env: `OPENAI_API_KEY`, `OPENAI_MODEL`, optionally `GITHUB_TOKEN` (raises the GitHub API rate limit for the repo-size check).
- `git` must be on the box. Render's native Node runtime includes it.
- The free tier sleeps after about 15 minutes idle. Baked cities still load instantly from Vercel. The first *question* after a sleep can take about 50 s, so ping `/api/health` before you record.

**Frontend → Vercel**
- Root directory: `web`. Framework: Vite.
- Env: `VITE_API_URL=https://<your-render-app>.onrender.com`

## Layout of the code

```
server/analyze.mjs   clone → churn → LOC/exports/imports → layout
server/layout.mjs    treemap → 3D coordinates, churn percentiles
server/server.mjs    POST /api/city, POST /api/ask, GET /api/health
server/bake.mjs      pre-bake cities for the demo
server/eval.mjs      test set for Ask the city
web/src/Scene.jsx    R3F scene: instanced buildings, hot roofs, bridges, focus, scan ring, camera rig
web/src/App.jsx      loading, ask → tour orchestration, UI
web/src/speech.js    push-to-talk (Web Speech API) and narration (speechSynthesis)
```
