// Gitropolis analyzer: GitHub repo URL -> city JSON (metrics + layout).
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { layoutCity } from "./layout.mjs";

const run = promisify(execFile);
const git = (cwd, ...args) =>
  run("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 }).then((r) => r.stdout);

const SRC_EXT = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const IGNORE = /(^|\/)(node_modules|dist|build|out|coverage|vendor|\.next|public)\/|\.min\.js$|\.d\.ts$/;
const TEST = /(\.test\.|\.spec\.|__tests__\/|(^|\/)tests?\/|__mocks__\/|setupTests)/;
const RESOLVE_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", "/index.ts", "/index.tsx", "/index.js", "/index.jsx"];
export const MAX_FILES = 3000;
const MAX_REPO_KB = 200_000;

export function parseRepoUrl(url) {
  const m = String(url).trim().match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/i)
    || String(url).trim().match(/^([\w.-]+)\/([\w.-]+)$/);
  if (!m) throw new Error("Expected a GitHub URL like https://github.com/owner/repo");
  return { owner: m[1], repo: m[2], slug: `${m[1]}__${m[2]}`.toLowerCase() };
}

async function checkSize(owner, repo) {
  try {
    const r = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
      headers: { "User-Agent": "gitropolis", ...(process.env.GITHUB_TOKEN && { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }) },
      signal: AbortSignal.timeout(5000),
    });
    if (r.status === 404) throw new Error("Repo not found (or private)");
    if (!r.ok) return; // rate-limited etc. -> don't block, the file cap still protects us
    const j = await r.json();
    if (j.size > MAX_REPO_KB) throw new Error(`Repo is ${(j.size / 1024).toFixed(0)} MB; limit is ${MAX_REPO_KB / 1024} MB`);
  } catch (e) {
    if (/not found|limit is/.test(e.message)) throw e;
  }
}

// Lenient JSON (tsconfig allows comments + trailing commas)
function parseLenientJson(text) {
  const noComments = text.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str ?? "");
  return JSON.parse(noComments.replace(/,(\s*[}\]])/g, "$1"));
}

// Alias map from root tsconfig "paths" + workspace package.json names.
async function buildAliases(dir, allFiles) {
  const exact = new Map(); // "@scope/pkg" -> "packages/pkg/src/index.ts"
  const prefix = [];       // ["@scope/pkg/", "packages/pkg/src/"]
  for (const name of ["tsconfig.json", "tsconfig.base.json", "jsconfig.json"]) {
    try {
      const cfg = parseLenientJson(await fs.readFile(path.join(dir, name), "utf8"));
      const base = cfg.compilerOptions?.baseUrl ?? ".";
      for (const [k, v] of Object.entries(cfg.compilerOptions?.paths ?? {})) {
        const target = path.posix.normalize(path.posix.join(base, v[0]));
        if (k.endsWith("/*")) prefix.push([k.slice(0, -1), target.replace(/\*$/, "")]);
        else exact.set(k, target);
      }
    } catch {}
  }
  for (const pj of allFiles.filter((f) => f.endsWith("package.json") && !f.includes("node_modules") && f.includes("/"))) {
    try {
      const { name } = JSON.parse(await fs.readFile(path.join(dir, pj), "utf8"));
      const pkgDir = path.posix.dirname(pj);
      if (!name || exact.has(name)) continue;
      const src = allFiles.some((f) => f.startsWith(`${pkgDir}/src/`)) ? `${pkgDir}/src` : pkgDir;
      exact.set(name, `${src}/index`);
      prefix.push([`${name}/`, `${src}/`]);
    } catch {}
  }
  prefix.sort((a, b) => b[0].length - a[0].length); // most specific first
  return { exact, prefix };
}

