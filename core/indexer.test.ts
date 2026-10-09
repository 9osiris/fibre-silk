// tests for the workspace indexer. run with: npx tsx --test indexer.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { FibreStore } from "./store.js";
import {
  buildIndex,
  diffIndex,
  indexSummaryBlock,
  relatedFiles,
  syncWorkspace,
} from "./indexer.js";
import { analyzeWorkspace } from "./workspace.js";

async function fixtureProject(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fibre-idx-"));
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.mkdir(path.join(dir, "tests"), { recursive: true });
  await fs.mkdir(path.join(dir, "ignored"), { recursive: true });
  await fs.writeFile(path.join(dir, "package.json"), JSON.stringify({
    name: "fixture", version: "1.0.0", main: "src/average.ts",
  }));
  await fs.writeFile(path.join(dir, "src", "average.ts"), "export const average = (xs: number[]) => xs.length;\n");
  await fs.writeFile(path.join(dir, "src", "util.ts"), "export const id = (x: number) => x;\n");
  await fs.writeFile(path.join(dir, "src", "main.ts"), "import './average.js';\n");
  await fs.writeFile(path.join(dir, "tests", "average.test.ts"), "import { test } from 'node:test';\n");
  await fs.writeFile(path.join(dir, "ignored", "skip.ts"), "export const nope = 1;\n");
  await fs.writeFile(path.join(dir, "debug.log"), "noise\n");
  await fs.writeFile(path.join(dir, ".gitignore"), "ignored/\n*.log\n");
  await fs.writeFile(path.join(dir, "src", "notes.md"), "# notes\n");
  return dir;
}

async function cleanup(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

test("initial index shape", async () => {
  const dir = await fixtureProject();
  try {
    const index = await buildIndex(dir);
    assert.equal(index.version, 1);
    assert.equal(index.root, await fs.realpath(dir));
    assert.equal(index.truncated, false);
    const paths = index.files.map((f) => f.path);
    // sorted, posix separators, metadata only
    assert.deepEqual(paths, [...paths].sort());
    assert.ok(paths.includes("src/average.ts"));
    assert.ok(paths.includes("tests/average.test.ts"));
    assert.ok(paths.includes(".gitignore"));
    for (const p of paths) assert.ok(!p.includes("\\"), p);
    const avg = index.files.find((f) => f.path === "src/average.ts")!;
    assert.equal(avg.lang, "typescript");
    assert.ok(avg.size > 0);
    assert.ok(avg.mtime > 0);
    assert.equal(index.files.find((f) => f.path === "src/notes.md")!.lang, "markdown");
    assert.deepEqual(index.tests, ["tests/average.test.ts"]);
    // package.json main first, then known candidates
    assert.equal(index.entryPoints[0], "src/average.ts");
    assert.ok(index.entryPoints.includes("src/main.ts"));
  } finally {
    await cleanup(dir);
  }
});

test("gitignored dir and globs are excluded", async () => {
  const dir = await fixtureProject();
  try {
    const index = await buildIndex(dir);
    const paths = index.files.map((f) => f.path);
    assert.ok(!paths.some((p) => p.startsWith("ignored/")), paths.join(","));
    assert.ok(!paths.includes("debug.log"));
    assert.ok(paths.includes("src/util.ts"));
  } finally {
    await cleanup(dir);
  }
});

test("second sync diff reports modify, create, delete, rename", async () => {
  const dir = await fixtureProject();
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "fibre-idx-db-"));
  try {
    const store = await FibreStore.open(dbDir);
    const first = await syncWorkspace(store, dir);
    assert.equal(first.diff, null);

    // modify (size change), create, delete, rename (same size content)
    await fs.appendFile(path.join(dir, "src", "util.ts"), "export const more = 1;\n");
    await fs.writeFile(path.join(dir, "src", "fresh.ts"), "export const fresh = true;\n");
    await fs.rm(path.join(dir, "src", "notes.md"));
    await fs.writeFile(path.join(dir, "src", "old.ts"), "export const same = 42;\n");
    const beforeSecond = await syncWorkspace(store, dir);
    assert.ok(beforeSecond.diff);
    await fs.rename(path.join(dir, "src", "old.ts"), path.join(dir, "src", "renamed.ts"));
    const afterRename = await syncWorkspace(store, dir);
    assert.ok(afterRename.diff);
    assert.deepEqual(afterRename.diff.created, []);
    assert.deepEqual(afterRename.diff.deleted, []);
    assert.deepEqual(afterRename.diff.renamed, [{ from: "src/old.ts", to: "src/renamed.ts" }]);

    assert.ok(first.index.files.some((f) => f.path === "src/util.ts"));
    assert.ok(beforeSecond.diff.created.includes("src/fresh.ts"), JSON.stringify(beforeSecond.diff));
    assert.ok(beforeSecond.diff.created.includes("src/old.ts"));
    assert.ok(beforeSecond.diff.modified.includes("src/util.ts"), JSON.stringify(beforeSecond.diff));
    assert.ok(beforeSecond.diff.deleted.includes("src/notes.md"), JSON.stringify(beforeSecond.diff));
    store.close();
  } finally {
    await cleanup(dir);
    await cleanup(dbDir);
  }
});

