// exposes a safe api to the renderer, no node access in the ui
import { contextBridge, ipcRenderer } from "electron";
import type { SilkEvent } from "../core/events.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
} from "../core/runtime.js";
import type { SilkConfig } from "../core/config.js";

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

export interface SilkApi {
  chat(
    prompt: string,
    onEvent: (event: SilkEvent) => void,
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
  onChatEvent(runId: string, onEvent: (event: SilkEvent) => void): () => void;
  listMemory(query?: string): Promise<MemoryView[]>;
  createMemory(input: {
    category: string;
    content: string;
    provenance?: string;
  }): Promise<{ ok: boolean; message?: string }>;
  deleteMemory(id: string): Promise<{ ok: boolean }>;
}

// events arriving from main, tagged with the chat run they belong to.
// also tolerates the old phase-1 terminal event ("done") until core
// finishes its rewrite to SilkEvents.
type Incoming = { runId: string; text?: string } & (
  | SilkEvent
  | { type: "text"; delta: string }
  | { type: "done"; text: string }
  | { type: "error"; text: string }
);

const silk: SilkApi = {
  chat(prompt, onEvent, sessionId) {
    const runId = crypto.randomUUID();
    return new Promise<{ text: string; sessionId?: string }>((resolve, reject) => {
      let text = "";
      let outSessionId: string | undefined = sessionId;
      const cleanup = (): void => {
        ipcRenderer.removeListener("silk:chat-event", listener);
      };
      const listener = (_event: unknown, msg: Incoming): void => {
        if (!msg || msg.runId !== runId) return;
        if (msg.type === "error") {
          cleanup();
          reject(new Error(msg.text ?? "chat failed"));
          return;
        }
        if (msg.type === "agent.text" || msg.type === "text") {
          text += msg.delta;
        }
        if (msg.type === "agent.completed" || msg.type === "done") {
          onEvent(msg as SilkEvent);
          cleanup();
          const summary =
            msg.type === "agent.completed" ? msg.summary : undefined;
          resolve({ text: summary ?? (msg.type === "done" ? (msg.text ?? text) : text), sessionId: outSessionId });
          return;
        }
        if (msg.type === "agent.failed") {
          onEvent(msg);
          cleanup();
          reject(new Error(msg.error || "agent failed"));
          return;
        }
        if (msg.type === "agent.cancelled") {
          onEvent(msg);
          cleanup();
          resolve({ text, sessionId: outSessionId });
          return;
        }
        onEvent(msg as SilkEvent);
      };
      ipcRenderer.on("silk:chat-event", listener);
      ipcRenderer
        .invoke("silk:chat", { runId, prompt, sessionId })
        .then((res: { sessionId?: string }) => {
          if (res?.sessionId) outSessionId = res.sessionId;
        })
        .catch((err: unknown) => {
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  },
  getSettings() {
    return ipcRenderer.invoke("silk:settings", "get");
  },
  saveSettings(patch) {
    return ipcRenderer.invoke("silk:settings", "set", patch);
  },
  testProvider() {
    return ipcRenderer.invoke("silk:test-provider");
  },
  onApprovalRequest(cb) {
    ipcRenderer.on("silk:approval-request", (_event, req: ApprovalRequest) => {
      cb(req);
    });
  },
  answerApproval(callId, decision) {
    ipcRenderer.send("silk:approval-response", { callId, decision });
  },
  listSessions() {
    return ipcRenderer.invoke("silk:sessions", "list");
  },
  getSession(id) {
    return ipcRenderer.invoke("silk:sessions", "get", id);
  },
  deleteSession(id) {
    return ipcRenderer.invoke("silk:sessions", "delete", id);
  },
  renameSession(id, title) {
    return ipcRenderer.invoke("silk:sessions", "rename", `${id}|${title}`);
  },
  listRecovery() {
    return ipcRenderer.invoke("silk:recovery", "list");
  },
  getRecoveryReport(taskId) {
    return ipcRenderer.invoke("silk:recovery", "report", taskId);
  },
  recoveryAction(op, taskId) {
    return ipcRenderer.invoke("silk:recovery", op, taskId);
  },
  onChatEvent(runId, onEvent) {
    const listener = (_event: unknown, msg: Incoming): void => {
      if (!msg || msg.runId !== runId) return;
      onEvent(msg as SilkEvent);
    };
    ipcRenderer.on("silk:chat-event", listener);
    return () => ipcRenderer.removeListener("silk:chat-event", listener);
  },
  listMemory(query) {
    return ipcRenderer.invoke("silk:memory", "list", query ?? "");
  },
  createMemory(input) {
    return ipcRenderer.invoke("silk:memory", "create", input);
  },
  deleteMemory(id) {
    return ipcRenderer.invoke("silk:memory", "delete", id);
  },
};

contextBridge.exposeInMainWorld("silk", silk);

declare global {
  interface Window {
    silk: SilkApi;
  }
}
