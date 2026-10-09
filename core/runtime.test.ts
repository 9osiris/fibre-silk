// tests for ToolRuntime, permissions, tasks, and the upgraded agent loop.
// run with: npx tsx --test runtime.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  Provider,
  ChatMessage,
  ToolDef,
  ToolCall,
  ChatEvent,
} from "./providers.js";
import { Agent, type AgentTool } from "./agent.js";
import { ToolRuntime } from "./runtime.js";
import { PermissionStore, TOOL_LEVELS } from "./permissions.js";
import { createTask, transition } from "./task.js";
import { createLocalTools } from "./tools.js";
import type { SilkEvent } from "./events.js";

class FakeProvider {
  calls = 0;
  constructor(private script: ChatEvent[][]) {}
  async *chat(
    _messages: ChatMessage[],
    _opts: { model?: string; tools?: ToolDef[] }
  ): AsyncGenerator<ChatEvent> {
    const turn = this.script[Math.min(this.calls, this.script.length - 1)];
    this.calls++;
    for (const e of turn) yield e;
  }
}

const asProvider = (f: FakeProvider): Provider => f as unknown as Provider;
const approveAll = async () => "allow_once" as const;

function toolCall(id: string, name: string, args: unknown): ToolCall {
  return { id, name, args } as unknown as ToolCall;
}

const done = (inputTokens = 10, outputTokens = 5): ChatEvent =>
  ({ type: "done", usage: { inputTokens, outputTokens } } as ChatEvent);

const shoutTool: AgentTool = {
  def: { name: "shout", description: "yell", schema: {} } as ToolDef,
  async run(args) {
    return "SHOUT:" + String(args.text ?? "");
  },
};

// --- task state machine ---

test("task transitions allow valid jumps and reject invalid ones", () => {
  const t = createTask("do the thing");
  assert.equal(t.status, "queued");
  const e1 = transition(t, "executing");
  assert.equal(e1.status, "executing");
  const e2 = transition(e1, "completed");
  assert.equal(e2.status, "completed");
  assert.throws(() => transition(e2, "executing"), /invalid task transition/);
  assert.throws(() => transition(t, "completed"), /invalid task transition/);
  const w = transition(e1, "waiting_for_user");
  assert.equal(transition(w, "executing").status, "executing");
});

// --- permissions ---

test("read-level tools are allow_always, everything else asks", () => {
  assert.equal(TOOL_LEVELS.fs_list, "read");
  assert.equal(TOOL_LEVELS.fs_write, "write");
  assert.equal(TOOL_LEVELS.exec, "execute");
  const store = new PermissionStore();
  assert.equal(store.check("fs_list"), "allow_always");
  assert.equal(store.check("fs_read"), "allow_always");
  assert.equal(store.check("exec"), "ask");
  assert.equal(store.check("fs_write"), "ask");
  store.grant("exec", "allow_session");
  assert.equal(store.check("exec"), "allow_session");
});

// --- ToolRuntime ---

test("permission deny blocks execution and never runs the tool", async () => {
  let ran = false;
  const evil: AgentTool = {
    def: { name: "evil", description: "x", schema: {} } as ToolDef,
    async run() {
      ran = true;
      return "x";
    },
  };
  const store = new PermissionStore();
  store.grant("evil", "deny");
  const rt = new ToolRuntime([evil], store, { taskId: "t" });
  const events: string[] = [];
  const rt2 = new ToolRuntime([evil], store, {
    taskId: "t",
    onEvent: (e) => events.push(e.type),
  });
  const res = await rt2.execute("evil", {}, "c1");
  assert.equal(res.ok, false);
  assert.ok(res.output.includes("denied"));
  assert.equal(ran, false);
  assert.ok(events.includes("agent.tool_failed"));
  void rt;
});

test("allow_once runs once, then asks again", async () => {
  let approvals = 0;
  const store = new PermissionStore();
  const rt = new ToolRuntime([shoutTool], store, {
    taskId: "t",
    approve: async () => {
      approvals++;
      return "allow_once";
    },
  });
  const r1 = await rt.execute("shout", { text: "a" }, "c1");
  const r2 = await rt.execute("shout", { text: "b" }, "c2");
  assert.equal(approvals, 2);
  assert.ok(r1.ok && r2.ok);
  assert.ok(r1.output.includes("SHOUT:a"));
});

test("no approver configured means deny, never hangs", async () => {
  const store = new PermissionStore();
  const rt = new ToolRuntime([shoutTool], store, { taskId: "t" });
  const res = await Promise.race([
    rt.execute("shout", { text: "hi" }, "c1"),
    new Promise<never>((_, rej) =>
      setTimeout(() => rej(new Error("hung")), 2000)
    ),
  ]);
  assert.equal(res.ok, false);
  assert.ok(res.output.includes("denied"));
});

test("unknown tool fails without running anything", async () => {
  const rt = new ToolRuntime([shoutTool], new PermissionStore(), {
    taskId: "t",
    approve: approveAll,
  });
  const res = await rt.execute("nope", {}, "c1");
  assert.equal(res.ok, false);
  assert.ok(res.output.includes("unknown tool"));
});

test("waiting_for_approval event fires before the approver runs", async () => {
  const seen: string[] = [];
  let approvedAfter: string[] = [];
  const rt = new ToolRuntime([shoutTool], new PermissionStore(), {
    taskId: "t",
    onEvent: (e) => seen.push(e.type),
    approve: async () => {
      approvedAfter = [...seen];
      return "allow_once";
    },
  });
  await rt.execute("shout", { text: "hi" }, "c1");
  assert.ok(seen.includes("agent.waiting_for_approval"));
  assert.ok(approvedAfter.includes("agent.waiting_for_approval"));
  assert.ok(seen.includes("agent.tool_completed"));
});

