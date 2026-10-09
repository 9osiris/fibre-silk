// ToolRuntime: the permission gate between the agent and tools.
// every tool call flows through here: policy check, approval, timeout,
// cancellation. tools never run unwatched.

import type { AgentTool } from "./agent.js";
import type { SilkEvent } from "./events.js";
import {
  TOOL_LEVELS,
  type PermissionStore,
  type PolicyLevel,
} from "./permissions.js";

export interface ToolResult {
  ok: boolean;
  output: string;
  ms: number;
}

export interface ApprovalRequest {
  callId: string;
  tool: string;
  args: Record<string, unknown>;
  level: PolicyLevel;
  summary: string;
}

export type ApprovalDecision =
  | "allow_once"
  | "allow_session"
  | "allow_always"
  | "deny";

export interface ToolRuntimeOptions {
  approve?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  onEvent?: (e: SilkEvent) => void;
  taskId?: string;
  signal?: AbortSignal;
  toolTimeoutMs?: number;
}

// short human-readable line for the approval prompt. never includes secrets,
// only the tool name and truncated args.
function summarize(tool: string, args: Record<string, unknown>): string {
  const raw = JSON.stringify(args);
  return `${tool} ${raw.length > 120 ? raw.slice(0, 120) + "..." : raw}`;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`tool timed out after ${ms}ms`)),
      ms
    );
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      }
    );
  });
}

// race a promise against abort; rejects with "cancelled" on abort
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal || signal.aborted) {
    return signal?.aborted ? Promise.reject(new Error("cancelled")) : p;
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("cancelled"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      }
    );
  });
}

export class ToolRuntime {
  constructor(
    private tools: AgentTool[],
    private store: PermissionStore,
    private opts: ToolRuntimeOptions = {}
  ) {}

  async execute(
    name: string,
    args: Record<string, unknown>,
    callId: string
  ): Promise<ToolResult> {
    const taskId = this.opts.taskId ?? "";
    const emit = (e: SilkEvent): void => this.opts.onEvent?.(e);
    const started = Date.now();
    emit({ type: "agent.tool_requested", taskId, callId, tool: name });

    const tool = this.tools.find((t) => t.def.name === name);
    if (!tool) {
      const error = `unknown tool: ${name}`;
      emit({ type: "agent.tool_failed", taskId, callId, tool: name, error });
      return {
        ok: false,
        output: `tool error: ${error}`,
        ms: Date.now() - started,
      };
    }

    const verdict = this.store.check(name);
    if (verdict === "deny") {
      emit({
        type: "agent.tool_failed",
        taskId,
        callId,
        tool: name,
        error: "denied by policy",
      });
      return {
        ok: false,
        output: "denied by policy",
        ms: Date.now() - started,
      };
    }

    if (verdict === "ask") {
      const summary = summarize(name, args);
      emit({
        type: "agent.waiting_for_approval",
        taskId,
        callId,
        tool: name,
        summary,
      });
      // no approver configured: never hang, treat as deny
      let decision: ApprovalDecision;
      try {
        decision = this.opts.approve
          ? await abortable(
              this.opts.approve({
                callId,
                tool: name,
                args,
                level: TOOL_LEVELS[name] ?? "execute",
                summary,
              }),
              this.opts.signal
            )
          : "deny";
      } catch {
        return {
          ok: false,
          output: "cancelled",
          ms: Date.now() - started,
        };
      }
      if (decision === "deny") {
        emit({
          type: "agent.tool_failed",
          taskId,
          callId,
          tool: name,
          error: "denied by user",
        });
        return {
          ok: false,
          output: "denied by user",
          ms: Date.now() - started,
        };
      }
      this.store.grant(name, decision);
    }

    if (this.opts.signal?.aborted) {
      return { ok: false, output: "cancelled", ms: Date.now() - started };
    }

    emit({ type: "agent.tool_started", taskId, callId, tool: name });
    const timeoutMs = this.opts.toolTimeoutMs ?? 120000;
    try {
      const output = await withTimeout(
        tool.run(args, { signal: this.opts.signal }),
        timeoutMs
      );
      const ms = Date.now() - started;
      this.store.consume(name);
      emit({
        type: "agent.tool_completed",
        taskId,
        callId,
        tool: name,
        ok: true,
        ms,
      });
      return { ok: true, output, ms };
    } catch (err) {
      const ms = Date.now() - started;
      this.store.consume(name);
      const message = err instanceof Error ? err.message : String(err);
      emit({
        type: "agent.tool_failed",
        taskId,
        callId,
        tool: name,
        error: message,
      });
      return { ok: false, output: `tool error: ${message}`, ms };
    }
  }
}
