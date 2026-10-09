// silk agent runtime: tool loop with execution limits, loop detection,
// provider recovery, cancellation, and structured silk events.
// clean-room original code for silk by layered innovation.

import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import type {
  Provider,
  ChatMessage,
  ToolDef,
  ToolCall,
  ChatEvent,
} from "./providers.js";
import type { SilkEvent, FileChanges } from "./events.js";
import {
  ToolRuntime,
  type ApprovalDecision,
  type ApprovalRequest,
} from "./runtime.js";
import { PermissionStore } from "./permissions.js";

export interface AgentTool {
  def: ToolDef;
  run(
    args: Record<string, unknown>,
    ctx?: { signal?: AbortSignal }
  ): Promise<string>;
}

export interface ExecutionLimits {
  maxSteps?: number; // default 12
  maxWallMs?: number; // default 10 minutes
  maxToolCalls?: number; // default 40
  toolTimeoutMs?: number; // default 120s
}

export interface RunOptions extends ExecutionLimits {
  signal?: AbortSignal;
  onEvent?: (e: SilkEvent) => void;
  approve?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  taskId?: string;
}

export interface RunResult {
  text: string;
  status: "completed" | "failed" | "cancelled";
  steps: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  filesChanged: FileChanges;
}

export interface AgentOptions {
  model?: string;
  systemPrompt?: string;
}

export const DEFAULT_SYSTEM_PROMPT = [
  "You are Silk, a personal AI agent for one user.",
  "Be concise. Ask before anything destructive or irreversible.",
  "Use tools when they help; explain what you did briefly after.",
].join("\n");

const DEFAULTS = {
  maxSteps: 12,
  maxWallMs: 10 * 60 * 1000,
  maxToolCalls: 40,
  toolTimeoutMs: 120000,
};

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// tool call args arrive parsed from providers, but be defensive: anything
// else becomes a malformed-call error result instead of a crash.
function parseCallArgs(
  call: ToolCall
): { ok: true; args: Record<string, unknown> } | { ok: false; error: string } {
  const raw = (call as { args?: unknown }).args;
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    return { ok: true, args: raw as Record<string, unknown> };
  }
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return { ok: true, args: parsed as Record<string, unknown> };
      }
      return { ok: false, error: "tool args parsed to a non-object" };
    } catch {
      return { ok: false, error: "tool args are not valid json" };
    }
  }
  return { ok: false, error: "tool args missing" };
}

export class Agent {
  private provider: Provider;
  private tools: AgentTool[];
  private model?: string;
  private systemPrompt: string;
  private aborter: AbortController | null = null;

  constructor(
    provider: Provider,
    tools: AgentTool[],
    opts: AgentOptions = {}
  ) {
    this.provider = provider;
    this.tools = tools;
    this.model = opts.model;
    this.systemPrompt = opts.systemPrompt ?? DEFAULT_SYSTEM_PROMPT;
  }

  // abort the provider stream, the approval wait, and running tools
  cancel(): void {
    this.aborter?.abort();
  }

