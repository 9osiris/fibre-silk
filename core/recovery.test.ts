// tests for crash recovery. run with: npx tsx --test recovery.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { FibreStore } from "./store.js";
import {
  reconcileInterrupted,
  buildRecoveryReport,
  recoveryDecision,
  markResuming,
  abandonTask,
  restartTask,
} from "./recovery.js";

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "fibre-recovery-"));
}

test("startup reconciliation marks active tasks interrupted, never completed", async () => {
  const dir = await tmpDir();
  try {
    const s = await FibreStore.open(dir);
    const t1 = s.createTask({ goal: "a" });
    s.updateTask(t1.id, { status: "executing", stage: "implement" });
    const t2 = s.createTask({ goal: "b" });
    s.updateTask(t2.id, { status: "completed", finishedAt: Date.now() });
    const t3 = s.createTask({ goal: "c" });
    s.updateTask(t3.id, { status: "waiting_for_user" });

    const interrupted = reconcileInterrupted(s);
    assert.equal(interrupted.length, 2);
    assert.equal(s.getTask(t1.id)?.status, "interrupted");
    assert.equal(s.getTask(t2.id)?.status, "completed");
    assert.equal(s.getTask(t3.id)?.status, "interrupted");
    s.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("recovery report finds uncertain ops and pending approvals", async () => {
  const dir = await tmpDir();
  try {
    const s = await FibreStore.open(dir);
    const t = s.createTask({ goal: "g" });
    s.updateTask(t.id, { status: "interrupted" });
    // one finished op, one started-but-never-finished op
    s.appendEvent(t.id, "agent.tool_started", { callId: "c1", tool: "fs_read" });
    s.appendEvent(t.id, "agent.tool_completed", { callId: "c1", tool: "fs_read", ok: true, ms: 5 });
    s.appendEvent(t.id, "agent.tool_started", { callId: "c2", tool: "exec" });
    s.createApproval({
      taskId: t.id, callId: "c3", tool: "fs_write", level: "write",
      summary: "write file", args: { path: "x.ts" },
    });
    const report = await buildRecoveryReport(s, t.id);
    assert.ok(report);
    assert.equal(report!.completedOps, 1);
    assert.equal(report!.uncertainOps.length, 1);
    assert.equal(report!.uncertainOps[0].tool, "exec");
    assert.equal(report!.pendingApprovals.length, 1);
    assert.equal(report!.pendingApprovals[0].tool, "fs_write");
    s.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("recovery decision requires a checkpoint", async () => {
  const dir = await tmpDir();
  try {
    const s = await FibreStore.open(dir);
    const t = s.createTask({ goal: "g" });
    s.updateTask(t.id, { status: "interrupted" });
    const noCp = await buildRecoveryReport(s, t.id);
    const d1 = recoveryDecision(noCp!);
    assert.equal(d1.canResume, false);

    s.saveCheckpoint(t.id, "implement", { stage: "implement" });
    const withCp = await buildRecoveryReport(s, t.id);
    const d2 = recoveryDecision(withCp!);
    assert.equal(d2.canResume, true);
    assert.equal(d2.resumeStage, "implement");
    s.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("resume, abandon, restart transitions", async () => {
  const dir = await tmpDir();
  try {
    const s = await FibreStore.open(dir);
    const t = s.createTask({ goal: "g" });
    s.updateTask(t.id, { status: "interrupted" });

    const resumed = markResuming(s, t.id);
    assert.equal(resumed?.status, "recovering");

    // recovering can be abandoned via status juggling: reset first
    s.updateTask(t.id, { status: "interrupted" });
    const abandoned = abandonTask(s, t.id);
    assert.equal(abandoned?.status, "cancelled");
    assert.ok(abandoned?.finishedAt);

    const t2 = s.createTask({ goal: "h" });
    s.updateTask(t2.id, { status: "interrupted" });
    const restarted = restartTask(s, t2.id);
    assert.equal(restarted?.status, "queued");
    assert.equal(restarted?.plan, null);
    s.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("interrupted state survives a store reopen", async () => {
  const dir = await tmpDir();
  try {
    const s1 = await FibreStore.open(dir);
    const t = s1.createTask({ goal: "persist me" });
    s1.updateTask(t.id, { status: "executing", stage: "test" });
    s1.saveCheckpoint(t.id, "test", { stage: "test" });
    s1.flush();
    s1.close();

    // simulate a fresh process: unfinished work is found, not lost
    const s2 = await FibreStore.open(dir);
    const found = s2.listUnfinishedTasks();
    assert.equal(found.length, 1);
    assert.equal(found[0].goal, "persist me");
    const report = await buildRecoveryReport(s2, t.id);
    assert.equal(report?.checkpoint?.stage, "test");
    s2.close();
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
