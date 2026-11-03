// approval hook: pre-action approval gate plus a reviewable action log.
//
// this extends silk's existing approval flow, it does not replace it.
// ToolRuntime (runtime.ts) is still the gate: every non-read tool call
// pauses with agent.waiting_for_approval and only runs after the approve
// callback returns an allow decision. a "deny" (or no approver at all)
// means the tool never runs.
//
// the hook wraps that approve callback so every paused action is
// recorded: the request, the decision, and the final outcome, in a plain
// local jsonl log. secret values are redacted before anything is written.

import { appendFileSync, mkdirSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  ApprovalDecision,
  ApprovalRequest,
} from "./runtime.js";
import type { SilkEvent } from "./events.js";

export type HookDecider = (
  req: ApprovalRequest
) => Promise<ApprovalDecision>;

export type LogPhase = "requested" | "decided" | "outcome";
export type LogOutcome =
  | "executing"
  | "executed"
  | "denied"
  | "failed"
  | "cancelled";

export interface LogEntry {
  ts: string;
  phase: LogPhase;
  callId: string;
  tool: string;
  level: string;
  summary: string;
  args: Record<string, unknown>;
  decision?: ApprovalDecision;
  outcome?: LogOutcome;
  detail?: string;
  ms?: number;
}

export interface ApprovalHookOptions {
  // the real approver: ui prompt, policy, or a scripted decider in tests.
  // whatever it returns is passed straight back to ToolRuntime, so a
  // "deny" still means the tool never runs.
  decide: HookDecider;
  // where the jsonl log lives. defaults to ~/.silk/approval-log.jsonl.
  logPath?: string;
}

// keys that always get redacted, matched case-insensitively
const SECRET_KEY =
  /password|passwd|secret|token|api[_-]?key|credentials?|auth|private[_-]?key|bearer|session/i;

// values that look like issued tokens even under innocent key names
const SECRET_VALUE =
  /^(sk-|ghp_|gho_|ghu_|xox[bap]-|AIza|ya29\.)[A-Za-z0-9\-_]{8,}$/;

export function redactValue(v: unknown): unknown {
  if (typeof v === "string") {
    return SECRET_VALUE.test(v) ? "[redacted]" : v;
  }
  if (Array.isArray(v)) return v.map(redactValue);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? "[redacted]" : redactValue(val);
    }
    return out;
  }
  return v;
}

function redactArgs(
  args: Record<string, unknown>
): Record<string, unknown> {
  return redactValue(args) as Record<string, unknown>;
}

// same shape as ToolRuntime's prompt summary, but built from redacted
// args so the log never carries secret values.
export function summarizeRedacted(
  tool: string,
  args: Record<string, unknown>
): string {
  const raw = JSON.stringify(redactArgs(args));
  return `${tool} ${raw.length > 120 ? raw.slice(0, 120) + "..." : raw}`;
}

function outcomeOf(error: string): LogOutcome {
  if (/denied by (user|policy)/.test(error)) return "denied";
  if (/cancelled/.test(error)) return "cancelled";
  return "failed";
}

export class ApprovalHook {
  private readonly logPath: string;
  private readonly decide: HookDecider;
  // callIds that actually paused for approval. outcome events for other
  // calls (e.g. read-level tools, which never ask) are not this hook's
  // business and stay out of the log.
  private readonly seen = new Set<string>();

  constructor(opts: ApprovalHookOptions) {
    this.decide = opts.decide;
    this.logPath =
      opts.logPath ?? path.join(os.homedir(), ".silk", "approval-log.jsonl");
    mkdirSync(path.dirname(this.logPath), { recursive: true });
  }

  get path(): string {
    return this.logPath;
  }

  private append(entry: Omit<LogEntry, "ts">): void {
    const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
    appendFileSync(this.logPath, line + "\n", "utf8");
  }

  // drop-in for ToolRuntimeOptions.approve. records the request, asks the
  // decider, records the decision, and hands the decision back to the
  // runtime, which enforces it.
  approver = async (req: ApprovalRequest): Promise<ApprovalDecision> => {
    const base = {
      callId: req.callId,
      tool: req.tool,
      level: req.level,
      // never log the runtime's raw summary: it embeds truncated args
      // that can carry secret values. rebuild it from redacted args.
      summary: summarizeRedacted(req.tool, req.args),
      args: redactArgs(req.args),
    };
    this.append({ phase: "requested", ...base });
    this.seen.add(req.callId);
    const decision = await this.decide(req);
    this.append({ phase: "decided", ...base, decision });
    return decision;
  };

  // drop-in for ToolRuntimeOptions.onEvent (compose with other handlers).
  // records the outcome once the runtime finishes the call. denied actions
  // never reach "executing": they fail with "denied by user/policy".
  onEvent = (e: SilkEvent): void => {
    const callId =
      e.type === "agent.tool_started" ||
      e.type === "agent.tool_completed" ||
      e.type === "agent.tool_failed"
        ? e.callId
        : null;
    if (!callId || !this.seen.has(callId)) return;
    if (e.type === "agent.tool_started") {
      this.append({
        phase: "outcome",
        callId: e.callId,
        tool: e.tool,
        level: "",
        summary: "",
        args: {},
        outcome: "executing",
      });
    } else if (e.type === "agent.tool_completed") {
      this.append({
        phase: "outcome",
        callId: e.callId,
        tool: e.tool,
        level: "",
        summary: "",
        args: {},
        outcome: "executed",
        ms: e.ms,
      });
    } else if (e.type === "agent.tool_failed") {
      this.append({
        phase: "outcome",
        callId: e.callId,
        tool: e.tool,
        level: "",
        summary: "",
        args: {},
        outcome: outcomeOf(e.error),
        detail: String(redactValue(e.error)).slice(0, 300),
      });
    }
  };
}