// --- agent cancellation ---

class HangingProvider {
  async *chat(
    _m: ChatMessage[],
    opts: { signal?: AbortSignal }
  ): AsyncGenerator<ChatEvent> {
    await new Promise<void>((_res, rej) => {
      opts.signal?.addEventListener("abort", () => rej(new Error("aborted")), {
        once: true,
      });
    });
    yield { type: "text", delta: "never" } as ChatEvent;
  }
}

test("abort signal mid-run cancels the agent", async () => {
  const agent = new Agent(new HangingProvider() as unknown as Provider, []);
  const ac = new AbortController();
  const events: string[] = [];
  const runP = agent.run("go", {
    signal: ac.signal,
    onEvent: (e: SilkEvent) => events.push(e.type),
  });
  ac.abort();
  const res = await runP;
  assert.equal(res.status, "cancelled");
  assert.ok(events.includes("agent.cancelled"));
});

test("agent.cancel() aborts a running turn", async () => {
  const agent = new Agent(new HangingProvider() as unknown as Provider, []);
  const runP = agent.run("go", {});
  setTimeout(() => agent.cancel(), 50);
  const res = await runP;
  assert.equal(res.status, "cancelled");
});

// --- execution limits ---

test("wall-clock timeout fails the run", async () => {
  const slow: AgentTool = {
    def: { name: "slow", description: "slow", schema: {} } as ToolDef,
    async run() {
      await new Promise((r) => setTimeout(r, 40));
      return "slow done";
    },
  };
  const turn: ChatEvent[] = [
    { type: "toolCalls", calls: [toolCall("1", "slow", {})] } as ChatEvent,
    done(),
  ];
  const p = new FakeProvider([turn, turn, turn, turn, turn]);
  const agent = new Agent(asProvider(p), [slow]);
  const res = await agent.run("go", { maxWallMs: 30, approve: approveAll });
  assert.equal(res.status, "failed");
  assert.ok(res.text.includes("wall-clock"));
});

test("loop detection stops three identical calls in a row", async () => {
  const lister: AgentTool = {
    def: { name: "fs_list", description: "list", schema: {} } as ToolDef,
    async run() {
      return "files";
    },
  };
  const turn: ChatEvent[] = [
    {
      type: "toolCalls",
      calls: [toolCall("1", "fs_list", { path: "/tmp" })],
    } as ChatEvent,
    done(),
  ];
  const p = new FakeProvider([turn, turn, turn, turn, turn]);
  const agent = new Agent(asProvider(p), [lister]);
  const res = await agent.run("go");
  assert.equal(res.status, "failed");
  assert.ok(res.text.includes("loop detected"));
  assert.equal(p.calls, 3);
});

test("malformed tool call becomes error text, the run continues", async () => {
  const p = new FakeProvider([
    [
      { type: "toolCalls", calls: [toolCall("1", "shout", "{not json")] } as ChatEvent,
      done(),
    ],
    [{ type: "text", delta: "fine" } as ChatEvent, done()],
  ]);
  const agent = new Agent(asProvider(p), [shoutTool]);
  const events: string[] = [];
  const res = await agent.run("go", {
    approve: approveAll,
    onEvent: (e: SilkEvent) => events.push(e.type),
  });
  assert.equal(res.status, "completed");
  assert.equal(res.text, "fine");
  assert.ok(events.includes("agent.tool_failed"));
});

test("tool call limit stops a chatty agent", async () => {
  const mkTurn = (t: string): ChatEvent[] => [
    { type: "toolCalls", calls: [toolCall("1", "shout", { text: t })] } as ChatEvent,
    done(),
  ];
  const p = new FakeProvider([mkTurn("a"), mkTurn("b"), mkTurn("c")]);
  const agent = new Agent(asProvider(p), [shoutTool]);
  const res = await agent.run("go", { maxToolCalls: 2, approve: approveAll });
  assert.equal(res.status, "failed");
  assert.ok(res.text.includes("tool call limit exceeded"));
});

// --- provider recovery ---

class FlakyProvider {
  calls = 0;
  constructor(private failTimes: number) {}
  async *chat(): AsyncGenerator<ChatEvent> {
    this.calls++;
    if (this.calls <= this.failTimes) throw new Error("boom");
    yield { type: "text", delta: "recovered" } as ChatEvent;
    yield done() as ChatEvent;
  }
}

test("provider error retries once, then succeeds", async () => {
  const agent = new Agent(new FlakyProvider(1) as unknown as Provider, []);
  const events: string[] = [];
  const res = await agent.run("go", {
    onEvent: (e: SilkEvent) => events.push(e.type),
  });
  assert.equal(res.status, "completed");
  assert.equal(res.text, "recovered");
  assert.ok(events.includes("agent.retrying"));
});

test("provider error twice fails the run", async () => {
  const agent = new Agent(new FlakyProvider(5) as unknown as Provider, []);
  const events: string[] = [];
  const res = await agent.run("go", {
    onEvent: (e: SilkEvent) => events.push(e.type),
  });
  assert.equal(res.status, "failed");
  assert.ok(res.text.includes("provider error after retry"));
  assert.equal(events.filter((t) => t === "agent.retrying").length, 1);
});

// --- exec abort kills the child ---

test("aborting exec rejects fast and leaves no hanging child", async () => {
  const exec = createLocalTools().get("exec");
  assert.ok(exec);
  const ac = new AbortController();
  const started = Date.now();
  const runP = exec.run(
    { command: 'node -e "setTimeout(()=>{},30000)"' },
    { signal: ac.signal }
  );
  setTimeout(() => ac.abort(), 100);
  await assert.rejects(runP, /cancelled/);
  const ms = Date.now() - started;
  assert.ok(ms < 5000, `took ${ms}ms, child was not killed promptly`);
});
