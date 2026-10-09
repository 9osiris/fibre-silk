// silk desktop shell, electron main process
import { app, BrowserWindow, ipcMain } from "electron";
import type { IpcMainEvent, WebContents } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent } from "../core/agent.js";
import type { SilkEvent } from "../core/events.js";
import type {
  ApprovalDecision,
  ApprovalRequest,
} from "../core/runtime.js";
import {
  AnthropicProvider,
  OpenAICompatibleProvider,
} from "../core/providers.js";
import type { Provider } from "../core/providers.js";
import {
  defaultConfig,
  getApiKey,
  loadConfig,
  migrateConfig,
  saveConfig,
  validateConfig,
  validateCredentials,
} from "../core/config.js";
import {
  defaultStore,
  SERVICE_NAME,
} from "../core/credentials.js";
import type { CredentialStore } from "../core/credentials.js";
import { createLocalTools } from "../core/tools.js";
import { FibreStore } from "../core/store.js";
import { runCodingTask } from "../core/coding.js";
import { createRegistry, DEFAULT_MODELS } from "../core/models.js";
import { route } from "../core/router.js";
import {
  reconcileInterrupted,
  buildRecoveryReport,
  recoveryDecision,
  markResuming,
  abandonTask,
  restartTask,
} from "../core/recovery.js";
import { existsSync } from "node:fs";
import { MemoryService } from "../core/memory.js";
import { syncWorkspace } from "../core/indexer.js";
import type {
  AnthropicSettings,
  OpenAISettings,
  SilkConfig,
} from "../core/config.js";

const dir = path.dirname(fileURLToPath(import.meta.url));
const isDev = !app.isPackaged;
// silk.json lives in the os user data dir
const configDir = (): string => app.getPath("userData");

// api keys live in the os credential vault, never in plaintext files.
// the renderer only ever learns whether a key is set, never its value.
const store: CredentialStore = defaultStore();

// durable state (sessions, tasks, memory, workspaces) in fibre.db
// under the user data dir. opened at startup, flushed on quit.
let db: FibreStore | null = null;
const modelRegistry = createRegistry(DEFAULT_MODELS);

let win: BrowserWindow | null = null;
let quitting = false;

