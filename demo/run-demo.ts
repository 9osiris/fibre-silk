// end-to-end demo of the silk coding loop against a real buggy repo.
// the model's decisions are scripted (no api keys in this environment),
// but everything else is real: the phase-2 agent runtime, the permission
// gate, real filesystem tools, the real verification engine (npx tsc,
// npm test), real git status/diff, the real router, and the real reviewer
// stage. run with: npx tsx demo/run-demo.ts
import { runCodingTask } from "../core/coding.js";
import { createRegistry, DEFAULT_MODELS } from "../core/models.js";
import { route } from "../core/router.js";
import { Agent } from "../core/agent.js";
import { createLocalTools } from "../core/tools.js";
import type {
  ChatEvent,
  ChatMessage,
  ChatOptions,
  Provider,
  ToolCall,
} from "../core/providers.js";
import type { SilkEvent } from "../core/events.js";

const DEMO = new URL("./buggy-ts", import.meta.url).pathname;

const CORRECT = `// average of a list of numbers
export function average(nums: number[]): number {
  if (nums.length === 0) throw new Error("empty list");
  let total = 0;
  for (const n of nums) total += n;
  return total / nums.length;
}
`;

// a plausible wrong fix: the "model" overcorrects the off-by-one
const WRONG = `// average of a list of numbers
export function average(nums: number[]): number {
  if (nums.length === 0) throw new Error("empty list");
  let total = 0;
  for (const n of nums) total += n;
  return total / (nums.length - 1);
}
`;

const PLAN_JSON = JSON.stringify({
  goal: "find and fix the averaging bug",
  steps: [
    { id: "inspect", description: "read the source and tests" },
    { id: "fix", description: "correct the divisor" },
    { id: "verify", description: "run tests and typecheck" },
  ],
});

const REVIEW_JSON = JSON.stringify({ status: "approved", findings: [] });

type Turn = { text?: string; calls?: Array<{ name: string; args: Record<string, unknown> }> };

let callSeq = 0;
function tc(name: string, args: Record<string, unknown>): ToolCall {
  callSeq += 1;
  return { id: "call-" + callSeq, name, args };
}

// picks the scripted turn from the prompt the loop actually sent
function scriptFor(messages: ChatMessage[]): Turn[] {
  const sys = messages.find((m) => m.role === "system")?.content ?? "";
  const lastUser = [...messages].reverse().find((m) => m.role === "user")?.content ?? "";
  if (sys.includes("exactly YES or NO")) return [{ text: "YES" }];
  if (sys.includes("planning assistant"))
    return [{ text: PLAN_JSON }];
  if (sys.includes("strict code reviewer")) return [{ text: REVIEW_JSON }];
  if (lastUser.startsWith("Inspect this workspace"))
    return [
      { calls: [{ name: "fs_list", args: { path: DEMO } }] },
      {
        calls: [
          { name: "fs_read", args: { path: DEMO + "/src/average.ts" } },
          { name: "fs_read", args: { path: DEMO + "/tests/average.test.ts" } },
        ],
      },
      {
        text: "relevant files: src/average.ts has the bug (divides by nums.length + 1), tests/average.test.ts covers it",
      },
    ];
  if (lastUser.startsWith("Implement the goal"))
    return [
      { calls: [{ name: "fs_write", args: { path: DEMO + "/src/average.ts", content: WRONG } }] },
      { text: "changed the divisor from nums.length + 1 to nums.length - 1" },
    ];
  if (lastUser.startsWith("Fix the following problems"))
    return [
      { calls: [{ name: "fs_read", args: { path: DEMO + "/src/average.ts" } }] },
      { calls: [{ name: "fs_write", args: { path: DEMO + "/src/average.ts", content: CORRECT } }] },
      { text: "corrected the divisor to nums.length" },
    ];
  return [{ text: "done" }];
}

class ScriptedProvider implements Provider {
  readonly id: "openai" | "anthropic";
  constructor(id: "openai" | "anthropic") {
    this.id = id;
  }
  async *chat(messages: ChatMessage[], _opts: ChatOptions): AsyncGenerator<ChatEvent> {
    const turns = scriptFor(messages);
    // the agent appends two messages per step (assistant + tool result),
    // so the conversation length tells us which scripted turn to play.
    // single-shot callers (understand/plan/review) always land on turn 0.
    const idx = Math.max(0, Math.floor((messages.length - 2) / 2));
    const t = turns[Math.min(idx, turns.length - 1)];
    if (t.text) yield { type: "text", delta: t.text };
    if (t.calls) yield { type: "toolCalls", calls: t.calls.map((c) => tc(c.name, c.args)) };
    yield { type: "done", usage: { inputTokens: 10, outputTokens: 10 } };
  }
}

const registry = createRegistry(DEFAULT_MODELS);
const scripted: Record<string, ScriptedProvider> = {
  openai: new ScriptedProvider("openai"),
  anthropic: new ScriptedProvider("anthropic"),
};

const tools = createLocalTools({ allowedRoots: [DEMO] }).all();

async function main(): Promise<void> {
  const onEvent = (e: SilkEvent): void => {
    switch (e.type) {
      case "agent.stage":
        console.log(`\n[stage] ${e.stage} (model: ${e.model || "n/a"} via ${e.provider || "n/a"})`);
        break;
      case "agent.tool_started":
        console.log(`[tool] ${e.tool} started`);
        break;
      case "agent.tool_completed":
        console.log(`[tool] ${e.tool} ${e.ok ? "ok" : "FAILED"} (${e.ms}ms)`);
        break;
      case "agent.retrying":
        console.log(`[retry] attempt ${e.attempt}: ${e.reason}`);
        break;
      case "agent.waiting_for_approval":
        console.log(`[approval] ${e.tool} requested: ${e.summary}`);
        break;
      case "agent.text":
        console.log(`[agent] ${e.delta}`);
        break;
      case "agent.validation_started":
        console.log("[verify] running checks...");
        break;
      default:
        break;
    }
  };

  const result = await runCodingTask(
    "Find the bug in this TypeScript project, fix it, run the tests, and verify the build.",
    {
      dir: DEMO,
      getProvider: (modelId: string) => {
        const info = registry.get(modelId);
        const pid = info?.provider ?? "openai";
        return scripted[pid];
      },
      router: { route: (req: any) => route(req, registry) },
      onEvent,
      approve: async (req: any) => {
        console.log(`[approval] auto-allow_once for ${req.tool}`);
        return "allow_once";
      },
      createAgent: (provider: Provider, model: string) => {
        const agent = new Agent(provider, tools, { model });
        return {
          run: async (task: string, opts?: { signal?: AbortSignal }) => {
            const r = await agent.run(task, {
              signal: opts?.signal,
              maxSteps: 8,
              onEvent,
              approve: async (req: any) => {
                console.log(`[approval] auto-allow_once for ${req.tool}`);
                return "allow_once";
              },
            });
            return { text: r.text, filesChanged: r.filesChanged };
          },
        };
      },
    }
  );

  console.log("\n=== result ===");
  console.log("status:", result.status);
  console.log(result.summary);
  if (result.status !== "completed") process.exit(1);
}

main().catch((err) => {
  console.error("demo failed:", err);
  process.exit(1);
});
