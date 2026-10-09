// persistent workspace index: bounded metadata scan, diff, related files.
// metadata only (path, mtime, size, language by extension). never reads
// file contents, never follows links outside the workspace root.

import { readdir, readFile, realpath, stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { analyzeWorkspace, describeWorkspace } from "./workspace.js";
import type { WorkspaceInfo } from "./workspace.js";
import type { FibreStore, WorkspaceRecord } from "./store.js";

export interface IndexedFile {
  path: string;
  mtime: number;
  size: number;
  lang: string;
}

export interface WorkspaceIndex {
  version: 1;
  root: string;
  scannedAt: number;
  files: IndexedFile[];
  tests: string[];
  entryPoints: string[];
  truncated: boolean;
}

export interface IndexDiff {
  created: string[];
  modified: string[];
  deleted: string[];
  renamed: Array<{ from: string; to: string }>;
}

const SKIP_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "out", ".next", "coverage",
]);

const DEFAULT_MAX_FILES = 5000;

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  py: "python", go: "go", rs: "rust", java: "java",
  c: "c", h: "c", cpp: "c++", cc: "c++", cxx: "c++", hpp: "c++",
  cs: "c#", rb: "ruby", php: "php",
  md: "markdown", markdown: "markdown",
  json: "json", jsonc: "json",
  html: "html", css: "css", scss: "css",
  yml: "yaml", yaml: "yaml", toml: "toml",
  sh: "shell", ps1: "powershell",
};

function langFor(name: string): string {
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "unknown";
  return EXT_LANG[name.slice(dot + 1).toLowerCase()] ?? "unknown";
}

// --- gitignore matching: root file only, common cases ---

interface IgnoreRule {
  negated: boolean;
  dirOnly: boolean;
  floating: boolean; // no slash: matches any basename, else root-anchored
  regex: RegExp;
}

function globToRegex(glob: string): RegExp {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        i++;
        if (glob[i + 1] === "/") {
          i++;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else if ("+|.^${}()[]\\".includes(ch)) {
      out += "\\" + ch;
    } else {
      out += ch;
    }
  }
  return new RegExp("^" + out + "$");
}

function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];
  for (const raw of text.split(/\r?\n/)) {
    let line = raw.replace(/\s+$/, "");
    if (!line || line.startsWith("#")) continue;
    let negated = false;
    if (line.startsWith("!")) {
      negated = true;
      line = line.slice(1);
    }
    let dirOnly = false;
    if (line.endsWith("/")) {
      dirOnly = true;
      line = line.slice(0, -1);
    }
    let anchored = false;
    if (line.startsWith("/")) {
      anchored = true;
      line = line.slice(1);
    } else if (line.includes("/")) {
      anchored = true;
    }
    if (!line) continue;
    rules.push({ negated, dirOnly, floating: !anchored, regex: globToRegex(line) });
  }
  return rules;
}

// last matching rule wins, like git
function gitignored(rules: IgnoreRule[], rel: string, isDir: boolean): boolean {
  let ignored = false;
  const base = rel.split("/").pop()!;
  for (const r of rules) {
    if (r.dirOnly && !isDir) continue;
    const hit = r.floating ? r.regex.test(base) : r.regex.test(rel);
    if (hit) ignored = !r.negated;
  }
  return ignored;
}

function isTestFile(rel: string): boolean {
  const segs = rel.split("/");
  const base = segs[segs.length - 1];
  if (segs.slice(0, -1).some((s) => ["test", "tests", "__tests__", "spec", "specs"].includes(s))) return true;
  if (/\.(test|spec)\.[^.]+$/.test(base)) return true;
  if (/^test_.*\.py$/.test(base)) return true;
  if (/_test\.(go|py)$/.test(base)) return true;
  return false;
}

// real-path containment: candidate must be the root or live under it
function insideRoot(real: string, rootReal: string): boolean {
  const norm = (s: string) => (process.platform === "win32" ? s.toLowerCase() : s);
  const r = norm(rootReal);
  const t = norm(real);
  return t === r || t.startsWith(r + sep);
}

