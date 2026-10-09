# Silk architecture

Product: Silk by Layered Innovation | Powered by Fibre.
A Windows-first personal AI agent desktop app. Clean-room implementation.
No reference-project code, branding, or trademarks are used anywhere.

## Reference survey (2026-10-06)

Surveyed the reference repository structurally (shallow clone to /tmp,
read READMEs, directory layout, dependency lists, and file headers only).
No code was copied. Key findings:

- Shape: an Electron shell that bundles a local server. The desktop app
  starts a Next.js server on loopback and loads it in a window. State in
  a local data dir, logs to the OS log dir. This packaging model is proven
  and worth reusing as a pattern.
- Server: chat engine (~900 lines), session manager (~1500 lines),
  planner (~450 lines), memory (~760 lines), plus one integration module
  per external service (apps, email, phone, cloud computers, mac computer
  use, routines, watches, channels).
- Secrets: a thin keychain module (macOS Keychain). API routes for
  sessions, screens, vault, routines, phone, uploads.
- Provider core is a 33-line OpenAI client with a hardcoded default model
  from env. Single-provider by design.
- Business layer: workspaces-as-orgs, bot teams, a hosted credit/billing
  backend (cloud/), phone-number provisioning, SaaS sign-in. All of this
  is removed in Silk; the product is one person and their agents.
- License: FSL-1.1-ALv2 (fair source), trademark on the reference name.
  Nothing is lifted, so neither attaches to Silk.

Verdict: the packaging pattern (desktop shell + local runtime, secrets in
the main process, approval gates before acting) is sound. The provider
model, business concepts, macOS specifics, and hosted-service coupling are
not reused. Silk's architecture below is designed from the spec, not from
the reference tree.

## Runtime decision: Electron

Evaluated Electron vs Tauri vs a local-web hybrid against: Windows
integration, packaging, process management, Node ecosystem access for the
agent runtime, and developer experience.

- Tauri is lighter on memory but its Rust core would complicate the agent
  runtime, which wants Node's process/filesystem ecosystem and npm
  libraries.
- A browser-only local web app cannot manage subprocesses or credential
  storage natively.
- Electron gives a real Windows installer (nsis), a Node main process for
  the agent runtime, and straightforward IPC. Memory cost is acceptable
  for a personal workstation app.

Decision: Electron. The agent runtime lives in the main process, never in
the renderer. Secrets never cross the preload bridge except as masked
metadata.

## Silk architecture (phase 1)

```
Silk (Electron, Windows)
  ui/                 React chat + settings (renderer, no secrets, no node)
    ↕ IPC (preload bridge: silk:chat, silk:settings, silk:events)
  electron/           main process: window, IPC wiring, lifecycle
    ↓
  core/               agent runtime (plain TS, fully unit tested)
    agent.ts          tool loop, task state machine, loop guards
    providers.ts      provider abstraction (openai-compatible, anthropic)
    models.ts         model registry with capabilities + costs
    tools.ts          tool registry + local PC tools (fs, powershell)
    approvals.ts      permission levels gating tool execution
    sessions.ts       persistent sessions and task state
    memory.ts         (phase 3) categorized persistent memory
    computer.ts       computer provider interface (local + cloud later)
    platform/         windows/ macos/ linux/ shared/ abstraction
    credentials.ts    Windows Credential Manager via @napi-rs/keyring
    events.ts         agent.* structured event bus
    config.ts         versioned config schema with migrations
    git.ts            git inspection tools (read-only unless permitted)
```

Provider capabilities are explicit per model: tool calling, vision,
streaming, reasoning, structured output, computer use, web search, long
context. The agent checks capabilities before attempting an operation.

Permissions: safe (read), moderate (edit, install, build), dangerous
(delete trees, arbitrary binaries, system settings, destructive git).
Moderate and dangerous require approval; the gate sits between the agent
and tool execution, not in the UI layer. Approvals: allow once, allow for
session, always allow, deny.

## What is deliberately not in phase 1

Multi-agent delegation, persistent memory categories, plugin/MCP system,
phone/email/chat integrations, cloud computer provisioning. Interfaces are
shaped so these arrive without rewrites. Nothing is faked: unwired
features throw clear "not wired yet" errors behind clean interfaces.