function createWindow(): void {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: "#0b0b0e",
    title: "Silk",
    webPreferences: {
      preload: path.join(dir, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  if (isDev) {
    win.loadURL("http://localhost:5173");
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    win.loadFile(path.join(dir, "../../ui/dist/index.html"));
  }

  win.on("closed", () => {
    win = null;
  });
}

function getConfig(): SilkConfig {
  return loadConfig(configDir()) ?? defaultConfig();
}

function mergeConfig(base: SilkConfig, patch: Partial<SilkConfig>): SilkConfig {
  const providers: SilkConfig["providers"] = {};
  const openai = { ...base.providers.openai, ...patch.providers?.openai };
  if (Object.keys(openai).length > 0) providers.openai = openai as OpenAISettings;
  const anthropic = { ...base.providers.anthropic, ...patch.providers?.anthropic };
  if (Object.keys(anthropic).length > 0) {
    providers.anthropic = anthropic as AnthropicSettings;
  }
  return {
    activeProvider: patch.activeProvider ?? base.activeProvider,
    providers,
    workspaceDir: patch.workspaceDir ?? base.workspaceDir,
  };
}

// the renderer is untrusted input: sanitize everything it sends before
// it touches the config file or the vault. whitelists, not blocklists.
function sanitizePatch(patch: Partial<SilkConfig>): Partial<SilkConfig> {
  const clean: Partial<SilkConfig> = {};
  if (patch.activeProvider === "openai" || patch.activeProvider === "anthropic") {
    clean.activeProvider = patch.activeProvider;
  }
  const providers: SilkConfig["providers"] = {};
  const oai = patch.providers?.openai;
  if (oai && typeof oai === "object") {
    const entry: OpenAISettings = {
      apiKey: typeof oai.apiKey === "string" ? oai.apiKey.slice(0, 500) : "",
      baseUrl:
        typeof oai.baseUrl === "string" && /^https?:\/\/[^/]+/.test(oai.baseUrl)
          ? oai.baseUrl.slice(0, 500)
          : "https://api.openai.com/v1",
      model: typeof oai.model === "string" ? oai.model.slice(0, 200) : "",
    };
    providers.openai = entry;
  }
  const ant = patch.providers?.anthropic;
  if (ant && typeof ant === "object") {
    providers.anthropic = {
      apiKey: typeof ant.apiKey === "string" ? ant.apiKey.slice(0, 500) : "",
      model: typeof ant.model === "string" ? ant.model.slice(0, 200) : "",
    };
  }
  if (Object.keys(providers).length > 0) clean.providers = providers;
  if (typeof patch.workspaceDir === "string") {
    clean.workspaceDir = patch.workspaceDir.slice(0, 1000);
  }
  return clean;
}

// what the renderer is allowed to see: prefs plus keySet flags.
// apiKey is always empty here; keys never leave the main process.
interface SettingsView {
  providers: {
    openai?: { apiKey: ""; baseUrl: string; model: string; keySet: boolean };
    anthropic?: { apiKey: ""; model: string; keySet: boolean };
  };
  activeProvider: "openai" | "anthropic";
  workspaceDir: string;
}

async function settingsView(): Promise<SettingsView> {
  const cfg = getConfig();
  const view: SettingsView = {
    providers: {},
    activeProvider: cfg.activeProvider,
    workspaceDir: cfg.workspaceDir ?? "",
  };
  if (cfg.providers.openai) {
    const key = await getApiKey(cfg, "openai", store).catch(() => null);
    view.providers.openai = {
      apiKey: "",
      baseUrl: cfg.providers.openai.baseUrl,
      model: cfg.providers.openai.model,
      keySet: !!key,
    };
  }
  if (cfg.providers.anthropic) {
    const key = await getApiKey(cfg, "anthropic", store).catch(() => null);
    view.providers.anthropic = {
      apiKey: "",
      model: cfg.providers.anthropic.model,
      keySet: !!key,
    };
  }
  return view;
}

async function makeProvider(cfg: SilkConfig): Promise<Provider> {
  if (cfg.activeProvider === "anthropic" && cfg.providers.anthropic) {
    const s = cfg.providers.anthropic;
    const apiKey = await getApiKey(cfg, "anthropic", store);
    if (!apiKey) throw new Error("anthropic api key is missing");
    return new AnthropicProvider({ apiKey, model: s.model });
  }
  const s = cfg.providers.openai;
  if (!s) throw new Error("openai settings missing");
  const apiKey = await getApiKey(cfg, "openai", store);
  if (!apiKey) throw new Error("openai api key is missing");
  return new OpenAICompatibleProvider({
    apiKey,
    baseUrl: s.baseUrl,
    model: s.model,
  });
}

// build the provider for an arbitrary registry model id (coding loop
// routes per stage). falls back to the active provider's settings.
async function providerForModel(cfg: SilkConfig, modelId: string): Promise<Provider> {
  const info = modelRegistry.get(modelId);
  if (info?.provider === "anthropic" && cfg.providers.anthropic) {
    const apiKey = await getApiKey(cfg, "anthropic", store);
    if (!apiKey) throw new Error("anthropic api key is missing");
    return new AnthropicProvider({ apiKey, model: modelId });
  }
  if (info?.provider === "openai" && cfg.providers.openai) {
    const apiKey = await getApiKey(cfg, "openai", store);
    if (!apiKey) throw new Error("openai api key is missing");
    return new OpenAICompatibleProvider({
      apiKey,
      baseUrl: cfg.providers.openai.baseUrl,
      model: modelId,
    });
  }
  return makeProvider(cfg);
}

// approval round-trip: ask the renderer, wait for its answer.
// resolves "deny" if the renderer never answers within 5 minutes.
// only whitelisted decision strings are accepted; anything else is deny.
export function requestApproval(
  sender: WebContents,
  req: ApprovalRequest
): Promise<ApprovalDecision> {
  return new Promise((resolve) => {
    const done = (d: ApprovalDecision): void => {
      clearTimeout(timer);
      ipcMain.removeListener("silk:approval-response", onResponse);
      resolve(d);
    };
    const timer = setTimeout(() => done("deny"), 5 * 60 * 1000);
    const onResponse = (
      _event: IpcMainEvent,
      msg: { callId?: unknown; decision?: unknown }
    ): void => {
      if (!msg || msg.callId !== req.callId) return; // not ours, keep waiting
      const d = msg.decision;
      done(
        d === "allow_once" ||
          d === "allow_session" ||
          d === "allow_always" ||
          d === "deny"
          ? d
          : "deny"
      );
    };
    ipcMain.on("silk:approval-response", onResponse);
    if (!sender.isDestroyed()) {
      sender.send("silk:approval-request", req);
    } else {
      done("deny");
    }
  });
}

// strip anything key-shaped from a message before it leaves main
function scrubSecrets(message: string): string {
  return message.replace(/sk-[A-Za-z0-9-_]{8,}/g, "sk-***").slice(0, 300);
}

// one chat turn. with a workspace configured, this runs the full
// coding loop (plan/inspect/implement/test/review/verify) with task
// persistence; without one, it is a plain agent conversation.
// the session and its messages are persisted either way.
ipcMain.handle(
  "silk:chat",
  async (event, args: { runId: string; prompt: string; sessionId?: string }) => {
    const sender = event.sender;
    const send = (payload: Record<string, unknown>): void => {
      if (!sender.isDestroyed()) {
        sender.send("silk:chat-event", { runId: args.runId, ...payload });
      }
    };
    // approval gate for tool execution. the agent runtime calls
    // approve(req) and waits for the renderer's answer via the modal.
    const approve = (req: ApprovalRequest): Promise<ApprovalDecision> =>
      requestApproval(sender, req);
    try {
      const cfg = getConfig();
      const problems = validateConfig(cfg);
      const credProblems = await validateCredentials(cfg, store).catch(() => [
        "credential store unavailable",
      ]);
      if (problems.length > 0 || credProblems.length > 0)
        throw new Error([...problems, ...credProblems].join("; "));

      // session: reuse the renderer's active one or start a new one
      let session = args.sessionId && db ? db.getSession(args.sessionId) : null;
      if (db && !session) {
        session = db.createSession({
          title: args.prompt.trim().slice(0, 48) || "new session",
        });
      }
      const onEvent = (e: SilkEvent): void => {
        send(e as unknown as Record<string, unknown>);
      };

      const persistMessage = (role: string, content: string): void => {
        if (!db || !session || !content.trim()) return;
        const messages = [...session.messages, { role, content }].slice(-200);
        session = db.updateSession(session.id, { messages });
      };
      persistMessage("user", args.prompt);

      const workspaceDir = cfg.workspaceDir?.trim() ?? "";
      const storeDb = db;
      if (storeDb && workspaceDir && existsSync(workspaceDir)) {
        // coding task path: full loop with durable task state
        const { workspace: ws } = await syncWorkspace(storeDb, workspaceDir).catch(() =>
          ({
            workspace: storeDb.upsertWorkspace({
              rootPath: workspaceDir,
              displayName: path.basename(workspaceDir) || workspaceDir,
            }),
          })
        );
        const tools = createLocalTools({ allowedRoots: [workspaceDir] }).all();
        const result = await runCodingTask(args.prompt, {
          dir: workspaceDir,
          getProvider: (modelId: string) => providerForModel(cfg, modelId),
          router: { route: (req: any) => route(req, modelRegistry) },
          onEvent,
          approve,
          store: storeDb,
          sessionId: session?.id,
          workspaceId: ws.id,
          createAgent: (provider: Provider, model: string) => {
            const agent = new Agent(provider, tools, { model });
            return {
              run: async (task: string, opts?: { signal?: AbortSignal }) => {
                const r = await agent.run(task, {
                  signal: opts?.signal,
                  maxSteps: 40,
                  onEvent,
                  approve,
                });
                return { text: r.text, filesChanged: r.filesChanged };
              },
            };
          },
        });
        persistMessage("assistant", result.summary);
        // task-derived memory: only facts observed in the workspace or
        // verified by the run. failures here never break the chat.
        try {
          const wsInfo = ws.info as { languages?: string[]; scripts?: Record<string, string> } | null;
          const taskRec = storeDb.listTasks({ sessionId: session?.id, limit: 1 })[0];
          if (taskRec) {
            new MemoryService(storeDb).memoriesFromTask(taskRec, {
              languages: wsInfo?.languages ?? [],
              testCommand: wsInfo?.scripts?.test,
              buildCommand: wsInfo?.scripts?.build,
              verificationOk: result.status === "completed",
            });
          }
        } catch {
          // memory extraction is best effort
        }
        return { runId: args.runId, text: result.summary, sessionId: session?.id };
      }

      // plain conversation path (no workspace configured)
      const tools = createLocalTools().all();
      const agent = new Agent(await makeProvider(cfg), tools);
      const result = await agent.run(args.prompt, {
        onEvent,
        approve,
        taskId: args.runId,
      });
      persistMessage("assistant", result.text);
      return { runId: args.runId, text: result.text, sessionId: session?.id };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      send({ type: "error", text: message });
      throw err;
    }
  }
);

// settings live in silk.json under the user data dir.
// incoming api keys go straight to the vault; the file keeps prefs only.
ipcMain.handle(
  "silk:settings",
  async (_event, op: "get" | "set", patch?: Partial<SilkConfig>) => {
    if (op === "set") {
      const clean = sanitizePatch(patch ?? {});
      const incoming = clean.providers;
      if (incoming?.openai?.apiKey) {
        await store.set(SERVICE_NAME, "openai", incoming.openai.apiKey);
      }
      if (incoming?.anthropic?.apiKey) {
        await store.set(SERVICE_NAME, "anthropic", incoming.anthropic.apiKey);
      }
      const next = mergeConfig(getConfig(), clean);
      saveConfig(configDir(), next);
      return settingsView();
    }
    return settingsView();
  }
);

// ---- phase 3 ipc: sessions, recovery ----
// the renderer consumes ipc views only. it never sees the database
// file, provider secrets, or raw store rows beyond these shapes.

ipcMain.handle("silk:sessions", async (_event, op: string, arg?: string) => {
  if (!db) return op === "list" ? [] : null;
  switch (op) {
    case "list":
      return db.listSessions(50).map((s) => ({
        id: s.id,
        title: s.title,
        status: s.status,
        workspaceId: s.workspaceId,
        messageCount: s.messages.length,
        updatedAt: s.updatedAt,
      }));
    case "get": {
      const s = arg ? db.getSession(arg) : null;
      return s
        ? { id: s.id, title: s.title, status: s.status, workspaceId: s.workspaceId, messages: s.messages, updatedAt: s.updatedAt }
        : null;
    }
    case "delete":
      if (arg) db.deleteSession(arg);
      return { ok: true };
    case "rename": {
      // arg is "id|title"
      const [id, ...rest] = (arg ?? "").split("|");
      const title = rest.join("|").slice(0, 120);
      if (id && title) db.updateSession(id, { title });
      return { ok: true };
    }
    default:
      return null;
  }
});

ipcMain.handle("silk:recovery", async (event, op: string, taskId?: string) => {
  if (!db) return op === "list" ? [] : { ok: false, message: "store unavailable" };
  switch (op) {
    case "list": {
      const tasks = db.listInterruptedTasks();
      const out = [];
      for (const t of tasks) {
        const report = await buildRecoveryReport(db, t.id);
        if (report) {
          out.push({
            taskId: t.id,
            goal: t.goal,
            stage: t.stage,
            updatedAt: t.updatedAt,
            pendingApprovals: report.pendingApprovals.length,
            uncertainOps: report.uncertainOps.length,
            decision: recoveryDecision(report),
          });
        }
      }
      return out;
    }
    case "report": {
      if (!taskId) return null;
      const report = await buildRecoveryReport(db, taskId);
      if (!report) return null;
      return {
        task: {
          id: report.task.id,
          goal: report.task.goal,
          status: report.task.status,
          stage: report.task.stage,
          filesChanged: report.task.filesChanged,
          plan: report.task.plan,
        },
        checkpointStage: report.checkpoint?.stage ?? null,
        pendingApprovals: report.pendingApprovals.map((a) => ({
          id: a.id, tool: a.tool, summary: a.summary, createdAt: a.createdAt,
        })),
        uncertainOps: report.uncertainOps,
        completedOps: report.completedOps,
        gitFiles: report.gitFiles,
        decision: recoveryDecision(report),
      };
    }
    case "abandon":
      if (taskId) abandonTask(db, taskId);
      return { ok: true };
    case "restart":
      if (taskId) restartTask(db, taskId);
      return { ok: true };
    case "resume": {
      if (!taskId) return { ok: false, message: "missing taskId" };
      const report = await buildRecoveryReport(db, taskId);
      if (!report) return { ok: false, message: "task not found" };
      const decision = recoveryDecision(report);
      if (!decision.canResume) return { ok: false, message: decision.reason };
      markResuming(db, taskId);
      // re-enter the coding loop from the checkpoint. events stream on
      // the chat channel under a fresh runId.
      const runId = `resume-${taskId}`;
      const sender = event.sender;
      const send = (payload: Record<string, unknown>): void => {
        if (!sender.isDestroyed()) sender.send("silk:chat-event", { runId, ...payload });
      };
      const cfg = getConfig();
      const approve = (req: ApprovalRequest): Promise<ApprovalDecision> =>
        requestApproval(sender, req);
      const workspaceDir = cfg.workspaceDir?.trim() ?? "";
      const dir = workspaceDir && existsSync(workspaceDir)
        ? workspaceDir
        : report.task.workspaceId
          ? (db.getWorkspace(report.task.workspaceId)?.rootPath ?? "")
          : "";
      if (!dir) return { ok: false, message: "workspace directory unavailable" };
      const tools = createLocalTools({ allowedRoots: [dir] }).all();
      const note =
        `resumed after interruption at stage ${report.checkpoint?.stage ?? "unknown"}. ` +
        `${report.uncertainOps.length} operation(s) had uncertain outcomes; inspect before redoing anything. ` +
        `the workspace may already contain partial changes.`;
      void runCodingTask(report.task.goal, {
        dir,
        getProvider: (modelId: string) => providerForModel(cfg, modelId),
        router: { route: (req: any) => route(req, modelRegistry) },
        onEvent: (e: SilkEvent) => send(e as unknown as Record<string, unknown>),
        approve,
        store: db,
        sessionId: report.task.sessionId ?? undefined,
        workspaceId: report.task.workspaceId ?? undefined,
        taskId,
        resume: {
          plan: (report.checkpoint?.state.plan as never) ?? report.task.plan,
          filesChanged: report.task.filesChanged,
          note,
        },
        createAgent: (provider: Provider, model: string) => {
          const agent = new Agent(provider, tools, { model });
          return {
            run: async (task: string, opts?: { signal?: AbortSignal }) => {
              const r = await agent.run(task, {
                signal: opts?.signal,
                maxSteps: 40,
                onEvent: (e: SilkEvent) => send(e as unknown as Record<string, unknown>),
                approve,
              });
              return { text: r.text, filesChanged: r.filesChanged };
            },
          };
        },
      });
      return { ok: true, runId };
    }
    default:
      return { ok: false, message: "unknown op" };
  }
});

// ---- phase 3 ipc: memory ----

ipcMain.handle("silk:memory", async (_event, op: string, arg?: unknown) => {
  if (!db) return op === "list" ? [] : { ok: false, message: "store unavailable" };
  const svc = new MemoryService(db);
  switch (op) {
    case "list": {
      const query = typeof arg === "string" ? arg.trim() : "";
      const records = query ? svc.search(query, { limit: 50 }) : svc.list({});
      return records.map((m) => ({
        id: m.id,
        workspaceId: m.workspaceId,
        category: m.category,
        content: m.content,
        provenance: m.provenance,
        confidence: m.confidence,
        importance: m.importance,
        createdAt: m.createdAt,
        updatedAt: m.updatedAt,
      }));
    }
    case "create": {
      const input = (arg ?? {}) as {
        category?: string;
        content?: string;
        provenance?: string;
      };
      if (!input.content?.trim()) return { ok: false, message: "content is empty" };
      try {
        const rec = svc.remember({
          category: (input.category as never) ?? "user_preference",
          content: input.content.trim().slice(0, 2000),
          provenance: (input.provenance as never) ?? "user_statement",
          source: "ui",
        });
        return { ok: true, id: rec.id };
      } catch (err) {
        return { ok: false, message: err instanceof Error ? err.message : String(err) };
      }
    }
    case "delete":
      if (typeof arg === "string") svc.remove(arg);
      return { ok: true };
    default:
      return { ok: false, message: "unknown op" };
  }
});

// settings panel "test connection": builds the configured provider and
// sends a tiny ping. returns ok/message, never the key.
ipcMain.handle("silk:test-provider", async () => {
  try {
    const cfg = getConfig();
    const problems = validateConfig(cfg);
    if (problems.length > 0) return { ok: false, message: problems.join("; ") };
    const model =
      cfg.activeProvider === "anthropic"
        ? cfg.providers.anthropic?.model
        : cfg.providers.openai?.model;
    if (!model) return { ok: false, message: "no model configured" };
    const provider = await makeProvider(cfg);
    const gen = provider.chat([{ role: "user", content: "ping" }], { model });
    const timeout = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("timed out after 20s")), 20000);
    });
    const first = await Promise.race([gen.next(), timeout]);
    if (typeof gen.return === "function") await gen.return(undefined);
    if (first.done) return { ok: false, message: "provider returned nothing" };
    return { ok: true, message: "connected, model responded" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, message: scrubSecrets(message) };
  }
});

// groups taskbar icons and toast notifications under silk on windows
app.setAppUserModelId("rocks.osiris.silk");

app.whenReady().then(async () => {
  // first run: move any legacy plaintext keys into the vault
  try {
    await migrateConfig(configDir(), store);
  } catch {
    // migration is best-effort; the app still starts
  }
  // open durable state. tasks left mid-run last time are marked
  // interrupted (never completed) and surface in the recovery panel.
  try {
    db = await FibreStore.open(configDir(), {
      onDiagnostic: (e) => console.warn("[store]", e.kind, e.message),
    });
    const interrupted = reconcileInterrupted(db);
    if (interrupted.length > 0) {
      console.warn(`[recovery] ${interrupted.length} interrupted task(s) found`);
    }
  } catch (err) {
    console.warn("[store] failed to open, running without persistence:", err instanceof Error ? err.message : String(err));
    db = null;
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// graceful shutdown: flush and close the store before quitting so the
// last persisted state is the state recovery will see on next launch.
app.on("before-quit", (e) => {
  if (quitting) return;
  e.preventDefault();
  quitting = true;
  try {
    db?.close();
  } catch {
    // close is best effort; atomic exports already landed during the run
  }
  db = null;
  app.quit();
});
