// tests for the approval hook: pre-action gate plus action log.
// run with: npx tsx --test approval-hook.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs, readFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolRuntime, type ApprovalDecision } from "./runtime.js";
import { PermissionStore } from "./permissions.js";
import {
  createLocalTools,
  setAllowedRoots,
  getAllowedRoots,
} from "./tools.js";
import { ApprovalHook, redactValue, type LogEntry } from "./approval-hook.js";

async function mkSandbox(): Promise<{
  dir: string;
  prevRoots: string[];
  logPath: string;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "silk-hook-"));
  const prevRoots = getAllowedRoots();
  setAllowedRoots([dir]);
  return { dir, prevRoots, logPath: path.join(dir, "approval-log.jsonl") };
}

function readLog(logPath: string): LogEntry[] {
  let raw: string;
  try {
    raw = readFileSync(logPath, "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((l: string) => l.trim())
    .map((l: string) => JSON.parse(l) as LogEntry);
}

// scripted decider: allow the file edit once, deny the shell command
const decider = async (req: {
  tool: string;
}): Promise<ApprovalDecision> =>
  req.tool === "fs_write" ? "allow_once" : "deny";

test("allowed file edit pauses for approval, then executes", async () => {
  const { dir, prevRoots, logPath } = await mkSandbox();
  try {
    const hook = new ApprovalHook({ decide: decider, logPath });
    const runtime = new ToolRuntime(createLocalTools().all(), new PermissionStore(), {
      approve: hook.approver,
      onEvent: hook.onEvent,
    });
    const target = path.join(dir, "note.txt");
    const res = await runtime.execute(
      "fs_write",
      { path: target, content: "hello" },
      "call-1"
    );
    assert.equal(res.ok, true);
    assert.equal(await fs.readFile(target, "utf8"), "hello");

    const log = readLog(logPath);
    const phases = log.filter((e) => e.callId === "call-1").map((e) => e.phase);
    assert.deepEqual(phases, ["requested", "decided", "outcome", "outcome"]);
    const decided = log.find(
      (e) => e.callId === "call-1" && e.phase === "decided"
    );
    assert.equal(decided?.decision, "allow_once");
    const outcome = log.find(
      (e) => e.callId === "call-1" && e.phase === "outcome" && e.outcome === "executed"
    );
    assert.ok(outcome, "expected an executed outcome entry");
  } finally {
    setAllowedRoots(prevRoots);
  }
});

test("denied shell command never executes", async () => {
  const { dir, prevRoots, logPath } = await mkSandbox();
  try {
    const hook = new ApprovalHook({ decide: decider, logPath });
    const runtime = new ToolRuntime(createLocalTools().all(), new PermissionStore(), {
      approve: hook.approver,
      onEvent: hook.onEvent,
    });
    const sentinel = path.join(dir, "should-not-exist.txt");
    const res = await runtime.execute(
      "exec",
      {
        command: `echo pwned > ${JSON.stringify(sentinel)}`,
        cwd: dir,
        // bait for the redactor: must never land in the log
        password: "supersecret123",
      },
      "call-2"
    );
    assert.equal(res.ok, false);
    assert.match(res.output, /denied by user/);
    await assert.rejects(fs.stat(sentinel), "denied command ran anyway");

    const log = readLog(logPath);
    const decided = log.find(
      (e) => e.callId === "call-2" && e.phase === "decided"
    );
    assert.equal(decided?.decision, "deny");
    const outcome = log.find(
      (e) => e.callId === "call-2" && e.phase === "outcome"
    );
    assert.equal(outcome?.outcome, "denied");
    // the tool never started: no "executing" entry for the denied call
    assert.ok(
      !log.some((e) => e.callId === "call-2" && e.outcome === "executing"),
      "denied action must never reach executing"
    );
    const raw = readFileSync(logPath, "utf8");
    assert.ok(
      !raw.includes("supersecret123"),
      "secret value leaked into the action log"
    );
  } finally {
    setAllowedRoots(prevRoots);
  }
});

test("read-level tools never hit the approval hook", async () => {
  const { dir, prevRoots, logPath } = await mkSandbox();
  try {
    const hook = new ApprovalHook({ decide: decider, logPath });
    const runtime = new ToolRuntime(createLocalTools().all(), new PermissionStore(), {
      approve: hook.approver,
      onEvent: hook.onEvent,
    });
    const res = await runtime.execute("fs_list", { path: dir }, "call-3");
    assert.equal(res.ok, true);
    assert.equal(readLog(logPath).length, 0);
  } finally {
    setAllowedRoots(prevRoots);
  }
});

test("redaction covers nested objects, arrays, and token-shaped values", () => {
  const out = redactValue({
    password: "hunter2",
    nested: { apiKey: "abc", items: ["x", "ghp_0123456789abcdef"] },
    plain: "keep me",
  }) as Record<string, unknown>;
  assert.equal(out["password"], "[redacted]");
  assert.equal((out["nested"] as Record<string, unknown>)["apiKey"], "[redacted]");
  assert.deepEqual(
    (out["nested"] as Record<string, unknown>)["items"],
    ["x", "[redacted]"]
  );
  assert.equal(out["plain"], "keep me");
});