---

## Phase 2: multi-model coding agent (2026-10-06)

Goal: turn the tool-using agent into a genuinely capable multi-model
coding agent. No cloud infra in this phase.

### New components

```
core/
  credentials.ts   windows credential manager vault (@napi-rs/keyring),
                   migration from plaintext silk.json, in-memory/file
                   fallback for dev. secrets never reach the renderer.
  events.ts        typed SilkEvent protocol (below). single source of truth
                   for agent state; the ui renders from events, never from
                   string sniffing.
  task.ts          task state machine: queued, planning, executing,
                   waiting_for_user, validating, completed, failed,
                   cancelled. persisted enough to resume.
  models.ts        model registry: id, provider, displayName, contextWindow,
                   capability flags, relativeCost. default entries are data,
                   user-editable via config. runtime never branches on names.
  router.ts        deterministic ModelRouter. task kind + required
                   capabilities + prefs -> { model, provider, reason,
                   capabilities }. kinds: simple, reasoning, coding, review,
                   vision, fast.
  agent.ts         upgraded: execution limits (maxSteps, maxWallMs,
                   maxToolCalls, toolTimeoutMs), AbortSignal cancellation,
                   loop detection (same tool+args repeated), provider
                   failure recovery, malformed tool-call recovery.
                   routes tool execution through ToolRuntime.
  runtime.ts       ToolRuntime: the permission gate between agent and tools.
                   checks policy, emits waiting_for_approval, awaits the
                   approver, enforces timeouts, propagates cancellation.
  permissions.ts   PolicyLevel: read, write, execute, delete, network, git.
                   Permission: allow_once, allow_session, allow_always,
                   deny. TOOL_LEVELS maps tool name -> level.
  planner.ts       Plan { goal, steps[] }, step states pending, active,
                   completed, failed, skipped. generatePlan via model JSON.
  verify.ts        VerificationEngine: detects project, runs applicable
                   checks (git diff stat, tsc, lint, tests, build),
                   extensible check registry. failures return to the agent.
  reviewer.ts      independent review stage. structured findings
                   { status, findings[{ severity, file, description }] }.
                   prefers a different provider than the coder.
  coding.ts        the coding loop orchestrator: UNDERSTAND, PLAN, INSPECT,
                   IMPLEMENT, TEST, REVIEW, FIX, TEST, VERIFY, COMPLETE.
                   skips stages for trivial tasks. multi-model per stage
                   via a provider factory + router.
  workspace.ts     WorkspaceAnalyzer: languages, frameworks, package
                   manager, build, tests, git, entry points, src/test dirs.
                   compact description, cached.
  context.ts       ContextManager: assembles context from task, plan,
                   files, tool results, verification, findings, memory.
                   budgets per part, truncates large outputs, keeps errors.
  git.ts           read-only git inspection: status, diff stat, changed
                   files before/after. never commits without approval.
```

### Typed event protocol (core/events.ts)

```ts
export type SilkEvent =
  | { type: "agent.started"; taskId: string; goal: string }
  | { type: "agent.planning"; taskId: string }
  | { type: "agent.plan_created"; taskId: string; plan: Plan }
  | { type: "agent.stage"; taskId: string; stage: Stage; model: string; provider: string }
  | { type: "agent.text"; taskId: string; delta: string }
  | { type: "agent.tool_requested"; taskId: string; callId: string; tool: string }
  | { type: "agent.tool_started"; taskId: string; callId: string; tool: string }
  | { type: "agent.tool_completed"; taskId: string; callId: string; tool: string; ok: boolean; ms: number }
  | { type: "agent.tool_failed"; taskId: string; callId: string; tool: string; error: string }
  | { type: "agent.retrying"; taskId: string; attempt: number; reason: string }
  | { type: "agent.waiting_for_approval"; taskId: string; callId: string; tool: string; summary: string }
  | { type: "agent.validation_started"; taskId: string }
  | { type: "agent.completed"; taskId: string; summary: string; filesChanged: FileChanges }
  | { type: "agent.failed"; taskId: string; error: string }
  | { type: "agent.cancelled"; taskId: string };
export type Stage = "understand" | "plan" | "inspect" | "implement" | "test" | "review" | "fix" | "verify" | "complete";
```

