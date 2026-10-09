// phase 3 integration: full lifecycle with a simulated crash.
// create session -> workspace -> coding task -> crash -> recover ->
// resume -> complete -> memory -> reopen. run: npx tsx --test integration.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import { execFileSync } from "node:child_process";
import { FibreStore } from "./store.js";
import { runCodingTask } from "./coding.js";
import { createRegistry, DEFAULT_MODELS } from "./models.js";
import { route } from "./router.js";
import { createLocalTools } from "./tools.js";
import { Agent } from "./agent.js";
import { MemoryService } from "./memory.js";
import { syncWorkspace } from "./indexer.js";
import {
  reconcileInterrupted,
  buildRecoveryReport,
  recoveryDecision,
  markResuming,
} from "./recovery.js";
import type { Provider, ProviderEvent, ChatMessage, ChatOptions } from "./providers.js";
import type { FibreStore as Store } from "./store.js";

// scripted provider: same script the demo uses, keyed by call shape.
// first call may be understand (yes/no), then plan json, then per-stage
// agent turns driven by the wrapped Agent below.
class ScriptedProvider implements Provider {
  id = "scripted";
  turns = new Map<string, unknown>();
  async *chat(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<ProviderEvent> {
    const last = messages[messages.length - 1]?.content ?? "";
    const sys = messages[0]?.role === "system" ? messages[0].content : "";
    if (sys.includes("exactly YES or NO")) {
      yield { type: "text", delta: "YES" };
      return;
    }
    if (last.includes("Break the goal into steps")) {
      yield {
        type: "text",
        delta: JSON.stringify({
          steps: [
            { id: "s1", description: "create the greeting module" },
            { id: "s2", description: "add a test for it" },
          ],
        }),
      };
      return;
    }
    if (last.includes("Review these changes against the goal")) {
      yield { type: "text", delta: JSON.stringify({ status: "approved", findings: [] }) };
      return;
    }
    yield { type: "text", delta: "ok" };
  }
}

function makeCtx(store: Store, dir: string, wsId: string, sessionId: string, extra: Record<string, unknown> = {}) {
  const provider = new ScriptedProvider();
  const registry = createRegistry(DEFAULT_MODELS);
  const tools = createLocalTools({ allowedRoots: [dir] }).all();
  let step = 0;
  return {
    dir,
    getProvider: () => provider,
    router: { route: (req: any) => route(req, registry) },
    onEvent: () => {},
    approve: async () => "allow_once" as const,
    store,
    sessionId,
    workspaceId: wsId,
    createAgent: (p: Provider, model: string) => ({
      run: async (task: string) => {
        step += 1;
        if (task.startsWith("Inspect")) {
          return { text: "relevant: src/", filesChanged: { created: [], modified: [], deleted: [] } };
        }
        if (task.startsWith("Implement")) {
          await fs.writeFile(path.join(dir, "src", "greet.ts"), "export const greet = (n: string) => 'hello ' + n;\n");
          return { text: "implemented", filesChanged: { created: ["src/greet.ts"], modified: [], deleted: [] } };
        }
        return { text: "done", filesChanged: { created: [], modified: [], deleted: [] } };
      },
    }),
    ...extra,
  };
}

async function scratchRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "fibre-int-"));
  await fs.mkdir(path.join(dir, "src"), { recursive: true });
  await fs.writeFile(path.join(dir, "src", "greet.ts"), "export const greet = (n: string) => 'hi ' + n;\n");
  await fs.writeFile(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "scratch", version: "1.0.0", scripts: { test: "node -e \"process.exit(0)\"" } }) + "\n"
  );
  execFileSync("git", ["init", "-q"], { cwd: dir });
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: dir });
  return dir;
}

test("full lifecycle: task, crash, recover, resume, memory, reopen", async () => {
  const repo = await scratchRepo();
  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), "fibre-int-store-"));
  try {
    // phase 1: session + workspace + first run, killed mid-flight by
    // simulating a crash: persist a task in executing state with a
    // checkpoint, then close the store abruptly (no graceful finish).
    const s1 = await FibreStore.open(storeDir);
    const session = s1.createSession({ title: "integration" });
    const { workspace } = await syncWorkspace(s1, repo);
    const task = s1.createTask({ sessionId: session.id, workspaceId: workspace.id, goal: "make greet say hello" });
    s1.updateTask(task.id, { status: "executing", stage: "plan" });
    const plan = {
      goal: "make greet say hello",
      steps: [
        { id: "s1", description: "create the greeting module", status: "completed" as const },
        { id: "s2", description: "add a test for it", status: "pending" as const },
      ],
    };
    s1.updateTask(task.id, { plan });
    s1.saveCheckpoint(task.id, "implement", { stage: "implement", plan, filesChanged: { created: [], modified: [], deleted: [] } });
    s1.appendEvent(task.id, "agent.tool_started", { callId: "ghost", tool: "exec" });
    s1.flush();
    s1.close(); // abrupt: the task record still says executing

    // phase 2: fresh process. the task must surface as interrupted.
    const s2 = await FibreStore.open(storeDir);
    const interrupted = reconcileInterrupted(s2);
    assert.equal(interrupted.length, 1);
    assert.equal(s2.getTask(task.id)?.status, "interrupted");

    const report = await buildRecoveryReport(s2, task.id);
    assert.ok(report);
    assert.equal(report!.uncertainOps.length, 1, "ghost exec op must be uncertain");
    const decision = recoveryDecision(report!);
    assert.equal(decision.canResume, true);
    markResuming(s2, task.id);
    assert.equal(s2.getTask(task.id)?.status, "recovering");

    // phase 3: resume the coding loop from the checkpoint. the agent
    // writes the real file; verification runs the real test script.
    const result = await runCodingTask("make greet say hello", {
      ...makeCtx(s2, repo, workspace.id, session.id),
      taskId: task.id,
      resume: {
        plan,
        filesChanged: { created: [], modified: [], deleted: [] },
        note: report!.uncertainOps.length + " uncertain op(s); inspect first",
      },
    });
    assert.equal(result.status, "completed");
    const done = s2.getTask(task.id);
    assert.equal(done?.status, "completed");
    const events = s2.listEvents(task.id);
    assert.ok(events.some((e) => e.type === "agent.completed"), "completion journaled");
    const greet = await fs.readFile(path.join(repo, "src", "greet.ts"), "utf8");
    assert.ok(greet.includes("hello"), "resumed run actually wrote the fix");

    // phase 4: memory extracted from the completed task
    const mem = new MemoryService(s2);
    const recs = mem.memoriesFromTask(done!, {
      languages: ["typescript"],
      testCommand: "node -e \"process.exit(0)\"",
      verificationOk: true,
    });
    assert.ok(recs.length >= 1);
    assert.ok(mem.search("test command").length >= 1);

    // phase 5: reopen the store in a fresh process; history survives
    s2.close();
    const s3 = await FibreStore.open(storeDir);
    const sess3 = s3.getSession(session.id);
    assert.equal(sess3?.title, "integration");
    assert.equal(s3.getTask(task.id)?.status, "completed");
    assert.ok(new MemoryService(s3).search("typescript").length >= 1);
    s3.close();
  } finally {
    await fs.rm(repo, { recursive: true, force: true });
    await fs.rm(storeDir, { recursive: true, force: true });
  }
});
