# silk - a personal ai agent that actually does work [wip]

disclaimer: this is a real project under active development, not a finished product. it runs ai agents on your own windows pc using your own api keys. agents can read and write files and run terminal commands, so only point it at projects you trust it to touch. no warranty, use at your own risk.

## why i made this

i wanted a coding agent that lives on my machine, not in a browser tab. something that can take a goal, make a plan, inspect a project, edit code, run the tests, get reviewed, and verify its own work, using whatever model is best for each step. so im building it: an electron desktop app with a real agent runtime, a model router, a permission gate between the model and your filesystem, and a verification engine that refuses to let the agent declare victory without passing checks.

clean-room implementation. no code taken from anywhere, no reference product mentioned or used.

## the guide

you need node 20+ and a windows 10/11 machine for the real app. dev happens on any os.

```sh
npm install
npm run dev        # vite ui + electron shell
```

set your provider in the settings panel (gear icon). keys go to the windows credential manager, never into a plaintext file. hit "test connection" to confirm the key works.

```sh
cd core && npx tsx --test   # 156 unit tests
npx tsc --noEmit             # typecheck everything
npm run bundle:electron      # bundle the shell
npm run pack                 # windows nsis installer (run on windows)
```

to watch the coding loop work end to end without an api key:

```sh
npx tsx demo/run-demo.ts
```

this runs a scripted model through the real agent runtime against demo/buggy-ts: inspect, implement (writes a wrong fix on purpose), test fails, fix, test passes, cross-provider review, final verification.

## windows setup

prerequisites: windows 10/11 x64, node 20+, git for windows, powershell 5.1 (ships with windows).

```sh
npm install
npm run dev        # vite ui + electron shell
npm run pack       # builds release/Silk Setup <version>.exe (nsis, x64)
```

provider setup: open settings (gear icon), pick openai or anthropic, paste the key, hit save. the key goes to windows credential manager under the "Silk" service. the ui never sees the raw key again, only "key set". hit "test connection" to confirm it works before running a task.

to validate the runtime without electron or an api key:

```sh
npx tsx scripts/windows-shakedown/run.ts
```

22 checks: filesystem containment, powershell exec/timeout/cancellation, the permission gate, vault round-trip, router decisions, durable store, recovery, memory, workspace indexing. exit code is the failure count.

persistence (phase 3): sessions, tasks, memory, and workspace records live in a real sqlite database at `%APPDATA%\Silk\fibre.db` (kept next to silk.json). writes are exported atomically (tmp file, fsync, rename) with a last-good backup at `fibre.db.bak`. if the database file corrupts, it is quarantined to `fibre.db.corrupt-<timestamp>` and the backup is restored instead of crashing. api keys are never in the database; they stay in the credential vault.

sessions: every conversation is saved. the session chips under the header reopen, rename is not wired to a button yet (rename exists in the ipc), and the x deletes for real. set a "workspace folder" in settings and chat turns run the full coding loop against that project with a durable task record; leave it blank for plain chat.

recovery: if the app closes mid-task, the task is marked interrupted on the next launch, never silently completed. interrupted tasks appear in the recovery bar with resume (re-enters the loop from the last checkpoint), restart (same goal from scratch), or abandon. operations that were started but never confirmed finished are listed as uncertain, and pending approvals from the crashed session need fresh decisions. nothing auto-reruns.

memory: the memory button opens the memory browser. entries are typed (project fact, architecture decision, convention, user preference, known issue, task knowledge) with provenance (user statement, observed in repo, verified by tests, model inference, unverified). key-shaped content is refused. completed coding tasks save a few verified facts automatically (languages, build/test commands). memory is injected into later coding tasks within a small character budget, and other workspaces' project memory does not leak in.

workspaces: when a workspace folder is set, the project is indexed (file inventory with mtimes, test/entry point detection, .gitignore-aware, junction-safe) and re-diffed on each run so the agent gets fresh project facts without rescanning everything.

backup/export: copy `%APPDATA%\Silk\fibre.db` somewhere safe. a full json export of all tables is available from the store layer (`exportAll`); a settings-level export button is future work, not in the ui yet.

troubleshooting:

- execution policy errors: the exec tool already passes `-ExecutionPolicy Bypass`, so machine policy should not matter. if powershell itself is broken, nothing here will work.
- keyring unavailable: if windows credential manager cannot load, the app warns on the console and falls back to a dev file store. do not ship like that.
- long paths: windows caps paths at 260 chars unless long paths are enabled in the os. enable it if you work in deep trees.
- the installer is unsigned, so smartscreen will warn on first install. expected for local builds.

## how it works

- `core/agent.ts` - the agent loop: limits, cancellation, loop detection, retries
- `core/router.ts` - deterministic model router, no ml magic
- `core/coding.ts` - the coding loop: understand, plan, inspect, implement, test, review, fix, verify, complete
- `core/runtime.ts` + `core/permissions.ts` - the permission gate between the model and your tools
- `core/verify.ts` - runs tsc, tests, builds, and refuses fake success
- `core/reviewer.ts` - independent review stage, prefers a different provider than the coder
- `core/credentials.ts` - api keys in the os credential vault
- `core/store.ts` - durable sqlite storage (sql.js): sessions, tasks, events, approvals, checkpoints, memories, workspaces
- `core/recovery.ts` - crash reconciliation, recovery reports, resume/restart/abandon
- `core/memory.ts` - typed memory with provenance, secret refusal, ranked retrieval
- `core/indexer.ts` - incremental workspace index with .gitignore support and junction-safe walking
- `electron/` - the windows desktop shell
- `ui/` - the chat + agent status interface, sessions, recovery bar, memory browser

architecture details live in ARCHITECTURE.md.