The old AgentEvent (text/toolStart/toolEnd/step/done) is replaced by this.
The ui renders stage, model-in-use, tool activity, files changed, test
results, and approvals purely from these events.

### Agent API (phase 2)

```ts
export interface ExecutionLimits {
  maxSteps?: number;       // default 12
  maxWallMs?: number;      // default 10 min
  maxToolCalls?: number;   // default 40
  toolTimeoutMs?: number;  // default 120000
}
export interface ApprovalRequest {
  callId: string; tool: string;
  args: Record<string, unknown>;
  level: PolicyLevel; summary: string;
}
export type ApprovalDecision = "allow_once" | "allow_session" | "allow_always" | "deny";
export interface RunOptions extends ExecutionLimits {
  signal?: AbortSignal;
  onEvent?: (e: SilkEvent) => void;
  approve?: (req: ApprovalRequest) => Promise<ApprovalDecision>;
  taskId?: string;
}
export interface FileChanges { created: string[]; modified: string[]; deleted: string[] }
export interface RunResult {
  text: string; status: "completed" | "failed" | "cancelled";
  steps: number; toolCalls: number;
  inputTokens: number; outputTokens: number;
  filesChanged: FileChanges;
}
export class Agent {
  constructor(provider: Provider, tools: AgentTool[],
              opts?: { model?: string; systemPrompt?: string });
  run(task: string, opts?: RunOptions): Promise<RunResult>;
  cancel(): void;
}
export interface AgentTool {
  def: ToolDef;
  run(args: Record<string, unknown>, ctx?: { signal?: AbortSignal }): Promise<string>;
}
```

Multi-model in one task: the coding orchestrator holds
`providers: (modelId: string) => Provider` and constructs a stage-scoped
Agent per stage with the router-chosen model. All models go through the
same provider abstraction.

### Security model

- API keys live in Windows Credential Manager (service "Silk",
  account per provider) via `core/credentials.ts`. Never in plaintext
  files, never in git, never in logs, never in error messages, never sent
  to the renderer (the renderer only learns keySet true/false).
- `CredentialStore` interface with three implementations: `KeyringStore`
  (`@napi-rs/keyring`, loaded lazily through a bundler-safe dynamic
  require so the electron bundle never hard-fails without it),
  `FileStore` (dev-only 0600 JSON fallback, clearly labeled, used with a
  one-line console warning by `defaultStore()` when no OS vault loads),
  `MemoryStore` (tests).
- Config versions: `silk.json` without a version (or version 1) is legacy
  and may hold inline keys; version 2 is vault-backed. `saveConfig`
  strips key material for v2 files only, so legacy files keep
  round-tripping until the settings-save flow is rewired. `getApiKey` is
  the only function allowed to return key material (vault first, legacy
  inline fallback, null when absent). `validateConfig` messages are static
  strings; vault presence is checked by async `validateCredentials`.
- First run calls `migrateConfig(dir, store)`: moves each plaintext key
  into the vault, then rewrites silk.json as v2 without them. No-op when
  there is no file or the file is already v2.
- Packaging note: `@napi-rs/keyring` must be resolvable at runtime from
  the bundled main process (root dependencies + electron-builder native
  module handling). If it cannot load, the app degrades to the dev file
  store with a warning instead of crashing.
- Required wiring (not yet done): on startup run `migrateConfig`; on
  settings save, persist `apiKey` via `store.set(SERVICE_NAME, provider,
  key)` before `saveConfig`; when building providers, resolve keys with
  `getApiKey` instead of reading them from the config object.
- Tool denylist stays as a backstop; the permission layer is the real
  gate and it sits inside ToolRuntime, between the agent and tools.
- Cancellation kills the provider stream and terminates child processes
  (no orphaned PowerShell after stop).

## Phase 2.5 hardening (2026-10-06)

Validation and bug-fixing pass. No architectural rewrite; fixes are
surgical and each was found by actually running the code.

### Real bugs found and fixed

