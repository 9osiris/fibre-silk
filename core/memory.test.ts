// tests for the persistent memory service. run with: npx tsx --test memory.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { FibreStore, type TaskRecord } from "./store.js";
import { MemoryService, looksSecret, memoryContextBlock } from "./memory.js";

async function withService(fn: (svc: MemoryService) => Promise<void> | void): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fibre-memory-"));
  const store = await FibreStore.open(dir);
  try {
    await fn(new MemoryService(store));
  } finally {
    store.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function taskRecord(over: Partial<TaskRecord>): TaskRecord {
  return {
    id: "task-test-1",
    sessionId: null,
    workspaceId: "ws-1",
    goal: "fix the login bug",
    status: "completed",
    stage: "complete",
    plan: null,
    model: null,
    filesChanged: { created: [], modified: ["src/auth.ts"], deleted: [] },
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    finishedAt: Date.now(),
    ...over,
  };
}

test("remember then get returns the record", async () => {
  await withService((svc) => {
    const rec = svc.remember({
      workspaceId: "ws-1",
      category: "project_fact",
      content: "the project uses typescript",
      provenance: "repo_observed",
    });
    assert.equal(rec.category, "project_fact");
    assert.equal(rec.provenance, "repo_observed");
    const back = svc.get(rec.id);
    assert.equal(back?.content, "the project uses typescript");
    assert.equal(back?.workspaceId, "ws-1");
  });
});

test("remember refuses secret-shaped content", async () => {
  await withService((svc) => {
    const bad = [
      "openai key sk-abcdefghijklmnopqrstuvwxyz0123456789",
      "github token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "aws key AKIAIOSFODNN7EXAMPLE in the deploy script",
      "api_key = hunter2",
      "password: correcthorsebatterystaple",
      "authorization: bearer abcdef0123456789abcdef",
      "-----BEGIN RSA PRIVATE KEY-----",
      "checksum 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 done",
    ];
    for (const content of bad) {
      assert.throws(
        () => svc.remember({ category: "project_fact", content, provenance: "user_statement" }),
        /looks like a secret/
      );
    }
    assert.equal(svc.list().length, 0);
  });
});

test("looksSecret leaves normal facts alone", () => {
  assert.equal(looksSecret("the test command is npm test"), false);
  assert.equal(looksSecret("short hex abc123 is fine"), false);
  assert.equal(looksSecret("sk-abcdefghijklmnopqrstuvwxyz"), true);
});

test("search ranks relevant above irrelevant", async () => {
  await withService((svc) => {
    svc.remember({ category: "project_fact", content: "postgres connection pooling uses pgbouncer", provenance: "repo_observed", importance: 0.5 });
    svc.remember({ category: "convention", content: "commit messages are lowercase", provenance: "user_statement", importance: 0.9 });
    const hits = svc.search("postgres pooling");
    assert.equal(hits.length, 1);
    assert.ok(hits[0].content.includes("postgres"));
  });
});

test("search scopes to the current workspace plus global", async () => {
  await withService((svc) => {
    svc.remember({ workspaceId: "ws-1", category: "project_fact", content: "redis cache ttl is 60 seconds", provenance: "repo_observed" });
    svc.remember({ workspaceId: "ws-2", category: "project_fact", content: "redis cache ttl is 5 seconds", provenance: "repo_observed" });
    svc.remember({ workspaceId: null, category: "project_fact", content: "redis cache is optional", provenance: "user_statement" });
    const hits = svc.search("redis cache ttl", { workspaceId: "ws-1" });
    assert.equal(hits.length, 2);
    assert.ok(hits.every((h) => h.workspaceId !== "ws-2"));
  });
});

test("search excludes superseded records", async () => {
  await withService((svc) => {
    const old = svc.remember({ category: "project_fact", content: "the api runs on port 3000", provenance: "repo_observed" });
    const next = svc.supersede(old.id, "the api runs on port 8080");
    assert.ok(next);
    const hits = svc.search("api port");
    assert.equal(hits.length, 1);
    assert.equal(hits[0].content, "the api runs on port 8080");
    // includeSuperseded surfaces both for inspection
    const all = svc.search("api port", { includeSuperseded: true });
    assert.equal(all.length, 2);
  });
});

test("search excludes expired records", async () => {
  await withService((svc) => {
    svc.remember({ category: "known_issue", content: "flaky ci on fridays", provenance: "repo_observed", expiresAt: Date.now() - 1000 });
    svc.remember({ category: "known_issue", content: "flaky ci on windows runners", provenance: "repo_observed", expiresAt: Date.now() + 60000 });
    const hits = svc.search("flaky ci");
    assert.equal(hits.length, 1);
    assert.ok(hits[0].content.includes("windows"));
  });
});

test("search respects the character budget and limit", async () => {
  await withService((svc) => {
    for (let i = 0; i < 10; i++) {
      svc.remember({ category: "project_fact", content: "cache layer note " + i + " " + "padding words here ".repeat(8).trim(), provenance: "repo_observed" });
    }
    const hits = svc.search("cache layer note", { budgetChars: 400 });
    assert.ok(hits.length >= 1);
    const rendered = hits.reduce((s, r) => s + r.content.length + 48, 0);
    assert.ok(rendered <= 400, "budget exceeded: " + rendered);
    const limited = svc.search("cache layer note", { limit: 3 });
    assert.equal(limited.length, 3);
  });
});

test("memoriesFromTask records observed and verified facts only", async () => {
  await withService((svc) => {
    const made = svc.memoriesFromTask(taskRecord({}), {
      languages: ["typescript"],
      testCommand: "npm test",
      buildCommand: "npm run build",
      verificationOk: true,
    });
    const byContent = new Map(made.map((m) => [m.content, m]));
    assert.equal(byContent.get("project languages: typescript")?.provenance, "repo_observed");
    assert.equal(byContent.get("build command: npm run build")?.provenance, "repo_observed");
    const testMem = byContent.get("test command: npm test");
    assert.equal(testMem?.provenance, "test_verified");
    assert.ok(made.every((m) => m.provenance === "repo_observed" || m.provenance === "test_verified"));
    assert.ok(made.every((m) => m.category !== "user_preference"));
    // running it again does not duplicate facts
    const again = svc.memoriesFromTask(taskRecord({}), {
      languages: ["typescript"],
      testCommand: "npm test",
      buildCommand: "npm run build",
      verificationOk: true,
    });
    assert.equal(again.length, 0);
  });
});

test("memoriesFromTask without verification keeps test command repo_observed", async () => {
  await withService((svc) => {
    const made = svc.memoriesFromTask(taskRecord({}), {
      languages: [],
      testCommand: "npm test",
      verificationOk: false,
    });
    const testMem = made.find((m) => m.content === "test command: npm test");
    assert.equal(testMem?.provenance, "repo_observed");
  });
});

test("memoriesFromTask records failures as known issues", async () => {
  await withService((svc) => {
    const made = svc.memoriesFromTask(
      taskRecord({ status: "failed", error: "tsc failed in src/auth.ts" }),
      { languages: [], verificationOk: false }
    );
    const issue = made.find((m) => m.category === "known_issue");
    assert.ok(issue);
    assert.ok(issue.content.includes("task failed"));
  });
});

test("export and import round trip, duplicates skipped", async () => {
  await withService(async (svc) => {
    svc.remember({ workspaceId: "ws-1", category: "convention", content: "comments are lowercase one-liners", provenance: "user_statement" });
    svc.remember({ workspaceId: null, category: "user_preference", content: "prefers terse status reports", provenance: "user_statement" });
    const text = svc.exportJson();
    const parsed = JSON.parse(text);
    assert.equal(parsed.memories.length, 2);
    // import into the same service: everything is a duplicate
    const res = svc.importJson(text);
    assert.deepEqual(res, { imported: 0, skipped: 2 });
    // a fresh store imports both
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fibre-memory-"));
    const store2 = await FibreStore.open(dir);
    try {
      const svc2 = new MemoryService(store2);
      const res2 = svc2.importJson(text);
      assert.deepEqual(res2, { imported: 2, skipped: 0 });
      assert.equal(svc2.list().length, 2);
    } finally {
      store2.close();
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

test("import skips secret-shaped entries", async () => {
  await withService((svc) => {
    const text = JSON.stringify({
      format: "fibre-memory-export",
      version: 1,
      memories: [
        { workspaceId: null, category: "project_fact", content: "api_key = hunter2", provenance: "user_statement" },
        { workspaceId: null, category: "project_fact", content: "the ui is react", provenance: "repo_observed" },
      ],
    });
    const res = svc.importJson(text);
    assert.deepEqual(res, { imported: 1, skipped: 1 });
    assert.equal(svc.list().length, 1);
  });
});

test("update, supersede and remove delegate to the store", async () => {
  await withService((svc) => {
    const rec = svc.remember({ category: "project_fact", content: "build takes 40 seconds", provenance: "repo_observed" });
    const updated = svc.update(rec.id, { importance: 0.9 });
    assert.equal(updated?.importance, 0.9);
    assert.throws(() => svc.update(rec.id, { content: "api_key = hunter2" }), /looks like a secret/);
    svc.remove(rec.id);
    assert.equal(svc.get(rec.id), null);
  });
});

test("memoryContextBlock renders compact lines and truncates", () => {
  const base = {
    workspaceId: null,
    confidence: 0.8,
    importance: 0.5,
    supersededBy: null,
    source: "",
    createdAt: 0,
    updatedAt: 0,
    expiresAt: null,
  };
  const records = [
    { ...base, id: "1", category: "project_fact" as const, content: "the api is express", provenance: "repo_observed" as const },
    { ...base, id: "2", category: "convention" as const, content: "tests live under tests/", provenance: "user_statement" as const },
  ];
  const block = memoryContextBlock(records);
  assert.equal(
    block,
    "- [project_fact] the api is express (repo_observed)\n- [convention] tests live under tests/ (user_statement)"
  );
  const cut = memoryContextBlock(records, 40);
  assert.ok(cut.length <= 40);
  assert.equal(memoryContextBlock([]), "");
});
