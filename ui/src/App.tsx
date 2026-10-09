import { useEffect, useRef, useState } from "react";
import { SettingsPanel } from "./settings";
import type {
  ApprovalDecision,
  ApprovalRequest,
  FileChanges,
  MemoryView,
  RecoveryTaskView,
  SessionView,
  SilkBridge,
  SilkEvent,
  Stage,
} from "./silk.d";

// old phase-1 event shapes, tolerated until core finishes its rewrite
// to SilkEvents. remove this once core/events.ts is the only emitter.
type AnyEvent =
  | SilkEvent
  | { type: "text"; delta: string }
  | { type: "toolStart"; id: string; name: string }
  | { type: "toolEnd"; id: string; name: string; ok: boolean }
  | { type: "done"; text: string };

// local stub so plain `npm run dev` renders without electron.
// emits the same SilkEvent shapes the real bridge sends.
function stubBridge(): SilkBridge {
  return {
    chat(prompt: string, onEvent: (e: SilkEvent) => void) {
      const tid = "stub-1";
      const reply =
        "silk stub here. run inside the electron shell and point it at " +
        "your own api key in settings to get real answers. you said: " +
        prompt;
      return new Promise((resolve) => {
        onEvent({ type: "agent.started", taskId: tid, goal: prompt });
        onEvent({
          type: "agent.stage",
          taskId: tid,
          stage: "implement",
          model: "stub",
          provider: "openai",
        });
        onEvent({
          type: "agent.tool_started",
          taskId: tid,
          callId: "c1",
          tool: "fs_list",
        });
        const words = reply.split(" ");
        let i = 0;
        const tick = () => {
          i += 1;
          onEvent({ type: "agent.text", taskId: tid, delta: words[i - 1] + " " });
          if (i < words.length) {
            setTimeout(tick, 30);
          } else {
            onEvent({
              type: "agent.tool_completed",
              taskId: tid,
              callId: "c1",
              tool: "fs_list",
              ok: true,
              ms: 12,
            });
            const text = words.join(" ");
            onEvent({
              type: "agent.completed",
              taskId: tid,
              summary: "stub run, nothing real happened",
              filesChanged: { created: [], modified: [], deleted: [] },
            });
            resolve({ text });
          }
        };
        setTimeout(tick, 60);
      });
    },
    getSettings: async () => ({
      providers: {
        openai: { apiKey: "", baseUrl: "https://api.openai.com/v1", model: "", keySet: false },
      },
      activeProvider: "openai" as const,
    }),
    saveSettings: async (p) => ({
      providers: {
        openai: { apiKey: "", baseUrl: "https://api.openai.com/v1", model: "", keySet: false },
      },
      activeProvider: "openai" as const,
      ...p,
    }),
    testProvider: async () => ({ ok: false, message: "stub has no provider" }),
    onApprovalRequest() {},
    answerApproval() {},
    listSessions: async () => [],
    getSession: async () => null,
    deleteSession: async () => ({ ok: true }),
    renameSession: async () => ({ ok: true }),
    listRecovery: async () => [],
    getRecoveryReport: async () => null,
    recoveryAction: async () => ({ ok: false, message: "stub has no recovery" }),
    onChatEvent: () => () => {},
    listMemory: async () => [],
    createMemory: async () => ({ ok: false, message: "stub has no memory" }),
    deleteMemory: async () => ({ ok: true }),
  };
}

const bridge: SilkBridge =
  typeof window !== "undefined" && window.silk ? window.silk : stubBridge();

interface Activity {
  id: string;
  name: string;
  state: "running" | "ok" | "fail";
  detail?: string;
}

interface Msg {
  id: number;
  role: "user" | "agent";
  text: string;
  activity: Activity[];
  streaming?: boolean;
  filesChanged?: FileChanges;
  summary?: string;
  failed?: string;
  cancelled?: boolean;
}

interface RunStatus {
  stage: string;
  modelLine: string;
}

let nextId = 1;

