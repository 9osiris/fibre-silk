// preload bridge exposed by the electron shell.
// in plain vite dev (no electron) window.silk is undefined and the ui
// falls back to a local stub defined in App.tsx.
// event shapes mirror core/events.ts; the old phase-1 AgentEvent is gone.

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

export interface PlanStep {
  id: string;
  description: string;
  state: "pending" | "active" | "completed" | "failed" | "skipped";
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
  | { type: "agent.tool_requested"; taskId: string; callId: string; tool: string }
  | { type: "agent.tool_started"; taskId: string; callId: string; tool: string }
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

export type PolicyLevel =
  | "read"
  | "write"
  | "execute"
  | "delete"
  | "network"
  | "git";

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

export interface OpenAISettingsView {
  apiKey: string; // always empty from main; set to save a new key
  baseUrl: string;
  model: string;
  keySet: boolean;
}

export interface AnthropicSettingsView {
  apiKey: string; // always empty from main; set to save a new key
  model: string;
  keySet: boolean;
}

export interface SilkConfig {
  providers: {
    openai?: OpenAISettingsView;
    anthropic?: AnthropicSettingsView;
  };
  activeProvider: "openai" | "anthropic";
  workspaceDir?: string;
}

export interface SessionView {
  id: string;
  title: string;
  status: string;
  workspaceId: string | null;
  messageCount?: number;
  messages?: Array<{ role: string; content: string }>;
  updatedAt: number;
}

export interface RecoveryTaskView {
  taskId: string;
  goal: string;
  stage: string;
  updatedAt: number;
  pendingApprovals: number;
  uncertainOps: number;
  decision: { canResume: boolean; reason: string; resumeStage: string | null };
}

export interface MemoryView {
  id: string;
  workspaceId: string | null;
  category: string;
  content: string;
  provenance: string;
  confidence: number;
  importance: number;
  createdAt: number;
  updatedAt: number;
}

export interface SilkBridge {
  chat(
    prompt: string,
    onEvent: (e: SilkEvent) => void,
    sessionId?: string
  ): Promise<{ text: string; sessionId?: string }>;
  getSettings(): Promise<SilkConfig>;
  saveSettings(patch: Partial<SilkConfig>): Promise<SilkConfig>;
  testProvider(): Promise<{ ok: boolean; message: string }>;
  onApprovalRequest(cb: (req: ApprovalRequest) => void): void;
  answerApproval(callId: string, decision: ApprovalDecision): void;
  listSessions(): Promise<SessionView[]>;
  getSession(id: string): Promise<SessionView | null>;
  deleteSession(id: string): Promise<{ ok: boolean }>;
  renameSession(id: string, title: string): Promise<{ ok: boolean }>;
  listRecovery(): Promise<RecoveryTaskView[]>;
  getRecoveryReport(taskId: string): Promise<unknown>;
  recoveryAction(
    op: "resume" | "restart" | "abandon",
    taskId: string
  ): Promise<{ ok: boolean; message?: string; runId?: string }>;
  onChatEvent(runId: string, onEvent: (e: SilkEvent) => void): () => void;
  listMemory(query?: string): Promise<MemoryView[]>;
  createMemory(input: {
    category: string;
    content: string;
    provenance?: string;
  }): Promise<{ ok: boolean; message?: string }>;
  deleteMemory(id: string): Promise<{ ok: boolean }>;
}

declare global {
  interface Window {
    silk?: SilkBridge;
  }
}

export {};