const reImport = /(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\s*['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;
const reExport = /export\s+(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:function\*?|class|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g;

// Only a comment at the very top of the file counts as a description.
function headerDoc(src) {
  const m = src.replace(/^#![^\n]*\n/, "").match(/^\s*(?:\/\*\*?([\s\S]*?)\*\/|((?:\s*\/\/[^\n]*\n)+))/);
  if (!m) return "";
  const text = (m[1] ?? m[2]).replace(/^\s*(\*|\/\/)\s?/gm, "").replace(/@\w+.*$/gm, "").replace(/\s+/g, " ").trim();
  if (/eslint|prettier|copyright|license|@ts-|use strict/i.test(text)) return "";
  return text.slice(0, 140);
}

export async function analyzeRepo(repoUrl, { log = () => {} } = {}) {
  const { owner, repo, slug } = parseRepoUrl(repoUrl);
  await checkSize(owner, repo);
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "gitropolis-"));
  try {
    log(`cloning ${owner}/${repo}`);
    await run("git", ["clone", "-q", "--filter=blob:none", `https://github.com/${owner}/${repo}.git`, dir], { timeout: 120_000 });
    const sha = (await git(dir, "rev-parse", "HEAD")).trim();
    const allFiles = (await git(dir, "ls-files")).split("\n").filter(Boolean);

    let src = allFiles.filter((f) => SRC_EXT.test(f) && !IGNORE.test(f));
    const testCount = src.filter((f) => TEST.test(f)).length;
    src = src.filter((f) => !TEST.test(f));
    const truncated = src.length > MAX_FILES;
    src = src.slice(0, MAX_FILES);
    const srcSet = new Set(src);

    log("churn");
    const churn = new Map();
    const logOut = await git(dir, "log", "--since=1.year", "--name-only", "--format=");
    for (const f of logOut.split("\n")) if (srcSet.has(f)) churn.set(f, (churn.get(f) ?? 0) + 1);

    const aliases = await buildAliases(dir, allFiles);
    const resolveBase = (base) => {
      for (const e of RESOLVE_EXTS) if (srcSet.has(base + e)) return base + e;
      const stripped = base.replace(/\.(js|jsx|mjs)$/, ""); // TS ESM style "./foo.js" -> foo.ts
      if (stripped !== base) for (const e of RESOLVE_EXTS) if (srcSet.has(stripped + e)) return stripped + e;
      return null;
    };
    const resolveSpec = (from, spec) => {
      if (spec.startsWith(".")) return resolveBase(path.posix.normalize(path.posix.join(path.posix.dirname(from), spec)));
      if (aliases.exact.has(spec)) return resolveBase(aliases.exact.get(spec).replace(/\.(tsx?|jsx?)$/, ""));
      for (const [p, target] of aliases.prefix) if (spec.startsWith(p)) return resolveBase(target + spec.slice(p.length));
      return null; // external package
    };

    log(`reading ${src.length} files`);
    const files = await Promise.all(src.map(async (f) => {
      const text = await fs.readFile(path.join(dir, f), "utf8").catch(() => "");
      const imports = new Set();
      for (const m of text.matchAll(reImport)) {
        const r = resolveSpec(f, m[1] ?? m[2] ?? m[3] ?? m[4]);
        if (r && r !== f) imports.add(r);
      }
      return {
        path: f,
        loc: text.split("\n").length,
        churn: churn.get(f) ?? 0,
        exports: [...new Set([...text.matchAll(reExport)].map((m) => m[1]))].slice(0, 15),
        doc: headerDoc(text),
        imports: [...imports],
      };
    }));

    const city = layoutCity(files);
    return {
      repo: `${owner}/${repo}`, slug, sha, generatedAt: new Date().toISOString(),
      stats: {
        files: files.length, loc: files.reduce((a, f) => a + f.loc, 0), testFilesExcluded: testCount, truncated,
        edges: files.reduce((a, f) => a + f.imports.length, 0),
      },
      ...city,
    };
  } finally {
    fs.rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

// Compact per-file manifest for the LLM. Metrics included so it can answer code-health questions.
export function buildManifest(city) {
  return city.buildings
    .map((b) => `${b.path} | loc ${b.loc} | churn ${b.churn}${b.exports.length ? ` | exports ${b.exports.join(",")}` : ""}${b.doc ? ` | ${b.doc}` : ""}`)
    .join("\n");
}

export const cityPath = (dirName, slug) => path.join(dirName, `${slug}.json`);
export const exists = existsSync;