- **POSIX process-tree leak (core/tools.ts).** `killTree` only SIGKILLed
  the direct child, so `sh -c "sleep 10"` grandchildren orphaned and
  survived timeout and cancellation. Worse, `execFile` silently ignores
  the `detached` option on this node version, so the process-group kill
  could never work. Fixed by switching the exec tool from `execFile` to
  `spawn` (where `detached: true` verifiably creates a process group)
  and killing the negative pid on POSIX. Windows still uses
  `taskkill /PID /T /F`. Verified: no leftover processes after timeout
  or abort, repeatedly.
- **core/router.ts imported `./models` without the `.js` extension.**
  tsx and esbuild tolerate it, but `tsc --noEmit` under NodeNext does
  not. Surfaced when the shakedown harness pulled router.ts into the
  typecheck graph. One-line fix.

### Hardening already in place (verified by reading, not assumed)

- **realpath containment (core/tools.ts).** `resolveInside` resolves the
  real path (following symlinks/junctions, walking up through
  not-yet-existing ancestors for writes) and refuses anything outside
  `allowedRoots`. The shakedown harness proves `..` traversal, absolute
  outside paths, and symlink/junction escapes are all refused.
- **settings sanitization at the IPC boundary (electron/main.ts).**
  Renderer settings are whitelisted: `activeProvider` must be a known
  id, `baseUrl` must be http(s). The renderer only receives `keySet`
  booleans, never key material.
- **killTree on timeout as well as abort.** Both paths take the whole
  tree; the shakedown asserts process counts return to baseline.
- **denylist as backstop.** The PowerShell denylist blocks destructive
  patterns, but the permission gate in `runtime.ts` is the real
  boundary. `-ExecutionPolicy Bypass` is passed explicitly so the tool
  does not depend on machine policy.
- **renderer XSS note.** Chat markdown rendering escapes HTML before
  applying markdown tags; no unescaped HTML reaches the DOM.

### Shakedown harness

`scripts/windows-shakedown/run.ts` runs on the Windows PC with
`npx tsx scripts/windows-shakedown/run.ts` (no Electron, no API key).
18 checks covering filesystem containment, exec behavior/timeout/
cancellation/large output, the permission gate, vault round-trip, and
router decisions. Windows-only checks SKIP elsewhere. Exit code equals
the failure count.

### Explicitly not yet validated

- The NSIS installer has not been produced. Cross-building from this
  Linux container needs wine, which is not available here. The command
  is `npm run pack` on a Windows 10/11 machine with node 20+.
- No live run on Windows hardware yet.
- No live provider calls yet (all provider tests use recorded/fake
  transports in the unit suite).

---

## Phase 3: persistence, memory, workspace intelligence (2026-10-09)

Goal: durable, recoverable, project-aware. Four milestones, each tested
before the next: A storage, B recovery, C memory, D workspace.

### Storage decision

Evaluated on this machine before committing:

- `better-sqlite3`: native build failed in this dev container (node-gyp)
  and would be worse on a fresh Windows PC. Rejected.
- `node:sqlite`: works on Node 24 here, but Electron 38 ships Node 22
  where the module is flag-gated and flags cannot be set reliably in
  the packaged main process. Rejected for now.
- `sql.js`: real SQLite compiled to WASM. Zero native builds, runs in
  the Electron main process unchanged, real transactions, real indexes,
  real SQL migrations. Chosen.

Persistence model: the database lives in memory and is exported to
`<userData>/fibre.db` atomically (write tmp, fsync, rename) after
mutations, coalesced behind a dirty flag and always flushed on close.
The previous good export is kept as `fibre.db.bak`. If the main file is
corrupt, the loader renames it to `fibre.db.corrupt-<ts>`, falls back
to the backup, and reports the failure through diagnostics. Nothing is
silently discarded and the app never crashes on a bad database.

The runtime never touches SQL directly. Everything goes through typed
repository interfaces in `core/store.ts`:

```
SessionRepository   sessions + conversation history
TaskRepository      task lifecycle records + checkpoints
EventRepository     durable event journal (whitelist below)
ApprovalRepository  pending approval requests
MemoryRepository    memory records
WorkspaceRepository workspace records + index
```

