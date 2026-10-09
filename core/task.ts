// task state machine. pure transitions, no invalid jumps.

import { randomUUID } from "node:crypto";

export type TaskStatus =
  | "queued"
  | "planning"
  | "executing"
  | "waiting_for_user"
  | "validating"
  | "interrupted"
  | "recovering"
  | "paused"
  | "completed"
  | "failed"
  | "cancelled";

export interface TaskState {
  id: string;
  goal: string;
  status: TaskStatus;
  stage?: string;
  startedAt: number;
}

const TERMINAL: TaskStatus[] = ["completed", "failed", "cancelled"];

const ALLOWED: Record<TaskStatus, TaskStatus[]> = {
  queued: ["planning", "executing", "interrupted", "cancelled"],
  planning: ["executing", "waiting_for_user", "failed", "interrupted", "cancelled"],
  executing: ["waiting_for_user", "validating", "completed", "failed", "paused", "interrupted", "cancelled"],
  waiting_for_user: ["executing", "interrupted", "cancelled"],
  validating: ["completed", "failed", "executing", "paused", "interrupted", "cancelled"],
  interrupted: ["recovering", "queued", "cancelled"],
  recovering: ["executing", "paused", "failed", "cancelled"],
  paused: ["executing", "interrupted", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function createTask(goal: string): TaskState {
  return { id: randomUUID(), goal, status: "queued", startedAt: Date.now() };
}

// returns a new state; throws on an invalid jump, terminal states never move
export function transition(task: TaskState, to: TaskStatus): TaskState {
  if (!ALLOWED[task.status].includes(to)) {
    throw new Error(`invalid task transition: ${task.status} -> ${to}`);
  }
  return { ...task, status: to };
}

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL.includes(status);
}
