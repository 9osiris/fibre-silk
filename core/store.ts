// durable local storage for fibre. real sqlite via sql.js (wasm), so
// there are no native modules to build on windows. the database lives
// in memory and is exported atomically after mutations.
import initSqlJs from "sql.js";
import type { Database, SqlJsStatic } from "sql.js";
import {
  copyFileSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  closeSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { TaskStatus } from "./task.js";
import type { FileChanges, Plan } from "./events.js";
import type { ApprovalDecision } from "./runtime.js";
import type { PolicyLevel } from "./permissions.js";

export interface DiagnosticEvent {
  kind: string;
  message: string;
  taskId?: string;
}

export interface SessionRecord {
  id: string;
  title: string;
  workspaceId: string | null;
  status: "active" | "archived";
  config: Record<string, unknown>;
  messages: Array<{ role: string; content: string }>;
  createdAt: number;
  updatedAt: number;
}

export interface TaskRecord {
  id: string;
  sessionId: string | null;
  workspaceId: string | null;
  goal: string;
  status: TaskStatus;
  stage: string;
  plan: Plan | null;
  model: { model: string; provider: string } | null;
  filesChanged: FileChanges;
  error: string | null;
  createdAt: number;
  updatedAt: number;
  finishedAt: number | null;
}

export interface EventRecord {
  id: number;
  taskId: string;
  seq: number;
  ts: number;
  type: string;
  payload: Record<string, unknown>;
}

export interface ApprovalRecord {
  id: string;
  taskId: string;
  callId: string;
  tool: string;
  level: PolicyLevel;
  summary: string;
  args: Record<string, unknown>;
  status: "pending" | "decided";
  decision: ApprovalDecision | null;
  createdAt: number;
  resolvedAt: number | null;
}

export type MemoryCategory =
  | "project_fact"
  | "architecture_decision"
  | "convention"
  | "user_preference"
  | "known_issue"
  | "task_knowledge";

export type MemoryProvenance =
  | "user_statement"
  | "repo_observed"
  | "test_verified"
  | "model_inference"
  | "unverified";

export interface MemoryRecord {
  id: string;
  workspaceId: string | null;
  category: MemoryCategory;
  content: string;
  provenance: MemoryProvenance;
  confidence: number; // 0..1
  importance: number; // 0..1
  supersededBy: string | null;
  source: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number | null;
}

export interface WorkspaceRecord {
  id: string;
  rootPath: string;
  displayName: string;
  info: Record<string, unknown> | null;
  index: Record<string, unknown> | null;
  lastScan: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface CheckpointRecord {
  id: number;
  taskId: string;
  stage: string;
  state: Record<string, unknown>;
  createdAt: number;
}

// event types worth keeping across restarts. high-frequency ui updates
// (text deltas, retries) are not journaled.
export const DURABLE_EVENTS = new Set([
  "agent.started",
  "agent.plan_created",
  "agent.stage",
  "agent.tool_started",
  "agent.tool_completed",
  "agent.tool_failed",
  "agent.waiting_for_approval",
  "agent.completed",
  "agent.failed",
  "agent.cancelled",
  "recovery.attempted",
  "recovery.resumed",
  "checkpoint.created",
]);

const MIGRATIONS: Array<{ version: number; sql: string }> = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS schema_meta (version INTEGER NOT NULL);
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, workspace_id TEXT,
        status TEXT NOT NULL, config_json TEXT NOT NULL,
        messages_json TEXT NOT NULL, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY, session_id TEXT, workspace_id TEXT,
        goal TEXT NOT NULL, status TEXT NOT NULL, stage TEXT NOT NULL,
        plan_json TEXT, model_json TEXT, files_json TEXT NOT NULL,
        error TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        finished_at INTEGER
      );
      CREATE INDEX idx_tasks_status ON tasks(status);
      CREATE INDEX idx_tasks_session ON tasks(session_id);
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
        seq INTEGER NOT NULL, ts INTEGER NOT NULL, type TEXT NOT NULL,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX idx_events_task ON events(task_id, seq);
      CREATE TABLE approvals (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, call_id TEXT NOT NULL,
        tool TEXT NOT NULL, level TEXT NOT NULL, summary TEXT NOT NULL,
        args_json TEXT NOT NULL, status TEXT NOT NULL, decision TEXT,
        created_at INTEGER NOT NULL, resolved_at INTEGER
      );
      CREATE INDEX idx_approvals_task ON approvals(task_id, status);
      CREATE TABLE checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT, task_id TEXT NOT NULL,
        stage TEXT NOT NULL, state_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE INDEX idx_checkpoints_task ON checkpoints(task_id, id);
      CREATE TABLE memories (
        id TEXT PRIMARY KEY, workspace_id TEXT, category TEXT NOT NULL,
        content TEXT NOT NULL, provenance TEXT NOT NULL,
        confidence REAL NOT NULL, importance REAL NOT NULL,
        superseded_by TEXT, source TEXT NOT NULL,
        created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        expires_at INTEGER
      );
      CREATE INDEX idx_memories_ws ON memories(workspace_id, category);
      CREATE TABLE workspaces (
        id TEXT PRIMARY KEY, root_path TEXT NOT NULL UNIQUE,
        display_name TEXT NOT NULL, info_json TEXT, index_json TEXT,
        last_scan INTEGER, created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `,
  },
];

let SQL: SqlJsStatic | null = null;

// find the sql.js wasm binary across dev, test, and packaged layouts
function loadWasmBinary(): ArrayBuffer {
  // electron-builder ships the wasm via extraResources, so packaged builds find it under process.resourcesPath
  const resourcesPath = (process as unknown as { resourcesPath?: string }).resourcesPath;
  const candidates = [
    ...(resourcesPath ? [path.join(resourcesPath, "sql-wasm.wasm")] : []),
    path.join(process.cwd(), "core", "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
    path.join(process.cwd(), "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
    path.join(path.dirname(new URL(import.meta.url).pathname), "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
    path.join(path.dirname(new URL(import.meta.url).pathname), "..", "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
    path.join(path.dirname(new URL(import.meta.url).pathname), "..", "core", "node_modules", "sql.js", "dist", "sql-wasm.wasm"),
  ];
  for (const c of candidates) {
    if (existsSync(c)) {
      const buf = readFileSync(c);
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
    }
  }
  throw new Error("sql.js wasm binary not found in any known location");
}

async function sqlRuntime(): Promise<SqlJsStatic> {
  if (!SQL) {
    SQL = await initSqlJs({ wasmBinary: loadWasmBinary() });
  }
  return SQL;
}

function json(v: unknown): string {
  return JSON.stringify(v ?? null);
}

function parse<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export interface StoreOptions {
  onDiagnostic?: (e: DiagnosticEvent) => void;
  fileName?: string;
}

export class FibreStore {
  private db: Database;
  private dir: string;
  private file: string;
  private dirty = false;
  private flushTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;
  private onDiagnostic: (e: DiagnosticEvent) => void;

  private constructor(
    db: Database,
    dir: string,
    fileName: string,
    onDiagnostic: (e: DiagnosticEvent) => void
  ) {
    this.db = db;
    this.dir = dir;
    this.file = path.join(dir, fileName);
    this.onDiagnostic = onDiagnostic;
  }

  // open (or create) the database in dir. corrupt files are quarantined
  // and the last-good backup is used; the app never crashes on bad data.
  static async open(dir: string, opts: StoreOptions = {}): Promise<FibreStore> {
    const diag = opts.onDiagnostic ?? (() => {});
    const SQL = await sqlRuntime();
    mkdirSync(dir, { recursive: true });
    const fileName = opts.fileName ?? "fibre.db";
    const file = path.join(dir, fileName);
    const bak = file + ".bak";
    let db: Database | null = null;
    if (existsSync(file)) {
      try {
        const candidate = new SQL.Database(new Uint8Array(readFileSync(file)));
        // sql.js validates lazily; probe now so corruption is caught here
        candidate.exec("SELECT name FROM sqlite_master LIMIT 1");
        db = candidate;
      } catch (err) {
        diag({
          kind: "store.corrupt",
          message: `database corrupt, quarantined: ${err instanceof Error ? err.message : String(err)}`,
        });
        try {
          renameSync(file, `${file}.corrupt-${Date.now()}`);
        } catch {
          // quarantine is best effort
        }
        if (existsSync(bak)) {
          try {
            const restored = new SQL.Database(new Uint8Array(readFileSync(bak)));
            restored.exec("SELECT name FROM sqlite_master LIMIT 1");
            db = restored;
            diag({ kind: "store.recovered", message: "restored from last-good backup" });
          } catch {
            db = null;
          }
        }
      }
    }
    if (!db) db = new SQL.Database();
    const store = new FibreStore(db, dir, fileName, diag);
    store.migrate();
    store.persistNow();
    return store;
  }

  private migrate(): void {
    this.db.exec("BEGIN");
    try {
      const has = this.db.exec(
        "SELECT name FROM sqlite_master WHERE type='table' AND name='schema_meta'"
      );
      let version = 0;
      if (has.length > 0) {
        const rows = this.db.exec("SELECT version FROM schema_meta LIMIT 1");
        if (rows.length > 0) version = Number(rows[0].values[0][0]);
      }
      for (const m of MIGRATIONS) {
        if (version < m.version) {
          this.db.exec(m.sql);
          this.db.exec("DELETE FROM schema_meta");
          this.db.exec(`INSERT INTO schema_meta VALUES (${m.version})`);
          version = m.version;
        }
      }
      this.db.exec("COMMIT");
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
    this.dirty = true;
  }

  // run a mutation transactionally and schedule an atomic export
  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      this.markDirty();
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      try {
        this.persistNow();
      } catch (err) {
        this.onDiagnostic({
          kind: "store.persist_failed",
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }, 25);
  }

  // atomic export: tmp file, fsync, rotate .bak, rename into place
  persistNow(): void {
    if (this.closed) return;
    const bytes = this.db.export();
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, Buffer.from(bytes));
    const fd = openSync(tmp, "r");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    if (existsSync(this.file)) {
      try {
        copyFileSync(this.file, this.file + ".bak");
      } catch {
        // backup rotation is best effort
      }
    }
    renameSync(tmp, this.file);
    this.dirty = false;
  }

  flush(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (this.dirty) this.persistNow();
  }

  close(): void {
    this.flush();
    this.closed = true;
    try {
      this.db.close();
    } catch {
      // already closed
    }
  }

  get filePath(): string {
    return this.file;
  }

  // copy the live database file to destDir for backup
  backupTo(destDir: string): string {
    this.flush();
    mkdirSync(destDir, { recursive: true });
    const dest = path.join(destDir, path.basename(this.file));
    copyFileSync(this.file, dest);
    return dest;
  }

  // usage snapshot for storage reporting
  stats(): { fileBytes: number; sessions: number; tasks: number; events: number; memories: number; workspaces: number } {
    const count = (t: string): number => {
      const r = this.db.exec(`SELECT COUNT(*) FROM ${t}`);
      return r.length ? Number(r[0].values[0][0]) : 0;
    };
    return {
      fileBytes: existsSync(this.file) ? statSync(this.file).size : 0,
      sessions: count("sessions"),
      tasks: count("tasks"),
      events: count("events"),
      memories: count("memories"),
      workspaces: count("workspaces"),
    };
  }

  // full json dump for export
  exportAll(): string {
    const dump = (t: string): unknown[] => {
      const r = this.db.exec(`SELECT * FROM ${t}`);
      if (!r.length) return [];
      const cols = r[0].columns;
      return r[0].values.map((row) => {
        const o: Record<string, unknown> = {};
        cols.forEach((c, i) => (o[c] = row[i]));
        return o;
      });
    };
    return JSON.stringify(
      {
        exportedAt: new Date().toISOString(),
        sessions: dump("sessions"),
        tasks: dump("tasks"),
        events: dump("events"),
        approvals: dump("approvals"),
        checkpoints: dump("checkpoints"),
        memories: dump("memories"),
        workspaces: dump("workspaces"),
      },
      null,
      2
    );
  }

  // ---- sessions ----

  createSession(input: {
    title: string;
    workspaceId?: string | null;
    config?: Record<string, unknown>;
  }): SessionRecord {
    const now = Date.now();
    const rec: SessionRecord = {
      id: randomUUID(),
      title: input.title,
      workspaceId: input.workspaceId ?? null,
      status: "active",
      config: input.config ?? {},
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    this.tx(() =>
      this.db.run(
        "INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)",
        [rec.id, rec.title, rec.workspaceId, rec.status, json(rec.config), json(rec.messages), rec.createdAt, rec.updatedAt]
      )
    );
    return rec;
  }

  getSession(id: string): SessionRecord | null {
    const r = this.db.exec("SELECT * FROM sessions WHERE id = ?", [id]);
    return r.length && r[0].values.length ? this.rowToSession(r[0].columns, r[0].values[0]) : null;
  }

  listSessions(limit = 100): SessionRecord[] {
    const r = this.db.exec("SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?", [limit]);
    if (!r.length) return [];
    return r[0].values.map((v) => this.rowToSession(r[0].columns, v));
  }

  updateSession(
    id: string,
    patch: Partial<Pick<SessionRecord, "title" | "status" | "messages" | "config" | "workspaceId">>
  ): SessionRecord | null {
    const cur = this.getSession(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, updatedAt: Date.now() };
    this.tx(() =>
      this.db.run(
        "UPDATE sessions SET title=?, workspace_id=?, status=?, config_json=?, messages_json=?, updated_at=? WHERE id=?",
        [next.title, next.workspaceId, next.status, json(next.config), json(next.messages), next.updatedAt, id]
      )
    );
    return next;
  }

  deleteSession(id: string): void {
    this.tx(() => this.db.run("DELETE FROM sessions WHERE id = ?", [id]));
  }

  private rowToSession(cols: string[], v: unknown[]): SessionRecord {
    const o: Record<string, unknown> = {};
    cols.forEach((c, i) => (o[c] = v[i]));
    return {
      id: String(o.id),
      title: String(o.title),
      workspaceId: (o.workspace_id as string) ?? null,
      status: o.status === "archived" ? "archived" : "active",
      config: parse(o.config_json as string, {}),
      messages: parse(o.messages_json as string, []),
      createdAt: Number(o.created_at),
      updatedAt: Number(o.updated_at),
    };
  }

  // ---- tasks ----

  createTask(input: {
    id?: string;
    sessionId?: string | null;
    workspaceId?: string | null;
    goal: string;
  }): TaskRecord {
    const now = Date.now();
    const rec: TaskRecord = {
      id: input.id ?? randomUUID(),
      sessionId: input.sessionId ?? null,
      workspaceId: input.workspaceId ?? null,
      goal: input.goal,
      status: "queued",
      stage: "",
      plan: null,
      model: null,
      filesChanged: { created: [], modified: [], deleted: [] },
      error: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    this.tx(() =>
      this.db.run(
        "INSERT INTO tasks VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
        [rec.id, rec.sessionId, rec.workspaceId, rec.goal, rec.status, rec.stage, null, null, json(rec.filesChanged), null, rec.createdAt, rec.updatedAt, null]
      )
    );
    return rec;
  }

  getTask(id: string): TaskRecord | null {
    const r = this.db.exec("SELECT * FROM tasks WHERE id = ?", [id]);
    return r.length && r[0].values.length ? this.rowToTask(r[0].columns, r[0].values[0]) : null;
  }

  listTasks(filter: { sessionId?: string; status?: TaskStatus; limit?: number } = {}): TaskRecord[] {
    let sql = "SELECT * FROM tasks";
    const args: unknown[] = [];
    const where: string[] = [];
    if (filter.sessionId) {
      where.push("session_id = ?");
      args.push(filter.sessionId);
    }
    if (filter.status) {
      where.push("status = ?");
      args.push(filter.status);
    }
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY updated_at DESC LIMIT ?";
    args.push(filter.limit ?? 100);
    const r = this.db.exec(sql, args as never[]);
    if (!r.length) return [];
    return r[0].values.map((v) => this.rowToTask(r[0].columns, v));
  }

  // tasks not in a terminal state. at startup these are interrupted.
  listUnfinishedTasks(): TaskRecord[] {
    const r = this.db.exec(
      "SELECT * FROM tasks WHERE status NOT IN ('completed','failed','cancelled','interrupted') ORDER BY updated_at DESC"
    );
    if (!r.length) return [];
    return r[0].values.map((v) => this.rowToTask(r[0].columns, v));
  }

  listInterruptedTasks(): TaskRecord[] {
    return this.listTasks({ status: "interrupted" as TaskStatus });
  }

  updateTask(
    id: string,
    patch: Partial<Pick<TaskRecord, "status" | "stage" | "plan" | "model" | "filesChanged" | "error" | "finishedAt">>
  ): TaskRecord | null {
    const cur = this.getTask(id);
    if (!cur) return null;
    const next: TaskRecord = { ...cur, ...patch, updatedAt: Date.now() };
    this.tx(() =>
      this.db.run(
        "UPDATE tasks SET status=?, stage=?, plan_json=?, model_json=?, files_json=?, error=?, updated_at=?, finished_at=? WHERE id=?",
        [next.status, next.stage, json(next.plan), json(next.model), json(next.filesChanged), next.error, next.updatedAt, next.finishedAt, id]
      )
    );
    return next;
  }

  deleteTask(id: string): void {
    this.tx(() => {
      this.db.run("DELETE FROM tasks WHERE id = ?", [id]);
      this.db.run("DELETE FROM events WHERE task_id = ?", [id]);
      this.db.run("DELETE FROM approvals WHERE task_id = ?", [id]);
      this.db.run("DELETE FROM checkpoints WHERE task_id = ?", [id]);
    });
  }

  private rowToTask(cols: string[], v: unknown[]): TaskRecord {
    const o: Record<string, unknown> = {};
    cols.forEach((c, i) => (o[c] = v[i]));
    return {
      id: String(o.id),
      sessionId: (o.session_id as string) ?? null,
      workspaceId: (o.workspace_id as string) ?? null,
      goal: String(o.goal),
      status: String(o.status) as TaskStatus,
      stage: String(o.stage),
      plan: parse(o.plan_json as string, null),
      model: parse(o.model_json as string, null),
      filesChanged: parse(o.files_json as string, { created: [], modified: [], deleted: [] }),
      error: (o.error as string) ?? null,
      createdAt: Number(o.created_at),
      updatedAt: Number(o.updated_at),
      finishedAt: o.finished_at == null ? null : Number(o.finished_at),
    };
  }

  // ---- events ----

  appendEvent(taskId: string, type: string, payload: Record<string, unknown>): EventRecord | null {
    if (!DURABLE_EVENTS.has(type)) return null;
    let rec: EventRecord | null = null;
    this.tx(() => {
      const r = this.db.exec("SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE task_id = ?", [taskId]);
      const seq = (r.length ? Number(r[0].values[0][0]) : 0) + 1;
      const ts = Date.now();
      this.db.run("INSERT INTO events (task_id, seq, ts, type, payload_json) VALUES (?,?,?,?,?)", [
        taskId,
        seq,
        ts,
        type,
        json(payload),
      ]);
      const idr = this.db.exec("SELECT last_insert_rowid() AS id");
      rec = { id: Number(idr[0].values[0][0]), taskId, seq, ts, type, payload };
    });
    return rec;
  }

  listEvents(taskId: string, afterSeq = 0, limit = 1000): EventRecord[] {
    const r = this.db.exec(
      "SELECT * FROM events WHERE task_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
      [taskId, afterSeq, limit]
    );
    if (!r.length) return [];
    return r[0].values.map((v) => {
      const o: Record<string, unknown> = {};
      r[0].columns.forEach((c, i) => (o[c] = v[i]));
      return {
        id: Number(o.id),
        taskId: String(o.task_id),
        seq: Number(o.seq),
        ts: Number(o.ts),
        type: String(o.type),
        payload: parse(o.payload_json as string, {}),
      };
    });
  }

  // retention: keep only the most recent N events per task
  pruneEvents(taskId: string, keepLast = 500): number {
    let removed = 0;
    this.tx(() => {
      const r = this.db.exec("SELECT COUNT(*) FROM events WHERE task_id = ?", [taskId]);
      const total = r.length ? Number(r[0].values[0][0]) : 0;
      if (total > keepLast) {
        this.db.run(
          "DELETE FROM events WHERE task_id = ? AND id NOT IN (SELECT id FROM events WHERE task_id = ? ORDER BY seq DESC LIMIT ?)",
          [taskId, taskId, keepLast]
        );
        removed = total - keepLast;
      }
    });
    return removed;
  }

  // ---- approvals ----

  createApproval(input: {
    taskId: string;
    callId: string;
    tool: string;
    level: PolicyLevel;
    summary: string;
    args: Record<string, unknown>;
  }): ApprovalRecord {
    const rec: ApprovalRecord = {
      id: randomUUID(),
      ...input,
      status: "pending",
      decision: null,
      createdAt: Date.now(),
      resolvedAt: null,
    };
    this.tx(() =>
      this.db.run("INSERT INTO approvals VALUES (?,?,?,?,?,?,?,?,?,?,?)", [
        rec.id, rec.taskId, rec.callId, rec.tool, rec.level, rec.summary, json(rec.args), rec.status, null, rec.createdAt, null,
      ])
    );
    return rec;
  }

  resolveApproval(id: string, decision: ApprovalDecision): ApprovalRecord | null {
    const rows = this.db.exec("SELECT * FROM approvals WHERE id = ?", [id]);
    if (!rows.length || !rows[0].values.length) return null;
    const now = Date.now();
    this.tx(() =>
      this.db.run("UPDATE approvals SET status='decided', decision=?, resolved_at=? WHERE id=?", [decision, now, id])
    );
    const after = this.db.exec("SELECT * FROM approvals WHERE id = ?", [id]);
    const o: Record<string, unknown> = {};
    after[0].columns.forEach((c, i) => (o[c] = after[0].values[0][i]));
    return {
      id: String(o.id),
      taskId: String(o.task_id),
      callId: String(o.call_id),
      tool: String(o.tool),
      level: String(o.level) as PolicyLevel,
      summary: String(o.summary),
      args: parse(o.args_json as string, {}),
      status: "decided",
      decision: String(o.decision) as ApprovalDecision,
      createdAt: Number(o.created_at),
      resolvedAt: Number(o.resolved_at),
    };
  }

  listApprovals(taskId: string, status?: "pending" | "decided"): ApprovalRecord[] {
    const sql = status
      ? "SELECT * FROM approvals WHERE task_id = ? AND status = ? ORDER BY created_at ASC"
      : "SELECT * FROM approvals WHERE task_id = ? ORDER BY created_at ASC";
    const args = status ? [taskId, status] : [taskId];
    const r = this.db.exec(sql, args as never[]);
    if (!r.length) return [];
    return r[0].values.map((v) => {
      const o: Record<string, unknown> = {};
      r[0].columns.forEach((c, i) => (o[c] = v[i]));
      return {
        id: String(o.id),
        taskId: String(o.task_id),
        callId: String(o.call_id),
        tool: String(o.tool),
        level: String(o.level) as PolicyLevel,
        summary: String(o.summary),
        args: parse(o.args_json as string, {}),
        status: String(o.status) as "pending" | "decided",
        decision: (o.decision as ApprovalDecision) ?? null,
        createdAt: Number(o.created_at),
        resolvedAt: o.resolved_at == null ? null : Number(o.resolved_at),
      };
    });
  }

  // ---- checkpoints ----

  saveCheckpoint(taskId: string, stage: string, state: Record<string, unknown>): CheckpointRecord {
    let rec: CheckpointRecord = { id: 0, taskId, stage, state, createdAt: Date.now() };
    this.tx(() => {
      this.db.run("INSERT INTO checkpoints (task_id, stage, state_json, created_at) VALUES (?,?,?,?)", [
        taskId,
        stage,
        json(state),
        rec.createdAt,
      ]);
      const idr = this.db.exec("SELECT last_insert_rowid() AS id");
      rec = { ...rec, id: Number(idr[0].values[0][0]) };
      // keep only the latest 3 checkpoints per task
      this.db.run(
        "DELETE FROM checkpoints WHERE task_id = ? AND id NOT IN (SELECT id FROM checkpoints WHERE task_id = ? ORDER BY id DESC LIMIT 3)",
        [taskId, taskId]
      );
    });
    return rec;
  }

  latestCheckpoint(taskId: string): CheckpointRecord | null {
    const r = this.db.exec(
      "SELECT * FROM checkpoints WHERE task_id = ? ORDER BY id DESC LIMIT 1",
      [taskId]
    );
    if (!r.length || !r[0].values.length) return null;
    const o: Record<string, unknown> = {};
    r[0].columns.forEach((c, i) => (o[c] = r[0].values[0][i]));
    return {
      id: Number(o.id),
      taskId: String(o.task_id),
      stage: String(o.stage),
      state: parse(o.state_json as string, {}),
      createdAt: Number(o.created_at),
    };
  }

  // ---- memories ----

  createMemory(input: {
    workspaceId?: string | null;
    category: MemoryCategory;
    content: string;
    provenance: MemoryProvenance;
    confidence?: number;
    importance?: number;
    source?: string;
    expiresAt?: number | null;
  }): MemoryRecord {
    const now = Date.now();
    const rec: MemoryRecord = {
      id: randomUUID(),
      workspaceId: input.workspaceId ?? null,
      category: input.category,
      content: input.content,
      provenance: input.provenance,
      confidence: input.confidence ?? 0.5,
      importance: input.importance ?? 0.5,
      supersededBy: null,
      source: input.source ?? "",
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt ?? null,
    };
    this.tx(() =>
      this.db.run("INSERT INTO memories VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [
        rec.id, rec.workspaceId, rec.category, rec.content, rec.provenance,
        rec.confidence, rec.importance, null, rec.source, rec.createdAt, rec.updatedAt, rec.expiresAt,
      ])
    );
    return rec;
  }

  getMemory(id: string): MemoryRecord | null {
    const r = this.db.exec("SELECT * FROM memories WHERE id = ?", [id]);
    return r.length && r[0].values.length ? this.rowToMemory(r[0].columns, r[0].values[0]) : null;
  }

  listMemories(filter: { workspaceId?: string | null; category?: MemoryCategory; includeSuperseded?: boolean } = {}): MemoryRecord[] {
    let sql = "SELECT * FROM memories";
    const where: string[] = [];
    const args: unknown[] = [];
    if (filter.workspaceId !== undefined) {
      if (filter.workspaceId === null) where.push("workspace_id IS NULL");
      else {
        where.push("workspace_id = ?");
        args.push(filter.workspaceId);
      }
    }
    if (filter.category) {
      where.push("category = ?");
      args.push(filter.category);
    }
    if (!filter.includeSuperseded) where.push("superseded_by IS NULL");
    if (where.length) sql += " WHERE " + where.join(" AND ");
    sql += " ORDER BY importance DESC, updated_at DESC";
    const r = this.db.exec(sql, args as never[]);
    if (!r.length) return [];
    return r[0].values.map((v) => this.rowToMemory(r[0].columns, v));
  }

  updateMemory(
    id: string,
    patch: Partial<Pick<MemoryRecord, "content" | "category" | "confidence" | "importance" | "expiresAt">>
  ): MemoryRecord | null {
    const cur = this.getMemory(id);
    if (!cur) return null;
    const next = { ...cur, ...patch, updatedAt: Date.now() };
    this.tx(() =>
      this.db.run(
        "UPDATE memories SET content=?, category=?, confidence=?, importance=?, expires_at=?, updated_at=? WHERE id=?",
        [next.content, next.category, next.confidence, next.importance, next.expiresAt, next.updatedAt, id]
      )
    );
    return next;
  }

  // mark old as superseded by new; returns the new record
  supersedeMemory(oldId: string, content: string, patch: Partial<MemoryRecord> = {}): MemoryRecord | null {
    const old = this.getMemory(oldId);
    if (!old) return null;
    const created = this.createMemory({
      workspaceId: old.workspaceId,
      category: (patch.category as MemoryCategory) ?? old.category,
      content,
      provenance: (patch.provenance as MemoryProvenance) ?? old.provenance,
      confidence: patch.confidence ?? old.confidence,
      importance: patch.importance ?? old.importance,
      source: patch.source ?? old.source,
    });
    this.tx(() => this.db.run("UPDATE memories SET superseded_by = ? WHERE id = ?", [created.id, oldId]));
    return created;
  }

  deleteMemory(id: string): void {
    this.tx(() => this.db.run("DELETE FROM memories WHERE id = ?", [id]));
  }

  private rowToMemory(cols: string[], v: unknown[]): MemoryRecord {
    const o: Record<string, unknown> = {};
    cols.forEach((c, i) => (o[c] = v[i]));
    return {
      id: String(o.id),
      workspaceId: (o.workspace_id as string) ?? null,
      category: String(o.category) as MemoryCategory,
      content: String(o.content),
      provenance: String(o.provenance) as MemoryProvenance,
      confidence: Number(o.confidence),
      importance: Number(o.importance),
      supersededBy: (o.superseded_by as string) ?? null,
      source: String(o.source ?? ""),
      createdAt: Number(o.created_at),
      updatedAt: Number(o.updated_at),
      expiresAt: o.expires_at == null ? null : Number(o.expires_at),
    };
  }

  // ---- workspaces ----

  upsertWorkspace(input: {
    id?: string;
    rootPath: string;
    displayName: string;
    info?: Record<string, unknown> | null;
    index?: Record<string, unknown> | null;
    lastScan?: number | null;
  }): WorkspaceRecord {
    const now = Date.now();
    const existing = this.getWorkspaceByPath(input.rootPath);
    if (existing) {
      const next: WorkspaceRecord = {
        ...existing,
        displayName: input.displayName,
        info: input.info !== undefined ? input.info : existing.info,
        index: input.index !== undefined ? input.index : existing.index,
        lastScan: input.lastScan !== undefined ? input.lastScan : existing.lastScan,
        updatedAt: now,
      };
      this.tx(() =>
        this.db.run(
          "UPDATE workspaces SET display_name=?, info_json=?, index_json=?, last_scan=?, updated_at=? WHERE id=?",
          [next.displayName, json(next.info), json(next.index), next.lastScan, next.updatedAt, next.id]
        )
      );
      return next;
    }
    const rec: WorkspaceRecord = {
      id: input.id ?? randomUUID(),
      rootPath: input.rootPath,
      displayName: input.displayName,
      info: input.info ?? null,
      index: input.index ?? null,
      lastScan: input.lastScan ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.tx(() =>
      this.db.run("INSERT INTO workspaces VALUES (?,?,?,?,?,?,?,?)", [
        rec.id, rec.rootPath, rec.displayName, json(rec.info), json(rec.index), rec.lastScan, rec.createdAt, rec.updatedAt,
      ])
    );
    return rec;
  }

  getWorkspace(id: string): WorkspaceRecord | null {
    const r = this.db.exec("SELECT * FROM workspaces WHERE id = ?", [id]);
    return r.length && r[0].values.length ? this.rowToWorkspace(r[0].columns, r[0].values[0]) : null;
  }

  getWorkspaceByPath(rootPath: string): WorkspaceRecord | null {
    const r = this.db.exec("SELECT * FROM workspaces WHERE root_path = ?", [rootPath]);
    return r.length && r[0].values.length ? this.rowToWorkspace(r[0].columns, r[0].values[0]) : null;
  }

  listWorkspaces(): WorkspaceRecord[] {
    const r = this.db.exec("SELECT * FROM workspaces ORDER BY updated_at DESC");
    if (!r.length) return [];
    return r[0].values.map((v) => this.rowToWorkspace(r[0].columns, v));
  }

  deleteWorkspace(id: string): void {
    this.tx(() => this.db.run("DELETE FROM workspaces WHERE id = ?", [id]));
  }

  private rowToWorkspace(cols: string[], v: unknown[]): WorkspaceRecord {
    const o: Record<string, unknown> = {};
    cols.forEach((c, i) => (o[c] = v[i]));
    return {
      id: String(o.id),
      rootPath: String(o.root_path),
      displayName: String(o.display_name),
      info: parse(o.info_json as string, null),
      index: parse(o.index_json as string, null),
      lastScan: o.last_scan == null ? null : Number(o.last_scan),
      createdAt: Number(o.created_at),
      updatedAt: Number(o.updated_at),
    };
  }
}
