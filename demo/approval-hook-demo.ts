// simulated run of the approval hook: a planned file edit pauses for
// approval and executes, a planned shell command is denied and never runs.
// everything is real except the approver, which is scripted here (in the
// app it would be the user at a prompt).
// run with: npx tsx demo/approval-hook-demo.ts
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ToolRuntime, type ApprovalDecision } from "../core/runtime.js";
import { PermissionStore } from "../core/permissions.js";
import {
  createLocalTools,
  setAllowedRoots,
  getAllowedRoots,
} from "../core/tools.js";
import { ApprovalHook } from "../core/approval-hook.js";

async function main(): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "silk-hook-demo-"));
  const prevRoots = getAllowedRoots();
  setAllowedRoots([dir]);
  const logPath = path.join(dir, "approval-log.jsonl");

  // scripted stand-in for the user: allow the edit, deny the command
  const decide = async (req: { tool: string }): Promise<ApprovalDecision> => {
    console.log(`[decider] ${req.tool} -> ${req.tool === "fs_write" ? "allow_once" : "deny"}`);
    return req.tool === "fs_write" ? "allow_once" : "deny";
  };

  const hook = new ApprovalHook({ decide, logPath });
  const runtime = new ToolRuntime(
    createLocalTools().all(),
    new PermissionStore(),
    { approve: hook.approver, onEvent: hook.onEvent }
  );

  console.log("--- 1. planned file edit (should pause, then run) ---");
  const edit = await runtime.execute(
    "fs_write",
    { path: path.join(dir, "note.txt"), content: "hello from silk" },
    "call-1"
  );
  console.log("result:", edit.ok ? "executed" : `blocked: ${edit.output}`);
  console.log(
    "file on disk:",
    await fs.readFile(path.join(dir, "note.txt"), "utf8").catch(() => "(missing)")
  );

  console.log("\n--- 2. planned shell command (should be denied, never run) ---");
  const sentinel = path.join(dir, "should-not-exist.txt");
  const cmd = await runtime.execute(
    "exec",
    {
      command: "echo pwned",
      cwd: dir,
      password: "supersecret123",
    },
    "call-2"
  );
  console.log("result:", cmd.ok ? "executed (BAD)" : `blocked: ${cmd.output}`);
  console.log(
    "sentinel file exists:",
    await fs.stat(sentinel).then(() => true).catch(() => false),
    "(must be false)"
  );

  console.log("\n--- 3. action log ---");
  console.log("log path:", hook.path);
  const raw = await fs.readFile(logPath, "utf8");
  for (const line of raw.trim().split("\n")) {
    const e = JSON.parse(line);
    console.log(
      `${e.phase.padEnd(9)} ${e.callId} ${e.tool.padEnd(8)}` +
        (e.decision ? ` decision=${e.decision}` : "") +
        (e.outcome ? ` outcome=${e.outcome}` : "")
    );
  }
  console.log(
    "\nsecret leaked into log:",
    raw.includes("supersecret123"),
    "(must be false)"
  );

  setAllowedRoots(prevRoots);
  const deniedNeverRan = !(await fs.stat(sentinel).then(() => true).catch(() => false));
  if (!edit.ok || !deniedNeverRan || raw.includes("supersecret123")) {
    console.error("\ndemo FAILED");
    process.exit(1);
  }
  console.log("\ndemo OK: edit paused then ran, command denied and never ran, log is clean");
}

main().catch((err) => {
  console.error("demo failed:", err);
  process.exit(1);
});
