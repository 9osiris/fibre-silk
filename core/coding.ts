// coding loop orchestrator: understand -> plan -> inspect -> implement ->
// test -> review -> fix -> test -> verify -> complete. multi-model per
// stage, bounded fix loops, no commits ever.
//
// stage agents come from ctx.createAgent. Agent, SilkEvent and FileChanges
// are imported as types only from their canonical modules; agent.ts and
// events.ts are being rewritten to the ARCHITECTURE.md contract in
// parallel, so this module never depends on their implementations.

import type { Agent } from "./agent.js";
import type { FileChanges, Plan, SilkEvent } from "./events.js";
import type { ChatMessage, Provider } from "./providers.js";
import { generatePlan, nextPending, setStepState } from "./planner.js";
import { reviewChanges } from "./reviewer.js";
import { VerificationEngine, type VerificationReport } from "./verify.js";
import { analyzeWorkspaceCached, describeWorkspace } from "./workspace.js";
import { changedFiles, gitDiff, gitStatus } from "./git.js";
import { assembleContext } from "./context.js";
import { MemoryService, memoryContextBlock } from "./memory.js";

// keep the Agent type referenced: stage runners are phase-2 Agents built
// by the integration layer (see createAgent below).
type _AgentRef = Agent;

export interface StageRunner {
  run(
    task: string,
    opts?: { signal?: AbortSignal }
  ): Promise<{ text: string; filesChanged: FileChanges }>;
}

import type { FibreStore } from "./store.js";
import { TOOL_LEVELS } from "./permissions.js";

export interface CodingContext {
  dir: string;
  getProvider: (modelId: string) => Provider | Promise<Provider>;
  router: {
    route(req: any): { model: string; provider: string; reason: string };
  };
  onEvent: (e: SilkEvent) => void;
  approve?: (req: any) => Promise<any>;
  signal?: AbortSignal;
  // integration seam: builds a stage-scoped agent for a routed model.
  // the parent wires this to `new Agent(provider, tools, { model })`
  // once the phase-2 agent rewrite lands. required to run real tasks;
  // tests inject scripted fakes here.
  createAgent?: (provider: Provider, model: string) => StageRunner | Promise<StageRunner>;
  // phase 3 persistence: when a store is wired, the task record,
  // durable events, approvals, and stage checkpoints are persisted.
  store?: FibreStore;
  sessionId?: string;
  workspaceId?: string;
  taskId?: string;
  // resume an interrupted task from its checkpoint: restores the plan
  // and re-enters the loop at implement (or the recorded stage).
  resume?: { plan: Plan | null; filesChanged: FileChanges; note: string };
}

export interface CodingResult {
  status: "completed" | "failed" | "cancelled";
  summary: string;
  filesChanged: FileChanges;
}

type Stage = "understand" | "plan" | "inspect" | "implement" | "test" | "review" | "fix" | "verify" | "complete";

const MAX_FIX_ROUNDS = 2;

function newTaskId(): string {
  return "task-" + Date.now().toString(36) + "-" + Math.floor(Math.random() * 1e6).toString(36);
}

function emptyChanges(): FileChanges {
  return { created: [], modified: [], deleted: [] };
}

function mergeChanges(a: FileChanges, b: FileChanges): FileChanges {
  const union = (x: string[], y: string[]) => [...new Set([...x, ...y])];
  return {
    created: union(a.created, b.created),
    modified: union(a.modified, b.modified),
    deleted: union(a.deleted, b.deleted),
  };
}

async function collectText(
  provider: Provider,
  messages: ChatMessage[],
  model: string,
  signal?: AbortSignal
): Promise<string> {
  let text = "";
  for await (const ev of provider.chat(messages, { model, signal })) {
    if (ev.type === "text") text += ev.delta;
    if (signal?.aborted) break;
  }
  return text.trim();
}

function checkCancelled(ctx: CodingContext): boolean {
  return !!ctx.signal?.aborted;
}