test("symlinked dir escaping the root is not followed", async () => {
  const dir = await fixtureProject();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "fibre-idx-out-"));
  try {
    await fs.writeFile(path.join(outside, "secret.ts"), "export const secret = 1;\n");
    let linked = false;
    try {
      await fs.symlink(outside, path.join(dir, "escape"), "dir");
      linked = true;
    } catch {
      // no symlink privilege on this platform, nothing to verify
    }
    if (linked) {
      const index = await buildIndex(dir);
      const paths = index.files.map((f) => f.path);
      assert.ok(!paths.some((p) => p.includes("secret")), paths.join(","));
    }
  } finally {
    await cleanup(dir);
    await cleanup(outside);
  }
});

test("large tree caps with truncated flag", async () => {
  const dir = await fixtureProject();
  try {
    const index = await buildIndex(dir, { maxFiles: 3 });
    assert.equal(index.truncated, true);
    assert.equal(index.files.length, 3);
  } finally {
    await cleanup(dir);
  }
});

test("relatedFiles ranks by path token overlap", async () => {
  const dir = await fixtureProject();
  try {
    const index = await buildIndex(dir);
    const top = relatedFiles(index, "average test");
    assert.equal(top[0], "tests/average.test.ts");
    assert.ok(top.includes("src/average.ts"));
    assert.deepEqual(relatedFiles(index, "zzqq nothing matches"), []);
    assert.equal(relatedFiles(index, "average", 1).length, 1);
  } finally {
    await cleanup(dir);
  }
});

test("syncWorkspace persists across store reopen", async () => {
  const dir = await fixtureProject();
  const dbDir = await fs.mkdtemp(path.join(os.tmpdir(), "fibre-idx-db-"));
  try {
    const s1 = await FibreStore.open(dbDir);
    const { workspace, index } = await syncWorkspace(s1, dir);
    assert.ok(workspace.id);
    assert.equal(workspace.rootPath, await fs.realpath(dir));
    assert.equal(workspace.displayName, path.basename(await fs.realpath(dir)));
    assert.equal(workspace.lastScan, index.scannedAt);
    s1.flush();
    s1.close();

    const s2 = await FibreStore.open(dbDir);
    const back = s2.getWorkspaceByPath(await fs.realpath(dir));
    assert.ok(back);
    assert.equal(back.id, workspace.id);
    const stored = back.index as { files?: unknown[] } | null;
    assert.ok(Array.isArray(stored?.files));
    assert.equal(stored!.files!.length, index.files.length);
    // a repeat sync on unchanged files yields an empty diff
    const again = await syncWorkspace(s2, dir);
    assert.deepEqual(again.diff, { created: [], modified: [], deleted: [], renamed: [] });
    s2.close();
  } finally {
    await cleanup(dir);
    await cleanup(dbDir);
  }
});

test("diffIndex pairs renames by identical size", () => {
  const mk = (files: Array<[string, number, number]>) => ({
    version: 1 as const,
    root: "/x",
    scannedAt: 0,
    files: files.map(([p, mtime, size]) => ({ path: p, mtime, size, lang: "typescript" })),
    tests: [],
    entryPoints: [],
    truncated: false,
  });
  const prev = mk([["a.ts", 1, 10], ["gone.ts", 1, 5]]);
  const next = mk([["a.ts", 1, 10], ["b.ts", 1, 5], ["c.ts", 1, 7]]);
  const diff = diffIndex(prev, next);
  assert.deepEqual(diff.renamed, [{ from: "gone.ts", to: "b.ts" }]);
  assert.deepEqual(diff.created, ["c.ts"]);
  assert.deepEqual(diff.deleted, []);
  assert.deepEqual(diff.modified, []);
  const touched = diffIndex(mk([["a.ts", 1, 10]]), mk([["a.ts", 2, 10]]));
  assert.deepEqual(touched.modified, ["a.ts"]);
});

test("indexSummaryBlock includes counts and workspace description", async () => {
  const dir = await fixtureProject();
  try {
    const index = await buildIndex(dir);
    const info = await analyzeWorkspace(dir);
    const block = indexSummaryBlock(index, info);
    assert.ok(block.includes("workspace: " + index.root));
    assert.ok(block.includes("files: " + index.files.length));
    assert.ok(block.includes("typescript("));
    assert.ok(block.includes("tests indexed: 1"));
    assert.ok(block.includes("last scan: "));
  } finally {
    await cleanup(dir);
  }
});