// plain-words rendering of each coding stage, no chain-of-thought
const STAGE_WORDS: Record<Stage, string> = {
  understand: "understanding the task...",
  plan: "planning...",
  inspect: "inspecting project...",
  implement: "editing files...",
  test: "running tests...",
  review: "reviewing changes...",
  fix: "fixing...",
  verify: "verifying...",
  complete: "done",
};

// short role label for the "using x/y for z" line
const STAGE_ROLE: Record<Stage, string> = {
  understand: "reasoning",
  plan: "planning",
  inspect: "inspecting",
  implement: "coding",
  test: "testing",
  review: "review",
  fix: "fixing",
  verify: "verifying",
  complete: "done",
};

// tiny markdown-ish renderer: escape html, then `code`, **bold**, breaks
function renderBody(text: string) {
  const esc = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  const html = esc
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\n/g, "<br/>");
  return { __html: html };
}

function changedCount(f: FileChanges): number {
  return f.created.length + f.modified.length + f.deleted.length;
}

function MessageView({ msg, onStop }: { msg: Msg; onStop: () => void }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(msg.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch {
      // clipboard unavailable, ignore
    }
  };
  return (
    <div className={msg.role === "user" ? "row right" : "row left"}>
      <div className={msg.role === "user" ? "bubble user" : "bubble agent"}>
        {msg.activity.length > 0 && (
          <div className="activity">
            {msg.activity.map((a) => (
              <div key={a.id} className={"act " + a.state} title={a.detail}>
                {a.state === "running"
                  ? "running " + a.name + "..."
                  : a.state === "ok"
                    ? "done " + a.name + (a.detail ? " " + a.detail : "")
                    : "failed " + a.name + (a.detail ? ": " + a.detail : "")}
              </div>
            ))}
          </div>
        )}
        <div dangerouslySetInnerHTML={renderBody(msg.text)} />
        {msg.filesChanged && changedCount(msg.filesChanged) > 0 && (
          <div className="files">
            <div className="files-head">files changed</div>
            {msg.filesChanged.created.map((f) => (
              <div key={"c" + f} className="f created">
                + {f}
              </div>
            ))}
            {msg.filesChanged.modified.map((f) => (
              <div key={"m" + f} className="f modified">
                ~ {f}
              </div>
            ))}
            {msg.filesChanged.deleted.map((f) => (
              <div key={"d" + f} className="f deleted">
                - {f}
              </div>
            ))}
          </div>
        )}
        {msg.summary && <div className="summary-line">{msg.summary}</div>}
        {msg.failed && <div className="failed-line">failed: {msg.failed}</div>}
        {msg.cancelled && <div className="failed-line">cancelled</div>}
        <div className="tools">
          <button onClick={copy} title="copy">
            {copied ? "copied" : "copy"}
          </button>
          {msg.streaming && (
            <button onClick={onStop} title="stop" className="stop">
              stop
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

// persistent memory browser: list, search, add, delete.
// memory is data the agent may use; it is never executable policy.
function MemoryPanel({
  memories,
  onSearch,
  onClose,
  onChanged,
}: {
  memories: MemoryView[];
  onSearch: (q: string) => void;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [q, setQ] = useState("");
  const [draft, setDraft] = useState("");
  const [note, setNote] = useState("");
  const add = async () => {
    const content = draft.trim();
    if (!content) return;
    const res = await bridge.createMemory({
      category: "user_preference",
      content,
      provenance: "user_statement",
    });
    if (res.ok) {
      setDraft("");
      setNote("saved");
      onChanged();
    } else {
      setNote(res.message ?? "could not save");
    }
  };
  const remove = async (id: string) => {
    await bridge.deleteMemory(id);
    onChanged();
  };
  return (
    <div className="overlay" onClick={onClose}>
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <span>memory</span>
          <button onClick={onClose} title="close">
            x
          </button>
        </div>
        <div className="mem-search">
          <input
            type="text"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              onSearch(e.target.value);
            }}
            placeholder="search memory"
          />
        </div>
        <div className="mem-list">
          {memories.length === 0 && <p className="note">nothing stored yet.</p>}
          {memories.map((m) => (
            <div key={m.id} className="mem-row">
              <div className="mem-body">
                <span className="mem-cat">{m.category}</span> {m.content}
                <div className="mem-meta">
                  {m.provenance}, confidence {m.confidence.toFixed(2)}
                </div>
              </div>
              <button className="x" onClick={() => void remove(m.id)} title="delete">
                x
              </button>
            </div>
          ))}
        </div>
        <div className="mem-add">
          <input
            type="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="remember this: ..."
          />
          <button className="send" onClick={() => void add()}>
            save
          </button>
        </div>
        {note && <p className="note">{note}</p>}
      </div>
    </div>
  );
}

function ApprovalModal({
  req,
  onAnswer,
}: {
  req: ApprovalRequest;
  onAnswer: (d: ApprovalDecision) => void;
}) {
  const preview = JSON.stringify(req.args ?? {}, null, 2);
  const short =
    preview.length > 800 ? preview.slice(0, 800) + "\n..." : preview;
  return (
    <div className="overlay">
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <div className="panel-head">
          <span>approval needed</span>
        </div>
        <p className="note">{req.summary}</p>
        <div className="approve-meta">
          <div>
            tool: <code>{req.tool}</code>
          </div>
          <div>
            level: <code>{req.level}</code>
          </div>
        </div>
        <pre className="args">{short}</pre>
        <div className="approve-btns">
          <button className="send" onClick={() => onAnswer("allow_once")}>
            allow once
          </button>
          <button onClick={() => onAnswer("allow_session")}>
            allow for session
          </button>
          <button onClick={() => onAnswer("allow_always")}>always allow</button>
          <button className="stop" onClick={() => onAnswer("deny")}>
            deny
          </button>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [status, setStatus] = useState<RunStatus | null>(null);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const [sessionId, setSessionId] = useState<string | undefined>(undefined);
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [recovery, setRecovery] = useState<RecoveryTaskView[]>([]);
  const [showMemory, setShowMemory] = useState(false);
  const [memories, setMemories] = useState<MemoryView[]>([]);
  const stopped = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);
  const box = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs]);

  // approval requests arrive outside the chat event stream
  useEffect(() => {
    bridge.onApprovalRequest((req) => setApproval(req));
  }, []);

  // sessions + interrupted tasks on launch
  const refreshSessions = async () => {
    try {
      setSessions(await bridge.listSessions());
    } catch {
      setSessions([]);
    }
  };
  const refreshRecovery = async () => {
    try {
      setRecovery(await bridge.listRecovery());
    } catch {
      setRecovery([]);
    }
  };
  useEffect(() => {
    void refreshSessions();
    void refreshRecovery();
  }, []);

  const openSession = async (id: string) => {
    const s = await bridge.getSession(id);
    if (!s) return;
    setSessionId(s.id);
    setMsgs(
      (s.messages ?? []).map((m) => ({
        id: nextId++,
        role: m.role === "user" ? ("user" as const) : ("agent" as const),
        text: m.content,
        activity: [],
      }))
    );
  };

  const newSession = () => {
    setSessionId(undefined);
    setMsgs([]);
  };

  const removeSession = async (id: string) => {
    await bridge.deleteSession(id);
    if (id === sessionId) newSession();
    void refreshSessions();
  };

  const recoveryRun = async (op: "resume" | "restart" | "abandon", taskId: string) => {
    const res = await bridge.recoveryAction(op, taskId);
    if (op === "resume" && res.ok) {
      setStatus({ stage: "resuming interrupted task...", modelLine: "" });
    }
    void refreshRecovery();
    if (!res.ok && res.message) {
      setStatus({ stage: "recovery: " + res.message, modelLine: "" });
    }
  };

  const refreshMemory = async (q?: string) => {
    try {
      setMemories(await bridge.listMemory(q));
    } catch {
      setMemories([]);
    }
  };

  const stop = () => {
    stopped.current = true;
  };

  const answerApproval = (d: ApprovalDecision) => {
    if (approval) {
      bridge.answerApproval(approval.callId, d);
      setApproval(null);
    }
  };

  const patch = (id: number, fn: (m: Msg) => Msg) =>
    setMsgs((ms) => ms.map((x) => (x.id === id ? fn(x) : x)));

  const upsertActivity = (
    id: number,
    callId: string,
    name: string,
    state: Activity["state"],
    detail?: string
  ) =>
    patch(id, (m) => {
      const has = m.activity.some((a) => a.id === callId);
      const activity = has
        ? m.activity.map((a) =>
            a.id === callId ? { ...a, name, state, detail } : a
          )
        : [...m.activity, { id: callId, name, state, detail }];
      return { ...m, activity };
    });

  const send = async () => {
    const prompt = input.trim();
    if (!prompt || busy) return;
    setInput("");
    stopped.current = false;
    const userMsg: Msg = {
      id: nextId++,
      role: "user",
      text: prompt,
      activity: [],
    };
    const agentMsg: Msg = {
      id: nextId++,
      role: "agent",
      text: "",
      activity: [],
      streaming: true,
    };
    setMsgs((m) => [...m, userMsg, agentMsg]);
    setBusy(true);
    setStatus({ stage: "starting...", modelLine: "" });

    const handleEvent = (e: AnyEvent) => {
      if (stopped.current) return;
      switch (e.type) {
        case "agent.started":
          setStatus({ stage: "starting...", modelLine: "" });
          break;
        case "agent.planning":
          setStatus((s) => ({ ...s, stage: "planning..." } as RunStatus));
          break;
        case "agent.plan_created":
          setStatus((s) => ({ ...s, stage: "plan ready" } as RunStatus));
          break;
        case "agent.stage":
          setStatus({
            stage: STAGE_WORDS[e.stage] ?? e.stage,
            modelLine: `using ${e.provider}/${e.model} for ${STAGE_ROLE[e.stage] ?? e.stage}`,
          });
          break;
        case "agent.text":
          patch(agentMsg.id, (m) => ({ ...m, text: m.text + e.delta }));
          break;
        case "agent.tool_requested":
        case "agent.tool_started":
          upsertActivity(agentMsg.id, e.callId, e.tool, "running");
          break;
        case "agent.tool_completed":
          upsertActivity(
            agentMsg.id,
            e.callId,
            e.tool,
            e.ok ? "ok" : "fail",
            e.ms + "ms"
          );
          break;
        case "agent.tool_failed":
          upsertActivity(agentMsg.id, e.callId, e.tool, "fail", e.error);
          break;
        case "agent.retrying":
          setStatus((s) => ({
            ...s,
            stage: `retrying (${e.attempt}): ${e.reason}`,
          }) as RunStatus);
          break;
        case "agent.waiting_for_approval":
          setStatus((s) => ({
            ...s,
            stage: `waiting for approval: ${e.tool}`,
          }) as RunStatus);
          break;
        case "agent.validation_started":
          setStatus((s) => ({ ...s, stage: "verifying..." }) as RunStatus);
          break;
        case "agent.completed":
          patch(agentMsg.id, (m) => ({
            ...m,
            filesChanged: e.filesChanged,
            summary: e.summary,
            streaming: false,
          }));
          setStatus((s) => ({ ...s, stage: "verified" }) as RunStatus);
          break;
        case "agent.failed":
          patch(agentMsg.id, (m) => ({
            ...m,
            failed: e.error,
            streaming: false,
          }));
          setStatus((s) => ({ ...s, stage: "failed" }) as RunStatus);
          break;
        case "agent.cancelled":
          patch(agentMsg.id, (m) => ({
            ...m,
            cancelled: true,
            streaming: false,
          }));
          setStatus((s) => ({ ...s, stage: "cancelled" }) as RunStatus);
          break;
        // transitional compat with phase-1 core events
        case "text":
          patch(agentMsg.id, (m) => ({ ...m, text: m.text + e.delta }));
          break;
        case "toolStart":
          upsertActivity(agentMsg.id, e.id, e.name, "running");
          break;
        case "toolEnd":
          upsertActivity(agentMsg.id, e.id, e.name, e.ok ? "ok" : "fail");
          break;
        case "done":
          patch(agentMsg.id, (m) => ({ ...m, streaming: false }));
          setStatus((s) => ({ ...s, stage: "done" }) as RunStatus);
          break;
      }
    };

    try {
      const res = await bridge.chat(prompt, handleEvent, sessionId);
      if (res.sessionId) setSessionId(res.sessionId);
      void refreshSessions();
      patch(agentMsg.id, (m) => ({
        ...m,
        text: stopped.current ? m.text : res.text || m.text,
        streaming: false,
      }));
    } catch (err) {
      // agent.failed already set state via event; only fill in on
      // transport-level errors that never produced an event
      const msg = err instanceof Error ? err.message : String(err);
      patch(agentMsg.id, (m) =>
        m.failed || m.cancelled
          ? m
          : { ...m, text: "something broke: " + msg, streaming: false }
      );
      setStatus((s) => (s?.stage === "failed" ? s : { ...s, stage: "failed" }) as RunStatus);
    } finally {
      setBusy(false);
      box.current?.focus();
    }
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="app">
      <header>
        <span className="wordmark">silk</span>
        <div className="head-actions">
          <button className="gear" onClick={newSession} title="new session">
            new
          </button>
          <button
            className="gear"
            onClick={() => {
              setShowMemory(true);
              void refreshMemory();
            }}
            title="memory"
          >
            memory
          </button>
          <button
            className="gear"
            onClick={() => setShowSettings(true)}
            title="settings"
          >
            settings
          </button>
        </div>
      </header>
      {recovery.length > 0 && (
        <div className="recovery">
          <div className="recovery-head">
            interrupted tasks from last session
          </div>
          {recovery.map((r) => (
            <div key={r.taskId} className="recovery-row">
              <span className="recovery-goal">
                {r.goal}
                <span className="recovery-meta">
                  {" "}
                  stopped at {r.stage || "start"}
                  {r.pendingApprovals > 0 &&
                    `, ${r.pendingApprovals} approval(s) pending`}
                  {r.uncertainOps > 0 &&
                    `, ${r.uncertainOps} uncertain op(s)`}
                </span>
              </span>
              <span className="recovery-btns">
                <button
                  disabled={!r.decision.canResume}
                  title={r.decision.reason}
                  onClick={() => void recoveryRun("resume", r.taskId)}
                >
                  resume
                </button>
                <button onClick={() => void recoveryRun("restart", r.taskId)}>
                  restart
                </button>
                <button onClick={() => void recoveryRun("abandon", r.taskId)}>
                  abandon
                </button>
              </span>
            </div>
          ))}
        </div>
      )}
      {sessions.length > 0 && (
        <div className="sessions">
          {sessions.slice(0, 12).map((s) => (
            <span key={s.id} className="session-chip">
              <button
                className={s.id === sessionId ? "active" : ""}
                onClick={() => void openSession(s.id)}
                title={s.title}
              >
                {s.title}
              </button>
              <button
                className="x"
                onClick={() => void removeSession(s.id)}
                title="delete session"
              >
                x
              </button>
            </span>
          ))}
        </div>
      )}
      <main className="list">
        {msgs.length === 0 && (
          <div className="empty">say something. silk does the rest.</div>
        )}
        {msgs.map((m) => (
          <MessageView key={m.id} msg={m} onStop={stop} />
        ))}
        <div ref={bottom} />
      </main>
      {status && (
        <div className="statusline">
          <span className="stage">{status.stage}</span>
          {status.modelLine && (
            <span className="model">{status.modelLine}</span>
          )}
        </div>
      )}
      <footer>
        <textarea
          ref={box}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={onKey}
          placeholder="type here, enter to send"
          rows={1}
          disabled={busy}
        />
        <button onClick={busy ? stop : send} className={busy ? "stop" : "send"}>
          {busy ? "stop" : "send"}
        </button>
      </footer>
      {showSettings && <SettingsPanel onClose={() => setShowSettings(false)} />}
      {showMemory && (
        <MemoryPanel
          memories={memories}
          onSearch={(q) => void refreshMemory(q)}
          onClose={() => setShowMemory(false)}
          onChanged={() => void refreshMemory()}
        />
      )}
      {approval && (
        <ApprovalModal req={approval} onAnswer={answerApproval} />
      )}
    </div>
  );
}