export async function runCodingTask(goal: string, ctx: CodingContext): Promise<CodingResult> {
  const taskId = ctx.taskId ?? newTaskId();
  const store = ctx.store;
  // durable wiring: create the task record once, journal durable
  // events, track stage/plan/files on the record, checkpoint at stage
  // boundaries. persistence failures never break the run itself.
  if (store) {
    try {
      if (!ctx.taskId) {
        store.createTask({ id: taskId, sessionId: ctx.sessionId, workspaceId: ctx.workspaceId, goal });
      }
      store.updateTask(taskId, { status: "executing" });
    } catch {
      // store unavailable: the run continues in-memory
    }
  }
  const emit = (e: SilkEvent): void => {
    if (store) {
      try {
        store.appendEvent(taskId, e.type, e as unknown as Record<string, unknown>);
        if (e.type === "agent.stage") {
          store.updateTask(taskId, { model: { model: e.model, provider: e.provider } });
        } else if (e.type === "agent.plan_created") {
          store.updateTask(taskId, { plan: e.plan, status: "executing" });
        } else if (e.type === "agent.waiting_for_approval") {
          store.createApproval({
            taskId,
            callId: e.callId,
            tool: e.tool,
            level: TOOL_LEVELS[e.tool] ?? "execute",
            summary: e.summary,
            args: {},
          });
        } else if (e.type === "agent.completed") {
          store.updateTask(taskId, { status: "completed", filesChanged: e.filesChanged, finishedAt: Date.now() });
        } else if (e.type === "agent.failed") {
          store.updateTask(taskId, { status: "failed", error: e.error, finishedAt: Date.now() });
        } else if (e.type === "agent.cancelled") {
          store.updateTask(taskId, { status: "cancelled", finishedAt: Date.now() });
        }
      } catch {
        // persistence is best-effort during a run
      }
    }
    ctx.onEvent(e);
  };
  const checkpoint = (stageName: string, state: Record<string, unknown>): void => {
    if (!store) return;
    try {
      store.saveCheckpoint(taskId, stageName, state);
      store.updateTask(taskId, { stage: stageName });
    } catch {
      // checkpoint failure is not fatal
    }
  };
  const fail = (error: string): CodingResult => {
    emit({ type: "agent.failed", taskId, error });
    return { status: "failed", summary: error, filesChanged: emptyChanges() };
  };

  emit({ type: "agent.started", taskId, goal });
  if (checkCancelled(ctx)) {
    emit({ type: "agent.cancelled", taskId });
    return { status: "cancelled", summary: "cancelled before start", filesChanged: emptyChanges() };
  }

  const stage = (s: Stage, model: string, provider: string) =>
    emit({ type: "agent.stage", taskId, stage: s, model, provider });

  const routeInfo = (kind: string, extra?: any): { model: string; provider: string } => {
    const r = ctx.router.route({ kind, ...extra });
    return { model: r.model, provider: r.provider };
  };

  try {
    // understand: workspace snapshot + trivial-task classification
    // (skipped on resume: the checkpoint already classified this task)
    if (!ctx.resume) {
      const r = ctx.router.route({ kind: "fast" });
      const provider = await ctx.getProvider(r.model);
      stage("understand", r.model, r.provider);
      const ws = describeWorkspace(await analyzeWorkspaceCached(ctx.dir));
      const answer = await collectText(
        provider,
        [
          { role: "system", content: "Reply with exactly YES or NO." },
          {
            role: "user",
            content:
              "Goal: " + goal + "\nWorkspace:\n" + ws +
              "\nDoes this goal require creating, modifying, or deleting files? Reply with exactly YES or NO.",
          },
        ],
        r.model,
        ctx.signal
      );
      if (checkCancelled(ctx)) {
        emit({ type: "agent.cancelled", taskId });
        return { status: "cancelled", summary: "cancelled", filesChanged: emptyChanges() };
      }
      if (/^\s*no\b/i.test(answer)) {
        const summary = "no file changes needed: " + answer.slice(0, 200);
        emit({ type: "agent.text", taskId, delta: summary });
        emit({ type: "agent.completed", taskId, summary, filesChanged: emptyChanges() });
        return { status: "completed", summary, filesChanged: emptyChanges() };
      }
    }

    // plan
    let plan: Plan;
    if (ctx.resume?.plan) {
      // resuming an interrupted task: the plan is restored, not rebuilt
      plan = ctx.resume.plan;
      emit({ type: "agent.plan_created", taskId, plan });
    } else {
      const r = ctx.router.route({ kind: "reasoning" });
      const provider = await ctx.getProvider(r.model);
      stage("plan", r.model, r.provider);
      plan = await generatePlan(provider, goal, { model: r.model });
      emit({ type: "agent.plan_created", taskId, plan });
    }
    checkpoint("plan", { stage: "plan", plan });

    // stages beyond this point need real agents
    if (!ctx.createAgent) {
      return fail("coding: no agent factory wired (ctx.createAgent). the integration layer must provide it.");
    }
    const createAgent = ctx.createAgent;

    const runnerFor = async (kind: string, extra?: any): Promise<{ runner: StageRunner; model: string; provider: string }> => {
      const r = ctx.router.route({ kind, ...extra });
      const provider = await ctx.getProvider(r.model);
      const runner = await createAgent(provider, r.model);
      return { runner, model: r.model, provider: r.provider };
    };

    // inspect (skipped on resume: the checkpoint already carries the state)
    let inspectNotes = "";
    if (ctx.resume) {
      inspectNotes = ctx.resume.note;
    } else {
      const { runner, model, provider } = await runnerFor("coding");
      stage("inspect", model, provider);
      const ws = describeWorkspace(await analyzeWorkspaceCached(ctx.dir));
      const res = await runner.run(
        "Inspect this workspace and list the files relevant to the goal. Do not modify anything.\n\nGoal: " +
          goal + "\n\nWorkspace:\n" + ws,
        { signal: ctx.signal }
      );
      inspectNotes = res.text;
      emit({ type: "agent.text", taskId, delta: "inspection: " + inspectNotes.slice(0, 300) });
    }
    if (checkCancelled(ctx)) {
      emit({ type: "agent.cancelled", taskId });
      return { status: "cancelled", summary: "cancelled during inspect", filesChanged: emptyChanges() };
    }

    const beforeFiles = await gitStatus(ctx.dir)
      .then((s) => ({ ok: true as const, files: s.files }))
      .catch(() => ({ ok: false as const, files: [] as string[] }));
    const gitOk = beforeFiles.ok;
    let filesChanged = ctx.resume?.filesChanged ?? emptyChanges();
    let verification: VerificationReport | null = null;
    let reviewNote = "not run";

    const snapshot = async () => {
      if (!gitOk) return;
      const after = (await gitStatus(ctx.dir)).files;
      filesChanged = mergeChanges(filesChanged, changedFiles(beforeFiles.files, after));
    };

    const runVerify = async (): Promise<VerificationReport> => {
      emit({ type: "agent.validation_started", taskId });
      const engine = new VerificationEngine(ctx.dir, async (cmd, args) => {
        const { execFile } = await import("node:child_process");
        return new Promise((resolve) => {
          execFile(cmd, args, { cwd: ctx.dir, timeout: 120000 }, (err, stdout, stderr) => {
            resolve({ code: err ? 1 : 0, out: (stdout + stderr).trim() });
          });
        });
      });
      return engine.run();
    };

    const fixRound = async (problems: string, round: number): Promise<boolean> => {
      const { runner, model, provider } = await runnerFor("coding");
      stage("fix", model, provider);
      const context = assembleContext([
        { label: "goal", text: goal, keep: "both" },
        { label: "problems to fix", text: problems, keep: "both" },
        { label: "files changed so far", text: JSON.stringify(filesChanged), keep: "head" },
      ]);
      const res = await runner.run(
        "Fix the following problems in the workspace. Make the minimal correct changes.\n\n" + context,
        { signal: ctx.signal }
      );
      await snapshot();
      emit({ type: "agent.text", taskId, delta: "fix round " + round + ": " + res.text.slice(0, 300) });
      verification = await runVerify();
      return verification.ok;
    };

    // implement
    {
      const { runner, model, provider } = await runnerFor("coding");
      stage("implement", model, provider);
      const step = nextPending(plan);
      if (step) setStepState(plan, step.id, "active");
      // relevant persistent memory for this workspace, when wired
      const memoryText = store
        ? memoryContextBlock(
            new MemoryService(store).search(goal, { workspaceId: ctx.workspaceId, budgetChars: 3000 })
          )
        : "";
      const context = assembleContext([
        { label: "goal", text: goal, keep: "both" },
        { label: "plan", text: plan.steps.map((s) => "- [" + s.status + "] " + s.id + ": " + s.description).join("\n"), keep: "both" },
        { label: "inspection notes", text: inspectNotes, budget: 4000 },
        { label: "workspace", text: describeWorkspace(await analyzeWorkspaceCached(ctx.dir)), keep: "head" },
        ...(memoryText ? [{ label: "relevant memory", text: memoryText, budget: 3000 }] : []),
      ]);
      const res = await runner.run(
        "Implement the goal in the workspace at " + ctx.dir + ". Follow the plan. Make the minimal correct changes.\n\n" + context,
        { signal: ctx.signal }
      );
      await snapshot();
      for (const s of plan.steps) {
        if (s.status === "active") setStepState(plan, s.id, "completed");
      }
      emit({ type: "agent.text", taskId, delta: "implemented: " + res.text.slice(0, 300) });
      checkpoint("implement", { stage: "implement", plan, filesChanged });
    }
    if (checkCancelled(ctx)) {
      emit({ type: "agent.cancelled", taskId });
      return { status: "cancelled", summary: "cancelled during implement", filesChanged };
    }

    // test -> fix loop (bounded)
    let round = 0;
    for (;;) {
      const { model, provider } = routeInfo("coding");
      stage("test", model, provider);
      verification = await runVerify();
      const failed = verification.checks.filter((c) => !c.ok);
      if (failed.length === 0) break;
      round += 1;
      if (round > MAX_FIX_ROUNDS) {
        const summary = "tests still failing after " + MAX_FIX_ROUNDS + " fix rounds: " +
          failed.map((c) => c.name + ": " + c.output.slice(0, 200)).join("; ");
        return fail(summary);
      }
      emit({ type: "agent.retrying", taskId, attempt: round, reason: failed.map((c) => c.name).join(", ") });
      const ok = await fixRound(
        failed.map((c) => "check " + c.name + " failed:\n" + c.output).join("\n\n"),
        round
      );
      if (ok) break;
      if (checkCancelled(ctx)) {
        emit({ type: "agent.cancelled", taskId });
        return { status: "cancelled", summary: "cancelled during fix", filesChanged };
      }
    }
    checkpoint("test", {
      stage: "test",
      plan,
      filesChanged,
      verification: verification
        ? { ok: verification.ok, checks: verification.checks.map((c) => ({ name: c.name, ok: c.ok })) }
        : null,
    });

    // review (prefer a different provider than the coder)
    {
      const coderModel = ctx.router.route({ kind: "coding" }).model;
      const r = ctx.router.route({ kind: "review", coderModel });
      const provider = await ctx.getProvider(r.model);
      stage("review", r.model, r.provider);
      const diff = gitOk ? await gitDiff(ctx.dir).catch(() => "") : "";
      const testReport = verification
        ? verification.checks.map((c) => (c.ok ? "PASS" : "FAIL") + " " + c.name).join("\n")
        : "(no verification ran)";
      const result = await reviewChanges(provider, { goal, diff: diff.slice(0, 20000), testReport }, { model: r.model });
      if (result.status === "changes_required") {
        reviewNote = result.findings.length + " findings, fixing";
        emit({ type: "agent.text", taskId, delta: "review: changes_required (" + result.findings.length + " findings)" });
        const ok = await fixRound(
          "Code review findings:\n" + result.findings.map((f) => "[" + f.severity + "] " + f.file + ": " + f.description).join("\n"),
          round + 1
        );
        if (!ok) {
          return fail("review findings could not be fixed: " +
            result.findings.map((f) => f.file + ": " + f.description).join("; "));
        }
        reviewNote = result.findings.length + " findings, fixed";
      } else {
        reviewNote = "approved";
        emit({ type: "agent.text", taskId, delta: "review: approved" });
      }
      checkpoint("review", { stage: "review", plan, filesChanged, reviewNote });
    }
    if (checkCancelled(ctx)) {
      emit({ type: "agent.cancelled", taskId });
      return { status: "cancelled", summary: "cancelled during review", filesChanged };
    }

    // verify (final)
    {
      const { model, provider } = routeInfo("coding");
      stage("verify", model, provider);
      verification = await runVerify();
      if (!verification.ok) {
        const failed = verification.checks.filter((c) => !c.ok);
        return fail("final verification failed: " +
          failed.map((c) => c.name + ": " + c.output.slice(0, 200)).join("; "));
      }
    }

    for (const s of plan.steps) {
      if (s.status === "pending" || s.status === "active") setStepState(plan, s.id, "completed");
    }
    stage("complete", "", "");
    const summary =
      "goal: " + goal + "\n" +
      "plan: " + plan.steps.filter((s) => s.status === "completed").length + "/" + plan.steps.length + " steps completed\n" +
      "files: +" + filesChanged.created.length + " ~" + filesChanged.modified.length + " -" + filesChanged.deleted.length +
      (filesChanged.created.concat(filesChanged.modified).slice(0, 10).join(", ") ? " (" + filesChanged.created.concat(filesChanged.modified).slice(0, 10).join(", ") + ")" : "") + "\n" +
      "verification: " + (verification ? verification.checks.filter((c) => c.ok).length + "/" + verification.checks.length + " checks passed" : "n/a") + "\n" +
      "review: " + reviewNote;
    emit({ type: "agent.completed", taskId, summary, filesChanged });
    return { status: "completed", summary, filesChanged };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (checkCancelled(ctx)) {
      emit({ type: "agent.cancelled", taskId });
      return { status: "cancelled", summary: "cancelled: " + msg, filesChanged: emptyChanges() };
    }
    return fail(msg);
  }
}