interface WalkState {
  truncated: boolean;
}

async function walkIndex(
  dir: string,
  rootReal: string,
  rules: IgnoreRule[],
  maxFiles: number,
  out: IndexedFile[],
  state: WalkState
): Promise<void> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return; // unreadable dir, skip silently
  }
  for (const e of entries) {
    if (out.length >= maxFiles) {
      state.truncated = true;
      return;
    }
    const p = join(dir, e.name);
    const rel = p.slice(rootReal.length + 1).split(sep).join("/");
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name)) continue;
      if (gitignored(rules, rel, true)) continue;
      // never descend into a linked dir that resolves outside the root
      let real: string;
      try {
        real = await realpath(p);
      } catch {
        continue;
      }
      if (!insideRoot(real, rootReal)) continue;
      await walkIndex(p, rootReal, rules, maxFiles, out, state);
    } else if (e.isFile()) {
      if (e.name.startsWith(".env")) continue; // never index secret files
      if (gitignored(rules, rel, false)) continue;
      try {
        const st = await stat(p);
        out.push({ path: rel, mtime: Math.round(st.mtimeMs), size: st.size, lang: langFor(e.name) });
      } catch {
        // vanished mid-scan, skip
      }
    } else if (e.isSymbolicLink()) {
      // linked files: index only when the target stays inside the root.
      // linked dirs are never descended into.
      try {
        const real = await realpath(p);
        if (!insideRoot(real, rootReal)) continue;
        const st = await stat(p);
        if (!st.isFile()) continue;
        if (gitignored(rules, rel, false)) continue;
        out.push({ path: rel, mtime: Math.round(st.mtimeMs), size: st.size, lang: langFor(e.name) });
      } catch {
        // dangling link, skip
      }
    }
  }
}

const ENTRY_CANDIDATES = [
  "index.html",
  "src/main.ts", "src/main.tsx", "src/main.js", "src/main.jsx",
  "src/index.ts", "src/index.tsx", "src/index.js", "src/index.jsx",
  "main.ts", "main.js", "main.py", "main.go",
];