  async run(task: string, opts: RunOptions = {}): Promise<RunResult> {
    const taskId = opts.taskId ?? randomUUID();
    const emit = (e: SilkEvent): void => opts.onEvent?.(e);
    const maxSteps = opts.maxSteps ?? DEFAULTS.maxSteps;
    const maxWallMs = opts.maxWallMs ?? DEFAULTS.maxWallMs;
    const maxToolCalls = opts.maxToolCalls ?? DEFAULTS.maxToolCalls;
    const toolTimeoutMs = opts.toolTimeoutMs ?? DEFAULTS.toolTimeoutMs;
    const deadline = Date.now() + maxWallMs;

    const aborter = new AbortController();
    this.aborter = aborter;
    if (opts.signal) {
      if (opts.signal.aborted) aborter.abort();
      else opts.signal.addEventListener("abort", () => aborter.abort(), { once: true });
    }
    const signal = aborter.signal;

    const runtime = new ToolRuntime(this.tools, new PermissionStore(), {
      approve: opts.approve,
      onEvent: opts.onEvent,
      taskId,
      signal,
      toolTimeoutMs,
    });

    const filesChanged: FileChanges = { created: [], modified: [], deleted: [] };
    let inputTokens = 0;
    let outputTokens = 0;
    let steps = 0;
    let toolCalls = 0;
    let finalText = "";
    // sliding window of recent tool calls for loop detection
    const recent: string[] = [];

    const cancelled = (): RunResult => {
      emit({ type: "agent.cancelled", taskId });
      return {
        text: finalText,
        status: "cancelled",
        steps,
        toolCalls,
        inputTokens,
        outputTokens,
        filesChanged,
      };
    };
    const failed = (error: string): RunResult => {
      emit({ type: "agent.failed", taskId, error });
      return {
        text: finalText || error,
        status: "failed",
        steps,
        toolCalls,
        inputTokens,
        outputTokens,
        filesChanged,
      };
    };

    emit({ type: "agent.started", taskId, goal: task });
    emit({
      type: "agent.stage",
      taskId,
      stage: "understand",
      model: this.model ?? "",
      provider: this.provider.id,
    });

    const messages: ChatMessage[] = [
      { role: "system", content: this.systemPrompt },
      { role: "user", content: task },
    ];

    // one model turn, streamed. retries once on provider failure.
    const chatStep = async (): Promise<{ text: string; calls: ToolCall[] }> => {
      let text = "";
      const calls: ToolCall[] = [];
      const once = async (): Promise<void> => {
        for await (const ev of this.provider.chat(messages, {
          model: this.model ?? "",
          tools: this.tools.map((t) => t.def),
          signal,
        })) {
          if (ev.type === "text") {
            text += ev.delta;
            emit({ type: "agent.text", taskId, delta: ev.delta });
          } else if (ev.type === "toolCalls") {
            calls.push(...ev.calls);
          } else if (ev.type === "done") {
            inputTokens += ev.usage?.inputTokens ?? 0;
            outputTokens += ev.usage?.outputTokens ?? 0;
          }
        }
      };
      try {
        await once();
      } catch (err) {
        if (signal.aborted) throw err;
        const reason = err instanceof Error ? err.message : String(err);
        emit({ type: "agent.retrying", taskId, attempt: 1, reason });
        await sleep(1000);
        await once();
      }
      return { text, calls };
    };

    try {
      for (let step = 1; step <= maxSteps; step++) {
        if (signal.aborted) return cancelled();
        if (Date.now() > deadline) {
          return failed(`wall-clock limit exceeded (${maxWallMs}ms)`);
        }
        steps = step;

        let text: string;
        let calls: ToolCall[];
        try {
          ({ text, calls } = await chatStep());
        } catch (err) {
          if (signal.aborted) return cancelled();
          const reason = err instanceof Error ? err.message : String(err);
          return failed(`provider error after retry: ${reason}`);
        }
        if (text) finalText = text;
        if (calls.length === 0) break;

        // parse args up front; malformed calls become error results below
        const items = calls.map((call) => {
          const parsed = parseCallArgs(call);
          const key =
            call.name +
            ":" +
            (parsed.ok ? JSON.stringify(parsed.args) : "<malformed>");
          return { call, parsed, key };
        });
        for (const item of items) {
          recent.push(item.key);
          if (recent.length > 3) recent.shift();
        }
        if (
          recent.length === 3 &&
          recent[0] === recent[1] &&
          recent[1] === recent[2]
        ) {
          return failed(
            `stopped: loop detected, ${items[items.length - 1].call.name} ` +
              "called 3 times in a row with identical arguments"
          );
        }

        messages.push({
          role: "assistant",
          content: text,
          toolCalls: calls.map((c) => {
            const p = parseCallArgs(c);
            return { id: c.id, name: c.name, args: p.ok ? p.args : {} };
          }),
        });

        for (const item of items) {
          if (signal.aborted) return cancelled();
          if (Date.now() > deadline) {
            return failed(`wall-clock limit exceeded (${maxWallMs}ms)`);
          }
          if (toolCalls >= maxToolCalls) {
            return failed(`tool call limit exceeded (${maxToolCalls})`);
          }
          toolCalls++;

          if (!item.parsed.ok) {
            const error = `malformed tool call: ${item.parsed.error}`;
            emit({
              type: "agent.tool_requested",
              taskId,
              callId: item.call.id,
              tool: item.call.name,
            });
            emit({
              type: "agent.tool_failed",
              taskId,
              callId: item.call.id,
              tool: item.call.name,
              error,
            });
            messages.push({
              role: "tool",
              content: `tool error: ${error}`,
              toolCallId: item.call.id,
            });
            continue;
          }

          // track fs_write outcomes for the filesChanged report
          let existedBefore = false;
          const writePath =
            item.call.name === "fs_write" &&
            typeof item.parsed.args.path === "string"
              ? (item.parsed.args.path as string)
              : null;
          if (writePath) {
            try {
              await stat(writePath);
              existedBefore = true;
            } catch {
              existedBefore = false;
            }
          }

          const res = await runtime.execute(
            item.call.name,
            item.parsed.args,
            item.call.id
          );
          if (res.output === "cancelled") return cancelled();

          if (writePath && res.ok) {
            const list = existedBefore
              ? filesChanged.modified
              : filesChanged.created;
            if (!list.includes(writePath)) list.push(writePath);
          }
          messages.push({
            role: "tool",
            content: res.output,
            toolCallId: item.call.id,
          });
        }
      }
    } finally {
      if (this.aborter === aborter) this.aborter = null;
    }

    if (steps >= maxSteps) {
      return failed(`stopped after ${maxSteps} steps without finishing`);
    }
    emit({
      type: "agent.completed",
      taskId,
      summary: finalText.slice(0, 500),
      filesChanged,
    });
    return {
      text: finalText,
      status: "completed",
      steps,
      toolCalls,
      inputTokens,
      outputTokens,
      filesChanged,
    };
  }
}
