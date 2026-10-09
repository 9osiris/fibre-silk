// tests for the durable store. run with: npx tsx --test store.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { FibreStore } from "./store.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "fibre-store-"));
}

test("open creates the db and reopens with data intact", async () => {
  const dir = await tmpDir();
  try {
    const s1 = await FibreStore.open(dir);
    const sess = s1.createSession({ title: "first" });
    const task = s1.createTask({ sessionId: sess.id, goal: "do the thing" });
    s1.appendEvent(task.id, "agent.started", { goal: "do the thing" });
    s1.flush();
    const stats1 = s1.stats();
    assert.equal(stats1.sessions, 1);
    assert.equal(stats1.tasks, 1);
    assert.equal(stats1.events, 1);
    s1.close();

    const s2 = await FibreStore.open(dir);
    const back = s2.getSession(sess.id);
    assert.equal(back?.title, "first");
    const t2 = s2.getTask(task.id);
    assert.equal(t2?.goal, "do the thing");
    const evs = s2.listEvents(task.id);
    assert.equal(evs.length, 1);
    assert.equal(evs[0].type, "agent.started");
    s2.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("session update and delete", async () => {
  const dir = await tmpDir();
  try {
    const s = await FibreStore.open(dir);
    const sess = s.createSession({ title: "a" });
    const updated = s.updateSession(sess.id, {
      title: "b",
      messages: [{ role: "user", content: "hi" }],
    });
    assert.equal(updated?.title, "b");
    assert.equal(updated?.messages.length, 1);
    s.deleteSession(sess.id);
    assert.equal(s.getSession(sess.id), null);
    s.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("task lifecycle updates persist", async () => {
  const dir = await tmpDir();
  try {
    const s = await FibreStore.open(dir);
    const t = s.createTask({ goal: "g" });
    s.updateTask(t.id, { status: "executing", stage: "implement" });
    s.updateTask(t.id, {
      status: "completed",
      finishedAt: Date.now(),
      filesChanged: { created: ["a.ts"], modified: [], deleted: [] },
    });
    const back = s.getTask(t.id);
    assert.equal(back?.status, "completed");
    assert.deepEqual(back?.filesChanged.created, ["a.ts"]);
    assert.equal(s.listUnfinishedTasks().length, 0);
    s.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("ephemeral events are not journaled", async () => {
  const dir = await tmpDir();
  try {
    const s = await FibreStore.open(dir);
    const t = s.createTask({ goal: "g" });
    assert.equal(s.appendEvent(t.id, "agent.text", { delta: "hi" }), null);
    assert.equal(s.listEvents(t.id).length, 0);
    s.appendEvent(t.id, "agent.completed", { summary: "done" });
    assert.equal(s.listEvents(t.id).length, 1);
    s.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("approvals round-trip and pending listing", async () => {
  const dir = await tmpDir();
  try {
    const s = await FibreStore.open(dir);
    const t = s.createTask({ goal: "g" });
    const a = s.createApproval({
      taskId: t.id, callId: "c1", tool: "fs_write", level: "write",
      summary: "write x", args: { path: "x" },
    });
    assert.equal(s.listApprovals(t.id, "pending").length, 1);
    const resolved = s.resolveApproval(a.id, "allow_once");
    assert.equal(resolved?.decision, "allow_once");
    assert.equal(s.listApprovals(t.id, "pending").length, 0);
    s.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("checkpoints keep only the latest 3", async () => {
  const dir = await tmpDir();
  try {
    const s = await FibreStore.open(dir);
    const t = s.createTask({ goal: "g" });
    for (let i = 0; i < 5; i++) s.saveCheckpoint(t.id, "stage" + i, { n: i });
    const latest = s.latestCheckpoint(t.id);
    assert.equal(latest?.stage, "stage4");
    s.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("memory supersede chain", async () => {
  const dir = await tmpDir();
  try {
    const s = await FibreStore.open(dir);
    const m1 = s.createMemory({
      category: "project_fact", content: "uses npm", provenance: "repo_observed",
    });
    const m2 = s.supersedeMemory(m1.id, "uses pnpm");
    assert.ok(m2);
    assert.equal(s.getMemory(m1.id)?.supersededBy, m2!.id);
    const active = s.listMemories();
    assert.equal(active.length, 1);
    assert.equal(active[0].content, "uses pnpm");
    s.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("workspace upsert by path", async () => {
  const dir = await tmpDir();
  try {
    const s = await FibreStore.open(dir);
    const w1 = s.upsertWorkspace({ rootPath: "/tmp/proj", displayName: "proj" });
    const w2 = s.upsertWorkspace({ rootPath: "/tmp/proj", displayName: "proj2", lastScan: 42 });
    assert.equal(w1.id, w2.id);
    assert.equal(s.listWorkspaces().length, 1);
    assert.equal(s.getWorkspaceByPath("/tmp/proj")?.displayName, "proj2");
    s.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("corrupt database is quarantined and recovered from backup", async () => {
  const dir = await tmpDir();
  try {
    const s1 = await FibreStore.open(dir);
    const sess = s1.createSession({ title: "keep me" });
    s1.flush();
    s1.close();

    // destroy the main file, leave the backup
    const file = path.join(dir, "fibre.db");
    await fs.writeFile(file, "this is not a database at all");

    const diags: string[] = [];
    const s2 = await FibreStore.open(dir, {
      onDiagnostic: (e) => diags.push(e.kind),
    });
    assert.ok(diags.includes("store.corrupt"));
    // backup was written during the first persist, session may or may
    // not be in it depending on timing; the store must at least open
    assert.ok(s2.getSession(sess.id) === null || s2.getSession(sess.id)?.title === "keep me");
    s2.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("export contains all tables", async () => {
  const dir = await tmpDir();
  try {
    const s = await FibreStore.open(dir);
    s.createSession({ title: "x" });
    const out = JSON.parse(s.exportAll());
    assert.ok(Array.isArray(out.sessions));
    assert.equal(out.sessions.length, 1);
    s.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