Secrets stay in the credential vault. The database never holds API
keys, tokens, or cookies; memory writes with key-shaped content are
refused outright.

### Schema (v1)

- `schema_meta(version)`
- `sessions(id, title, workspace_id, status, config_json, messages_json, created_at, updated_at)`
- `tasks(id, session_id, workspace_id, goal, status, stage, plan_json, model_json, files_json, error, created_at, updated_at, finished_at)`
- `events(id, task_id, seq, ts, type, payload_json)` with an index on (task_id, seq)
- `approvals(id, task_id, call_id, tool, level, summary, args_json, status, decision, created_at, resolved_at)`
- `checkpoints(id, task_id, stage, state_json, created_at)` latest 3 per task
- `memories(id, workspace_id, category, content, provenance, confidence, importance, superseded_by, source, created_at, updated_at, expires_at)`
- `workspaces(id, root_path, display_name, info_json, index_json, last_scan, created_at, updated_at)`

Migrations are an ordered list applied inside transactions with the
version tracked in `schema_meta`. Tool outputs persisted on task records
are bounded; raw streams and giant outputs are never stored wholesale.

### Durable vs ephemeral events

Durable (journaled): `agent.started`, `agent.plan_created`,
`agent.stage`, `agent.tool_started`, `agent.tool_completed`,
`agent.tool_failed`, `agent.waiting_for_approval`, `agent.completed`,
`agent.failed`, `agent.cancelled`, plus `recovery.*` and
`checkpoint.created` diagnostics.

Ephemeral (UI only): `agent.text`, `agent.tool_requested`,
`agent.retrying`, `agent.validation_started`.

Op identity is the existing `callId`. An op with a durable
`agent.tool_started` but no matching completed/failed is *uncertain*
after a crash. Uncertain ops are never blindly retried; `exec` ops are
never auto-retried at all. They are surfaced in the recovery report.

### Task states (phase 3)

Existing: queued, planning, executing, waiting_for_user, validating,
completed, failed, cancelled. Added: `interrupted`, `recovering`,
`paused`. Startup reconciliation moves any non-terminal task found at
launch to `interrupted`. It is never moved to `completed`
automatically. Resume path: interrupted → recovering → executing.
Abandon: interrupted → cancelled. Restart: interrupted → queued with
the original goal.

### Checkpoints

Created after plan, after each stage, and after verification.
`state_json` holds stage, plan, filesChanged, verification summary,
and review note. Creation is a single transaction plus one atomic
export, so a crash mid-checkpoint leaves the previous checkpoint valid.

### Recovery invariants

1. Load last consistent state; validate plan shape before use.
2. Reconcile with the real workspace (git status) before resuming.
3. Ops that definitely completed are not repeated.
4. Uncertain ops are reported, never assumed failed or succeeded.
5. Pending approvals are restored and require fresh decisions; a
   missing response is never permission.
6. Resume only from a checkpoint stage boundary.

### Memory (core/memory.ts)

Categories: project_fact, architecture_decision, convention,
user_preference, known_issue, task_knowledge. Provenance:
user_statement, repo_observed, test_verified, model_inference,
unverified. Model inferences are stored as inferences, never upgraded
silently into facts. Retrieval is metadata filters plus a tokenized
in-memory inverted index with recency/confidence ordering and a hard
character budget (FTS5 is not compiled into the sql.js build, and the
phase spec prefers indexed search before embeddings anyway). Supersede
chains keep history: a corrected fact points at its replacement.

### Workspace intelligence (core/indexer.ts)

Incremental index over the existing workspace analyzer: bounded walk,
.gitignore-aware, default excludes (node_modules, .git, dist, build,
env/secret files), realpath containment so junctions are never
followed out of the root. Entries track mtime+size; diffs produce
created/modified/deleted/renamed sets. The index is a navigation aid
fed to the ContextManager; the model still reads real files before
consequential edits.

### Boundaries

Providers talk to models. The router picks models. The runtime
orchestrates. Tools act. Permissions authorize. Verification
validates. Persistence owns durable state. Memory and workspace
services own their records. The UI consumes events and IPC views only;
it never reads the database directly.
