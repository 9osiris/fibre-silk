// tests for git.ts. run with: npx tsx --test git.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedFiles, gitDiff, gitDiffStat, gitStatus, isGitRepo } from "./git.js";

function git(dir: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], {
    cwd: dir,
    encoding: "utf8",
  });
}

function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "silk-git-"));
  git(dir, "init", "-q");
  return dir;
}

test("isGitRepo detects repos", async () => {
  const dir = freshRepo();
  assert.equal(await isGitRepo(dir), true);
  const plain = mkdtempSync(join(tmpdir(), "silk-plain-"));
  assert.equal(await isGitRepo(plain), false);
});

test("gitStatus reports clean and dirty", async () => {
  const dir = freshRepo();
  writeFileSync(join(dir, "a.txt"), "one");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-qm", "init");
  assert.equal((await gitStatus(dir)).clean, true);
  writeFileSync(join(dir, "a.txt"), "two");
  const s = await gitStatus(dir);
  assert.equal(s.clean, false);
  assert.ok(s.files.some((f) => f.includes("a.txt")));
});

test("gitDiff and gitDiffStat show modifications", async () => {
  const dir = freshRepo();
  writeFileSync(join(dir, "a.txt"), "one\n");
  git(dir, "add", "a.txt");
  git(dir, "commit", "-qm", "init");
  writeFileSync(join(dir, "a.txt"), "two\n");
  const diff = await gitDiff(dir);
  assert.ok(diff.includes("two"));
  const stat = await gitDiffStat(dir);
  assert.ok(stat.includes("a.txt"));
});

test("changedFiles diffs two snapshots", () => {
  const r = changedFiles(["a", "b", "c"], ["b", "c", "d"]);
  assert.deepEqual(r.created, ["d"]);
  assert.deepEqual(r.deleted, ["a"]);
  assert.deepEqual(r.modified, ["b", "c"]);
});

test("changedFiles with empty snapshots", () => {
  assert.deepEqual(changedFiles([], []), { created: [], modified: [], deleted: [] });
});
