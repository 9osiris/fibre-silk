// tests for coding.ts. run with: npx tsx --test coding.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChatEvent, ChatMessage, Provider, ToolDef } from "./providers.js";
import type { SilkEvent } from "./events.js";
import { runCodingTask, type CodingContext, type StageRunner } from "./coding.js";

function scriptedProvider(replies: string[]): Provider {
  let n = 0;
  return {
    id: "openai",
    async *chat(_m: ChatMessage[], _o: { model?: string; tools?: ToolDef[] }): AsyncGenerator<ChatEvent> {
      const reply = replies[Math.min(n++, replies.length - 1)];
      yield { type: "text", delta: reply };
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  } as unknown as Provider;
}

const PLAN_JSON = JSON.stringify({
  goal: "make tests pass",
  steps: [
    { id: "inspect", description: "find the failing test" },
    { id: "implement", description: "create the app module" },
    { id: "test", description: "run the suite" },
  ],
});
const REVIEW_JSON = JSON.stringify({ status: "approved", findings: [] });

function makeRouter() {
  const table: Record<string, { model: string; provider: string }> = {
    fast: { model: "fast-1", provider: "openai" },
    reasoning: { model: "think-1", provider: "anthropic" },
    coding: { model: "code-1", provider: "openai" },
    review: { model: "review-1", provider: "anthropic" },
  };
  return {
    route: (req: any) => {
      const r = table[req.kind] ?? table.fast;
      return { ...r, reason: "test routing" };
    },
  };
}

function eventsOf(log: SilkEvent[]): string[] {
  return log.map((e) =>
    e.type === "agent.stage" ? "stage:" + (e as any).stage : e.type
  );
}

function inOrder(log: string[], seq: string[]): boolean {
  let i = 0;
  for (const e of log) {
    if (e === seq[i]) i++;
    if (i === seq.length) return true;
  }
  return false;
}

function baseCtx(dir: string, log: SilkEvent[]): CodingContext {
  return {
    dir,
    getProvider: (model: string) => scriptedProvider(["NO"]),
    router: makeRouter(),
    onEvent: (e) => log.push(e),
  };
}

test("trivial task completes after understand with no file changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "silk-code-trivial-"));
  const log: SilkEvent[] = [];
  const ctx = baseCtx(dir, log);
  const res = await runCodingTask("what is 2+2?", ctx);
  assert.equal(res.status, "completed");
  assert.deepEqual(res.filesChanged, { created: [], modified: [], deleted: [] });
  const seq = eventsOf(log);
  assert.ok(seq.includes("agent.started"));
  assert.ok(seq.includes("stage:understand"));
  assert.ok(seq.includes("agent.completed"));
  assert.ok(!seq.includes("stage:implement"));
});

test("full loop: implement, test fails, fix, review, verify, complete", async () => {
  const dir = mkdtempSync(join(tmpdir(), "silk-code-full-"));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "d", scripts: { test: "node check.js" } })
  );
  writeFileSync(join(dir, "check.js"), 'console.log("FAIL: app missing");\nprocess.exit(1);\n');

  const log: SilkEvent[] = [];
  const providers: Record<string, Provider> = {
    "fast-1": scriptedProvider(["YES"]),
    "think-1": scriptedProvider([PLAN_JSON]),
    "review-1": scriptedProvider([REVIEW_JSON]),
  };
  const runners: Record<string, StageRunner> = {
    "code-1": {
      run: async (task: string) => {
        if (task.startsWith("Inspect")) {
          return { text: "relevant: check.js", filesChanged: { created: [], modified: [], deleted: [] } };
        }
        if (task.startsWith("Fix the following")) {
          writeFileSync(join(dir, "check.js"), 'console.log("PASS");\n');
          return { text: "fixed check.js", filesChanged: { created: [], modified: ["check.js"], deleted: [] } };
        }
        mkdirSync(join(dir, "src"), { recursive: true });
        writeFileSync(join(dir, "src", "app.js"), "module.exports = 42;\n");
        return { text: "created src/app.js", filesChanged: { created: [], modified: [], deleted: [] } };
      },
    },
  };
  const ctx: CodingContext = {
    dir,
    getProvider: (model: string) => providers[model] ?? scriptedProvider([""]),
    router: makeRouter(),
    onEvent: (e) => log.push(e),
    createAgent: async (_provider: Provider, model: string) => {
      const r = runners[model];
      if (!r) throw new Error("unexpected runner for " + model);
      return r;
    },
  };

  const res = await runCodingTask("make the test suite pass", ctx);
  assert.equal(res.status, "completed");
  assert.ok(res.filesChanged.created.some((f) => f.includes("src")));
  assert.ok(res.summary.includes("verification"));

  const seq = eventsOf(log);
  assert.ok(
    inOrder(seq, [
      "agent.started",
      "stage:understand",
      "stage:plan",
      "agent.plan_created",
      "stage:inspect",
      "stage:implement",
      "stage:test",
      "agent.validation_started",
      "agent.retrying",
      "stage:fix",
      "agent.validation_started",
      "stage:review",
      "stage:verify",
      "stage:complete",
      "agent.completed",
    ]),
    "stage order wrong: " + seq.join(" -> ")
  );
  // review ran on a different provider than the coder
  const reviewStage = log.find(
    (e) => e.type === "agent.stage" && (e as any).stage === "review"
  ) as any;
  const implStage = log.find(
    (e) => e.type === "agent.stage" && (e as any).stage === "implement"
  ) as any;
  assert.notEqual(reviewStage.provider, implStage.provider);
});

test("malformed plan fails the task with a clear error", async () => {
  const dir = mkdtempSync(join(tmpdir(), "silk-code-badplan-"));
  const log: SilkEvent[] = [];
  const ctx: CodingContext = {
    ...baseCtx(dir, log),
    getProvider: (model: string) =>
      model === "think-1" ? scriptedProvider(["i dunno lol"]) : scriptedProvider(["YES"]),
    createAgent: async () => ({
      run: async () => ({ text: "x", filesChanged: { created: [], modified: [], deleted: [] } }),
    }),
  };
  const res = await runCodingTask("do the thing", ctx);
  assert.equal(res.status, "failed");
  assert.ok(res.summary.includes("valid JSON plan"));
  assert.ok(eventsOf(log).includes("agent.failed"));
});

test("cancelled before start", async () => {
  const dir = mkdtempSync(join(tmpdir(), "silk-code-cancel-"));
  const log: SilkEvent[] = [];
  const ctl = new AbortController();
  ctl.abort();
  const ctx: CodingContext = { ...baseCtx(dir, log), signal: ctl.signal };
  const res = await runCodingTask("whatever", ctx);
  assert.equal(res.status, "cancelled");
  assert.ok(eventsOf(log).includes("agent.cancelled"));
});

test("missing agent factory fails clearly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "silk-code-nofactory-"));
  const log: SilkEvent[] = [];
  const ctx: CodingContext = {
    ...baseCtx(dir, log),
    getProvider: (model: string) =>
      model === "think-1" ? scriptedProvider([PLAN_JSON]) : scriptedProvider(["YES"]),
  };
  const res = await runCodingTask("whatever", ctx);
  assert.equal(res.status, "failed");
  assert.ok(res.summary.includes("no agent factory"));
});
