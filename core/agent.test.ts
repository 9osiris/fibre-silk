// tests for the silk agent tool loop. run with: npx tsx --test agent.test.ts
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
import type { SilkEvent } from "./events.js";

// scripted provider: each chat() call plays the next scripted turn
class FakeProvider {
  calls = 0;
  seen: ChatMessage[][] = [];
  constructor(private script: ChatEvent[][]) {}
  async *chat(
    messages: ChatMessage[],
    _opts: { model?: string; tools?: ToolDef[] }
  ): AsyncGenerator<ChatEvent> {
    this.seen.push(messages);
    const turn = this.script[Math.min(this.calls, this.script.length - 1)];
    this.calls++;
    for (const e of turn) yield e;
  }
}

const asProvider = (f: FakeProvider): Provider => f as unknown as Provider;

// non-read tools ask for approval by default; tests approve everything
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

test("tool loop calls the tool and returns the final text", async () => {
  const p = new FakeProvider([
    [
      {
        type: "toolCalls",
        calls: [toolCall("1", "shout", { text: "hi" })],
      } as ChatEvent,
      done(),
    ],
    [{ type: "text", delta: "all done" } as ChatEvent, done(20, 8)],
  ]);
  const agent = new Agent(asProvider(p), [shoutTool]);
  const events: string[] = [];
  const res = await agent.run("yell hi", {
    onEvent: (e: SilkEvent) => events.push(e.type),
    approve: approveAll,
  });
  assert.equal(res.text, "all done");
  assert.equal(res.status, "completed");
  assert.ok(
    events.includes("agent.tool_started") &&
      events.includes("agent.tool_completed")
  );
  assert.ok(events.includes("agent.started") && events.includes("agent.completed"));
  // tool result message went back to the provider on the second turn
  const secondTurn = p.seen[1] as unknown as Array<Record<string, unknown>>;
  assert.ok(
    secondTurn.some(
      (m) => m.role === "tool" && String(m.content).includes("SHOUT:hi")
    )
  );
  // assistant message carried the tool call in provider format
  assert.ok(
    secondTurn.some(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.toolCalls) &&
        (m.toolCalls as Array<Record<string, unknown>>).some(
          (c) => c.id === "1" && c.name === "shout"
        )
    )
  );
  assert.equal(res.inputTokens, 30);
  assert.equal(res.outputTokens, 13);
});

test("maxSteps stops a tool that always asks for more", async () => {
  // args differ per turn so loop detection does not fire first
  const mkTurn = (t: string): ChatEvent[] => [
    {
      type: "toolCalls",
      calls: [toolCall("1", "shout", { text: t })],
    } as ChatEvent,
    done(),
  ];
  const p = new FakeProvider([mkTurn("a"), mkTurn("b"), mkTurn("c"), mkTurn("d")]);
  const agent = new Agent(asProvider(p), [shoutTool]);
  const res = await agent.run("go", { maxSteps: 3, approve: approveAll });
  assert.equal(p.calls, 3);
  assert.equal(res.status, "failed");
  assert.ok(res.text.includes("stopped after 3 steps"));
});

test("a throwing tool becomes error text, the run continues", async () => {
  const bad: AgentTool = {
    def: { name: "bad", description: "fails", schema: {} } as ToolDef,
    async run() {
      throw new Error("boom");
    },
  };
  const p = new FakeProvider([
    [
      { type: "toolCalls", calls: [toolCall("9", "bad", {})] } as ChatEvent,
      done(),
    ],
    [{ type: "text", delta: "recovered" } as ChatEvent, done()],
  ]);
  const agent = new Agent(asProvider(p), [bad]);
  const res = await agent.run("try it", { approve: approveAll });
  assert.equal(res.text, "recovered");
  assert.equal(res.status, "completed");
  const secondTurn = p.seen[1] as unknown as Array<Record<string, unknown>>;
  assert.ok(
    secondTurn.some(
      (m) => m.role === "tool" && String(m.content).includes("tool error: boom")
    )
  );
});

test("unknown tool name becomes error text", async () => {
  const p = new FakeProvider([
    [
      { type: "toolCalls", calls: [toolCall("2", "nope", {})] } as ChatEvent,
      done(),
    ],
    [{ type: "text", delta: "fine" } as ChatEvent, done()],
  ]);
  const agent = new Agent(asProvider(p), [shoutTool]);
  const res = await agent.run("go", { approve: approveAll });
  assert.equal(res.text, "fine");
  assert.equal(res.status, "completed");
  const secondTurn = p.seen[1] as unknown as Array<Record<string, unknown>>;
  assert.ok(
    secondTurn.some((m) => String(m.content).includes("unknown tool: nope"))
  );
});
