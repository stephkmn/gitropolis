// Squarified treemap -> 3D city. Folders = district plinths, files = buildings.
import { hierarchy, treemap, treemapSquarify } from "d3-hierarchy";

const PLINTH = 0.8;            // thickness of each nested district plinth
const HEIGHT_K = 0.9;          // building height = HEIGHT_K * sqrt(loc)
const footprint = (loc) => Math.sqrt(loc) + 4; // treemap area value

function buildTree(files) {
  const root = { name: "", path: "", children: new Map() };
  for (const f of files) {
    const parts = f.path.split("/");
    let node = root;
    parts.slice(0, -1).forEach((p, i) => {
      if (!node.children.has(p)) node.children.set(p, { name: p, path: parts.slice(0, i + 1).join("/"), children: new Map() });
      node = node.children.get(p);
    });
    node.children.set(parts.at(-1), { name: parts.at(-1), path: f.path, file: f });
  }
  // Collapse single-child folder chains: packages/element/src -> one district "element/src"
  const collapse = (n, isRoot) => {
    if (!n.children) return n;
    while (!isRoot && n.children.size === 1) {
      const only = [...n.children.values()][0];
      if (!only.children) break;
      n = { ...only, name: `${n.name}/${only.name}` };
    }
    return { name: n.name, path: n.path, children: [...n.children.values()].map((c) => collapse(c, false)) };
  };
  return collapse(root, true);
}

export function layoutCity(files) {
  const tree = buildTree(files);
  const root = hierarchy(tree, (d) => d.children)
    .sum((d) => (d.file ? footprint(d.file.loc) : 0))
    .sort((a, b) => b.value - a.value);
  const W = Math.sqrt(root.value) * 3;
  treemap()
    .size([W, W])
    .tile(treemapSquarify.ratio(1))
    .paddingOuter((n) => (n.depth === 0 ? 4 : n.depth === 1 ? 3 : 1.5))
    .paddingInner((n) => (n.depth === 0 ? 4 : 1))
    .round(false)(root);

  // Percentile among files that changed at all; otherwise the many zero-churn files push everything else to "hot".
  const sortedChurn = files.map((f) => f.churn).filter((c) => c > 0).sort((a, b) => a - b);
  const pct = (c) => {
    if (c === 0) return 0;
    let lo = 0, hi = sortedChurn.length; // first index with churn >= c
    while (lo < hi) { const mid = (lo + hi) >> 1; sortedChurn[mid] < c ? (lo = mid + 1) : (hi = mid); }
    return lo / sortedChurn.length;
  };

  const districts = [];
  const buildings = [];
  const off = W / 2;
  root.each((n) => {
    if (n.depth === 0) return;
    // Clamp: padding can squeeze tiny cells to zero width, and zero-size boxes give NaN normals,
    // which the bloom pass smears into a fully black frame.
    const rect = { x: (n.x0 + n.x1) / 2 - off, z: (n.y0 + n.y1) / 2 - off, w: Math.max(0.8, n.x1 - n.x0), d: Math.max(0.8, n.y1 - n.y0) };
    if (n.data.file) {
      const f = n.data.file;
      buildings.push({
        ...f, ...rect,
        y: (n.depth - 1) * PLINTH,
        h: Math.max(1, HEIGHT_K * Math.sqrt(f.loc)),
        churnPct: +pct(f.churn).toFixed(3),
      });
    } else {
      districts.push({ path: n.data.path, name: n.data.name, depth: n.depth, ...rect, y: (n.depth - 1) * PLINTH, t: PLINTH });
    }
  });

  const idx = new Map(buildings.map((b, i) => [b.path, i]));
  for (const b of buildings) {
    // importNames[k] = names imported along imports[k] (kept aligned when unresolved targets are dropped)
    const pairs = b.imports.map((p) => [idx.get(p), b.importNames?.[p] ?? []]).filter(([i]) => i !== undefined);
    b.imports = pairs.map(([i]) => i);
    b.importNames = pairs.map(([, n]) => n);
  }
  return { size: W, districts, buildings };
}
