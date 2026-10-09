// typed event protocol for silk. the ui renders agent state from these
// events only, never by sniffing text.

export type Stage =
  | "understand"
  | "plan"
  | "inspect"
  | "implement"
  | "test"
  | "review"
  | "fix"
  | "verify"
  | "complete";

export type StepStatus =
  | "pending"
  | "active"
  | "completed"
  | "failed"
  | "skipped";

export interface PlanStep {
  id: string;
  description: string;
  status: StepStatus;
}

export interface Plan {
  goal: string;
  steps: PlanStep[];
}

export interface FileChanges {
  created: string[];
  modified: string[];
  deleted: string[];
}

export type SilkEvent =
  | { type: "agent.started"; taskId: string; goal: string }
  | { type: "agent.planning"; taskId: string }
  | { type: "agent.plan_created"; taskId: string; plan: Plan }
  | {
      type: "agent.stage";
      taskId: string;
      stage: Stage;
      model: string;
      provider: string;
    }
  | { type: "agent.text"; taskId: string; delta: string }
  | {
      type: "agent.tool_requested";
      taskId: string;
      callId: string;
      tool: string;
    }
  | {
      type: "agent.tool_started";
      taskId: string;
      callId: string;
      tool: string;
    }
  | {
      type: "agent.tool_completed";
      taskId: string;
      callId: string;
      tool: string;
      ok: boolean;
      ms: number;
    }
  | {
      type: "agent.tool_failed";
      taskId: string;
      callId: string;
      tool: string;
      error: string;
    }
  | { type: "agent.retrying"; taskId: string; attempt: number; reason: string }
  | {
      type: "agent.waiting_for_approval";
      taskId: string;
      callId: string;
      tool: string;
      summary: string;
    }
  | { type: "agent.validation_started"; taskId: string }
  | {
      type: "agent.completed";
      taskId: string;
      summary: string;
      filesChanged: FileChanges;
    }
  | { type: "agent.failed"; taskId: string; error: string }
  | { type: "agent.cancelled"; taskId: string };
