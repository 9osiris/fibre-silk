// crash recovery: find tasks that were active when the app stopped,
// mark them interrupted (never completed), and rebuild enough context
// to resume safely from a checkpoint.
import type {
  FibreStore,
  TaskRecord,
  ApprovalRecord,
  CheckpointRecord,
} from "./store.js";
import { gitStatus } from "./git.js";
import { existsSync } from "node:fs";

export interface UncertainOp {
  callId: string;
  tool: string;
  summary: string;
}

export interface RecoveryReport {
  task: TaskRecord;
  checkpoint: CheckpointRecord | null;
  pendingApprovals: ApprovalRecord[];
  uncertainOps: UncertainOp[];
  completedOps: number;
  gitFiles: string[] | null; // null when no workspace or not a repo
  workspaceExists: boolean;
}

export interface RecoveryDecision {
  taskId: string;
  canResume: boolean;
  reason: string;
  resumeStage: string | null;
}

// startup reconciliation: every non-terminal task was interrupted.
// nothing is ever auto-completed or auto-rerun here.
export function reconcileInterrupted(store: FibreStore): TaskRecord[] {
  const active = store.listUnfinishedTasks();
  const out: TaskRecord[] = [];
  for (const t of active) {
    const updated = store.updateTask(t.id, { status: "interrupted" });
    store.appendEvent(t.id, "recovery.attempted", {
      fromStatus: t.status,
      stage: t.stage,
    });
    if (updated) out.push(updated);
  }
  return out;
}

// rebuild the recovery picture for one interrupted task
export async function buildRecoveryReport(
  store: FibreStore,
  taskId: string
): Promise<RecoveryReport | null> {
  const task = store.getTask(taskId);
  if (!task) return null;
  const checkpoint = store.latestCheckpoint(taskId);
  const pendingApprovals = store.listApprovals(taskId, "pending");

  // ops with a durable start but no completion are uncertain
  const events = store.listEvents(taskId);
  const started = new Map<string, { tool: string }>();
  const finished = new Set<string>();
  let completedOps = 0;
  for (const e of events) {
    const callId = typeof e.payload.callId === "string" ? e.payload.callId : "";
    if (e.type === "agent.tool_started" && callId) {
      started.set(callId, { tool: String(e.payload.tool ?? "") });
    }
    if ((e.type === "agent.tool_completed" || e.type === "agent.tool_failed") && callId) {
      finished.add(callId);
      completedOps += 1;
    }
  }
  const uncertainOps: UncertainOp[] = [];
  for (const [callId, info] of started) {
    if (!finished.has(callId)) {
      uncertainOps.push({
        callId,
        tool: info.tool,
        summary: "started before the interruption, outcome unknown",
      });
    }
  }

  // reconcile against the real workspace
  let gitFiles: string[] | null = null;
  let workspaceExists = false;
  if (task.workspaceId) {
    const ws = store.getWorkspace(task.workspaceId);
    if (ws && existsSync(ws.rootPath)) {
      workspaceExists = true;
      try {
        gitFiles = (await gitStatus(ws.rootPath)).files;
      } catch {
        gitFiles = null;
      }
    }
  }

  return { task, checkpoint, pendingApprovals, uncertainOps, completedOps, gitFiles, workspaceExists };
}

// decide whether a task can resume, and from where. conservative:
// unknown workspace state or unresolved uncertainty blocks auto-resume.
export function recoveryDecision(report: RecoveryReport): RecoveryDecision {
  const { task, checkpoint, workspaceExists } = report;
  if (task.status !== "interrupted") {
    return { taskId: task.id, canResume: false, reason: "task is not interrupted", resumeStage: null };
  }
  if (!checkpoint) {
    return {
      taskId: task.id,
      canResume: false,
      reason: "no checkpoint; restart from the beginning or abandon",
      resumeStage: null,
    };
  }
  if (task.workspaceId && !workspaceExists) {
    return {
      taskId: task.id,
      canResume: false,
      reason: "workspace no longer exists at its recorded path",
      resumeStage: null,
    };
  }
  const resumeStage =
    checkpoint.stage === "test" || checkpoint.stage === "review" || checkpoint.stage === "verify"
      ? checkpoint.stage
      : "implement";
  return {
    taskId: task.id,
    canResume: true,
    reason: report.uncertainOps.length
      ? `resumable with ${report.uncertainOps.length} uncertain operation(s) to inspect first`
      : "resumable from checkpoint",
    resumeStage,
  };
}

// user actions. resume is only a state change; the coding loop does
// the actual work when the integration layer re-invokes it.
export function markResuming(store: FibreStore, taskId: string): TaskRecord | null {
  const t = store.getTask(taskId);
  if (!t || t.status !== "interrupted") return null;
  const next = store.updateTask(taskId, { status: "recovering", finishedAt: null, error: null });
  store.appendEvent(taskId, "recovery.resumed", { stage: t.stage });
  return next;
}

export function abandonTask(store: FibreStore, taskId: string): TaskRecord | null {
  const t = store.getTask(taskId);
  if (!t) return null;
  const next = store.updateTask(taskId, {
    status: "cancelled",
    finishedAt: Date.now(),
    error: "abandoned after interruption",
  });
  store.appendEvent(taskId, "agent.cancelled", { reason: "abandoned after interruption" });
  return next;
}

export function restartTask(store: FibreStore, taskId: string): TaskRecord | null {
  const t = store.getTask(taskId);
  if (!t) return null;
  return store.updateTask(taskId, {
    status: "queued",
    stage: "",
    plan: null,
    finishedAt: null,
    error: null,
    filesChanged: { created: [], modified: [], deleted: [] },
  });
}