// build a fresh metadata index for a workspace dir
export async function buildIndex(dir: string, opts: { maxFiles?: number } = {}): Promise<WorkspaceIndex> {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  let root: string;
  try {
    root = await realpath(resolve(dir));
  } catch {
    throw new Error(`indexer: cannot read workspace dir ${dir}`);
  }
  let rules: IgnoreRule[] = [];
  try {
    rules = parseGitignore(await readFile(join(root, ".gitignore"), "utf8"));
  } catch {
    rules = [];
  }
  const files: IndexedFile[] = [];
  const state: WalkState = { truncated: false };
  await walkIndex(root, root, rules, maxFiles, files, state);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const present = new Set(files.map((f) => f.path));
  const entryPoints: string[] = [];
  // package.json main counts when the file actually exists in the index
  try {
    const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
    if (typeof pkg?.main === "string") {
      const main = pkg.main.replace(/^\.\//, "").replace(/\\/g, "/");
      if (present.has(main)) entryPoints.push(main);
    }
  } catch {
    // no package.json, candidates below still apply
  }
  for (const c of ENTRY_CANDIDATES) {
    if (present.has(c) && !entryPoints.includes(c)) entryPoints.push(c);
  }

  return {
    version: 1,
    root,
    scannedAt: Date.now(),
    files,
    tests: files.filter((f) => isTestFile(f.path)).map((f) => f.path),
    entryPoints,
    truncated: state.truncated,
  };
}

// compare two indexes. rename detection is best effort: a deleted and a
// created file with identical size are paired (mtime is preserved by
// rename, size equality is the cheapest honest signal we have).
export function diffIndex(prev: WorkspaceIndex, next: WorkspaceIndex): IndexDiff {
  const prevMap = new Map(prev.files.map((f) => [f.path, f]));
  const nextMap = new Map(next.files.map((f) => [f.path, f]));
  const created: string[] = [];
  const deleted: string[] = [];
  const modified: string[] = [];
  for (const f of next.files) {
    const before = prevMap.get(f.path);
    if (!before) created.push(f.path);
    else if (before.mtime !== f.mtime || before.size !== f.size) modified.push(f.path);
  }
  for (const f of prev.files) {
    if (!nextMap.has(f.path)) deleted.push(f.path);
  }
  const renamed: Array<{ from: string; to: string }> = [];
  const createdBySize = new Map<number, string[]>();
  for (const c of created) {
    const size = nextMap.get(c)!.size;
    const bucket = createdBySize.get(size) ?? [];
    bucket.push(c);
    createdBySize.set(size, bucket);
  }
  const keptCreated = new Set(created);
  const keptDeleted: string[] = [];
  for (const d of deleted) {
    const match = createdBySize.get(prevMap.get(d)!.size)?.shift();
    if (match) {
      renamed.push({ from: d, to: match });
      keptCreated.delete(match);
    } else {
      keptDeleted.push(d);
    }
  }
  renamed.sort((a, b) => (a.from < b.from ? -1 : 1));
  return {
    created: [...keptCreated].sort(),
    modified: modified.sort(),
    deleted: keptDeleted.sort(),
    renamed,
  };
}

function isWorkspaceIndex(v: unknown): v is WorkspaceIndex {
  return (
    typeof v === "object" && v !== null &&
    (v as WorkspaceIndex).version === 1 &&
    Array.isArray((v as WorkspaceIndex).files)
  );
}

// analyze + index + diff against the stored index, then persist.
// first sync has no stored index and returns diff null.
export async function syncWorkspace(
  store: FibreStore,
  dir: string
): Promise<{ workspace: WorkspaceRecord; index: WorkspaceIndex; diff: IndexDiff | null }> {
  const root = await realpath(resolve(dir));
  const existing = store.getWorkspaceByPath(root);
  const prevIndex = existing && isWorkspaceIndex(existing.index) ? existing.index : null;
  const info = await analyzeWorkspace(root);
  const index = await buildIndex(root);
  const diff = prevIndex ? diffIndex(prevIndex, index) : null;
  const workspace = store.upsertWorkspace({
    rootPath: root,
    displayName: root.split(/[\\/]/).pop() ?? root,
    info: info as unknown as Record<string, unknown>,
    index: index as unknown as Record<string, unknown>,
    lastScan: index.scannedAt,
  });
  return { workspace, index, diff };
}

function tokensOf(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

// navigation aid: rank indexed files by path-token overlap with the
// query. these are candidates to inspect, not proof of relevance.
export function relatedFiles(index: WorkspaceIndex, query: string, limit = 10): string[] {
  const q = tokensOf(query);
  if (q.length === 0) return [];
  const scored: Array<{ path: string; score: number }> = [];
  for (const f of index.files) {
    const parts = tokensOf(f.path);
    let score = 0;
    for (const token of q) {
      let best = 0;
      for (const part of parts) {
        if (part === token) best = Math.max(best, 2);
        else if (part.includes(token) || token.includes(part)) best = Math.max(best, 1);
      }
      score += best;
    }
    if (score > 0) scored.push({ path: f.path, score });
  }
  scored.sort((a, b) =>
    b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1)
  );
  return scored.slice(0, limit).map((s) => s.path);
}

// compact human block combining the analyzer description and the index
export function indexSummaryBlock(index: WorkspaceIndex, info: WorkspaceInfo): string {
  const counts = new Map<string, number>();
  for (const f of index.files) counts.set(f.lang, (counts.get(f.lang) ?? 0) + 1);
  const topLangs = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, 5)
    .map(([lang, n]) => `${lang}(${n})`)
    .join(", ");
  const lines = [
    "workspace: " + index.root,
    describeWorkspace(info),
    "files: " + index.files.length + (index.truncated ? " (index truncated)" : ""),
    "languages: " + (topLangs || "none"),
    "tests indexed: " + index.tests.length,
  ];
  if (info.entryPoints.length === 0 && index.entryPoints.length > 0) {
    lines.push("entry: " + index.entryPoints.join(", "));
  }
  lines.push("last scan: " + new Date(index.scannedAt).toISOString());
  return lines.join("\n");
}
