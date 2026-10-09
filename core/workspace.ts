// workspace analyzer: figures out what kind of project lives in a dir.
// fast bounded walk, caches per dir, invalidated on dir mtime change.

import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

export interface WorkspaceInfo {
  languages: string[];
  frameworks: string[];
  packageManager?: string;
  build?: string;
  testFramework?: string;
  git: boolean;
  entryPoints: string[];
  srcDirs: string[];
  testDirs: string[];
  configFiles: string[];
}

const SKIP = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", "target",
  "venv", ".venv", "__pycache__", ".idea", ".vscode", "coverage",
]);

const EXT_LANG: [RegExp, string][] = [
  [/\.(ts|tsx)$/, "TypeScript"],
  [/\.(js|jsx|mjs|cjs)$/, "JavaScript"],
  [/\.py$/, "Python"],
  [/\.rs$/, "Rust"],
  [/\.go$/, "Go"],
  [/\.java$/, "Java"],
  [/\.cs$/, "C#"],
  [/\.(cpp|cc|cxx|h|hpp)$/, "C++"],
  [/\.rb$/, "Ruby"],
  [/\.php$/, "PHP"],
];

const MAX_FILES = 2000;

async function walk(dir: string, out: string[], depth: number): Promise<void> {
  if (depth > 4 || out.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (out.length >= MAX_FILES) return;
    if (SKIP.has(e.name)) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) {
      await walk(p, out, depth + 1);
    } else if (e.isFile()) {
      out.push(p);
    }
  }
}

async function readJson(path: string): Promise<any | null> {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

function base(p: string): string {
  return p.split(/[\\/]/).pop()!;
}

export async function analyzeWorkspace(dir: string): Promise<WorkspaceInfo> {
  const files: string[] = [];
  await walk(dir, files, 0);
  const names = new Set(files.map(base));
  const rel = (p: string) => p.slice(dir.length + 1).replace(/\\/g, "/");

  const langs = new Set<string>();
  for (const f of files) {
    for (const [re, lang] of EXT_LANG) {
      if (re.test(f)) langs.add(lang);
    }
  }

  const frameworks = new Set<string>();
  let packageManager: string | undefined;
  let build: string | undefined;
  let testFramework: string | undefined;

  const pkg = await readJson(join(dir, "package.json"));
  const deps = { ...(pkg?.dependencies ?? {}), ...(pkg?.devDependencies ?? {}) };
  const has = (d: string) => d in deps;
  if (has("react")) frameworks.add("React");
  if (has("next")) frameworks.add("Next.js");
  if (has("vue")) frameworks.add("Vue");
  if (has("svelte")) frameworks.add("Svelte");
  if (has("express")) frameworks.add("Express");
  if (has("fastify")) frameworks.add("Fastify");
  if (has("electron")) frameworks.add("Electron");
  if (names.has("package-lock.json")) packageManager = "npm";
  else if (names.has("yarn.lock")) packageManager = "yarn";
  else if (names.has("pnpm-lock.yaml")) packageManager = "pnpm";
  else if (names.has("bun.lockb")) packageManager = "bun";
  if (names.has("vite.config.ts") || names.has("vite.config.js")) build = "Vite";
  else if (names.has("next.config.ts") || names.has("next.config.js")) build = "Next.js";
  else if (names.has("webpack.config.js")) build = "webpack";
  else if (names.has("tsconfig.json") && langs.has("TypeScript")) build = "tsc";
  if (has("vitest")) testFramework = "Vitest";
  else if (has("jest")) testFramework = "Jest";
  else if (has("mocha")) testFramework = "Mocha";
  else if (has("playwright")) testFramework = "Playwright";

  if (names.has("pyproject.toml") || names.has("requirements.txt")) {
    testFramework = testFramework ?? "pytest";
  }
  if (names.has("go.mod")) testFramework = testFramework ?? "go test";
  if (names.has("Cargo.toml")) testFramework = testFramework ?? "cargo test";

  const entryPoints: string[] = [];
  if (pkg?.main) entryPoints.push(pkg.main);
  for (const c of ["src/main.ts", "src/main.tsx", "src/index.ts", "src/index.js", "app/page.tsx", "main.py", "src/main.py"]) {
    if (names.has(base(c)) && files.some((f) => rel(f) === c)) entryPoints.push(c);
  }

  const srcDirs: string[] = [];
  const testDirs: string[] = [];
  let top: string[];
  try {
    top = (await readdir(dir)).filter((n) => !SKIP.has(n));
  } catch {
    top = [];
  }
  for (const d of ["src", "lib", "app", "source"]) {
    if (top.includes(d)) srcDirs.push(d + "/");
  }
  for (const d of ["tests", "test", "__tests__", "spec"]) {
    if (top.includes(d)) testDirs.push(d + "/");
  }

  const configFiles = [...names].filter((n) =>
    /config/i.test(n) || ["package.json", "tsconfig.json", "pyproject.toml", "go.mod", "Cargo.toml"].includes(n)
  ).sort();

  let git = false;
  try {
    git = (await stat(join(dir, ".git"))).isDirectory();
  } catch {
    git = false;
  }

  return {
    languages: [...langs].sort(),
    frameworks: [...frameworks].sort(),
    packageManager,
    build,
    testFramework,
    git,
    entryPoints: [...new Set(entryPoints)],
    srcDirs,
    testDirs,
    configFiles,
  };
}

// compact human-readable block for prompts and the ui
export function describeWorkspace(info: WorkspaceInfo): string {
  const lines = [
    "project: " + (info.frameworks.length > 0
      ? info.frameworks.join(" + ") + (info.languages.length ? " (" + info.languages.join(", ") + ")" : "")
      : info.languages.join(", ") || "unknown"),
    "package manager: " + (info.packageManager ?? "n/a"),
    "build: " + (info.build ?? "n/a"),
    "tests: " + (info.testFramework ?? "n/a"),
    "git: " + (info.git ? "yes" : "no"),
  ];
  if (info.srcDirs.length) lines.push("source: " + info.srcDirs.join(", "));
  if (info.testDirs.length) lines.push("test dirs: " + info.testDirs.join(", "));
  if (info.entryPoints.length) lines.push("entry: " + info.entryPoints.join(", "));
  return lines.join("\n");
}

interface CacheEntry { mtimeMs: number; info: WorkspaceInfo }
const cache = new Map<string, CacheEntry>();

// cached analyze; refreshes when the dir mtime moves
export async function analyzeWorkspaceCached(dir: string): Promise<WorkspaceInfo> {
  let mtimeMs = 0;
  try {
    mtimeMs = (await stat(dir)).mtimeMs;
  } catch {
    // dir unreadable, fall through to a fresh analyze
  }
  const hit = cache.get(dir);
  if (hit && hit.mtimeMs === mtimeMs) return hit.info;
  const info = await analyzeWorkspace(dir);
  cache.set(dir, { mtimeMs, info });
  return info;
}
