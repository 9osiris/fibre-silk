// windows shakedown harness for silk. run on the windows pc with:
//   npx tsx scripts/windows-shakedown/run.ts
// no electron, no api key needed. each check prints PASS/FAIL/SKIP with a
// one-line detail. exit code = number of failures.
// windows-only checks SKIP on other platforms; the rest run everywhere.
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { join } from "node:path";
import { createLocalTools } from "../../core/tools.js";
import type { AgentTool } from "../../core/agent.js";
import { PermissionStore } from "../../core/permissions.js";
import { ToolRuntime } from "../../core/runtime.js";
import { defaultStore, keyringAvailable } from "../../core/credentials.js";
import { createRegistry, DEFAULT_MODELS } from "../../core/models.js";
import { route } from "../../core/router.js";
import type { TaskKind } from "../../core/router.js";
import { FibreStore } from "../../core/store.js";
import {
  reconcileInterrupted,
  buildRecoveryReport,
  recoveryDecision,
} from "../../core/recovery.js";
import { MemoryService } from "../../core/memory.js";
import { syncWorkspace } from "../../core/indexer.js";

const WIN = process.platform === "win32";

type Status = "PASS" | "FAIL" | "SKIP";
interface Result {
  name: string;
  status: Status;
  detail: string;
}
const results: Result[] = [];

function record(name: string, status: Status, detail: string): void {
  results.push({ name, status, detail });
  console.log(`${status}  ${name}  (${detail})`);
}

async function check(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    record(name, "PASS", await fn());
  } catch (err) {
    record(name, "FAIL", err instanceof Error ? err.message : String(err));
  }
}

async function winOnly(name: string, fn: () => Promise<string>): Promise<void> {
  if (!WIN) {
    record(name, "SKIP", "windows only");
    return;
  }
  await check(name, fn);
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
}

async function rejectsWith(
  p: Promise<unknown>,
  re: RegExp,
  what: string
): Promise<string> {
  try {
    await p;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    assert(re.test(msg), `${what}: wrong error: ${msg.slice(0, 120)}`);
    return msg.slice(0, 120);
  }
  throw new Error(`${what}: expected rejection, got success`);
}

const tools = createLocalTools();
const byName = (n: string): AgentTool => {
  const t = tools.get(n);
  if (!t) throw new Error(`tool missing: ${n}`);
  return t;
};

async function main(): Promise<void> {
  console.log(`silk windows shakedown, platform=${process.platform}`);

  // temp root with spaces and unicode in the path
  const root = join(tmpdir(), `silk shakedown \u00e9\u4e2d ${Date.now()}`);
  await mkdir(root, { recursive: true });
  const { setAllowedRoots } = await import("../../core/tools.js");
  setAllowedRoots([root]);

  const fsList = byName("fs_list");
  const fsRead = byName("fs_read");
  const fsWrite = byName("fs_write");
  const exec = byName("exec");

  await check("fs round-trip, spaces+unicode path", async () => {
    const p = join(root, "sub dir", "uni \u00e9", "hello.txt");
    const w = await fsWrite.run({ path: p, content: "hello silk" });
    assert(w.includes("wrote"), `write failed: ${w}`);
    const r = await fsRead.run({ path: p });
    assert(r === "hello silk", `read mismatch: ${r}`);
    const l = await fsList.run({ path: join(root, "sub dir") });
    assert(l.includes("uni \u00e9"), `list missing dir: ${l}`);
    // empty writes are legal
    await fsWrite.run({ path: join(root, "empty.txt"), content: "" });
    assert((await fsRead.run({ path: join(root, "empty.txt") })) === "", "empty read mismatch");
    return "write/read/list ok";
  });

  await check("path traversal via .. refused", async () => {
    const msg = await rejectsWith(
      fsRead.run({ path: join(root, "..", "nope.txt") }),
      /refused/,
      "traversal"
    );
    return msg;
  });

  await check("absolute path outside roots refused", async () => {
    const outside = WIN
      ? "C:\\Windows\\System32\\drivers\\etc\\hosts"
      : "/etc/hostname";
    const msg = await rejectsWith(fsRead.run({ path: outside }), /refused/, "absolute");
    return msg;
  });

  await winOnly("junction escape refused", async () => {
    const outside = join(tmpdir(), `silk-shakedown-outside-${Date.now()}`);
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, "secret.txt"), "top secret");
    const link = join(root, "evil");
    await symlink(outside, link, "junction");
    const msg = await rejectsWith(
      fsRead.run({ path: join(link, "secret.txt") }),
      /refused/,
      "junction"
    );
    await rm(outside, { recursive: true, force: true });
    return msg;
  });

  if (!WIN) {
    await check("symlink escape refused", async () => {
      const outside = join(tmpdir(), `silk-shakedown-outside-${Date.now()}`);
      await mkdir(outside, { recursive: true });
      await writeFile(join(outside, "secret.txt"), "top secret");
      const link = join(root, "evil-link");
      await symlink(outside, link);
      const msg = await rejectsWith(
        fsRead.run({ path: join(link, "secret.txt") }),
        /refused/,
        "symlink"
      );
      await rm(outside, { recursive: true, force: true });
      return msg;
    });
  }

  await check("exec basic commands", async () => {
    const loc = WIN
      ? await exec.run({ command: "Get-Location" })
      : await exec.run({ command: "pwd" });
    assert(/[A-Za-z]:\\|\//.test(loc), `location odd: ${loc.slice(0, 60)}`);
    const node = await exec.run({ command: "node --version" });
    assert(node.trim().startsWith("v"), `node version odd: ${node}`);
    return `loc+node ok`;
  });

  await check("exec failing command reports exit code", async () => {
    const out = await exec.run({ command: "exit 3" });
    assert(out.includes("exit 3"), `no exit code: ${out.slice(0, 120)}`);
    return out.slice(0, 60);
  });

  await check("exec stderr captured separately", async () => {
    const out = WIN
      ? await exec.run({ command: "[Console]::Error.WriteLine('boom-err')" })
      : await exec.run({ command: "echo boom-err >&2" });
    assert(out.includes("stderr:") && out.includes("boom-err"), `stderr missing: ${out.slice(0, 120)}`);
    return "stderr labeled";
  });

  // count shell processes before/after a timed-out command
  const shellCount = async (): Promise<number> => {
    const out = WIN
      ? await exec.run({
          command:
            "(Get-Process powershell -ErrorAction SilentlyContinue | Measure-Object).Count",
        })
      : await exec.run({ command: "pgrep -f '^sleep 10$' | wc -l" });
    const n = parseInt(out.trim(), 10);
    assert(!Number.isNaN(n), `count parse failed: ${out.slice(0, 60)}`);
    return n;
  };

  await check("exec timeout kills the process", async () => {
    const before = await shellCount();
    const cmd = WIN ? "Start-Sleep 10" : "sleep 10";
    const out = await exec.run({ command: cmd, timeoutMs: 1500 });
    assert(/timed out after 1500ms/.test(out), `no timeout: ${out.slice(0, 120)}`);
    await new Promise((r) => setTimeout(r, 1000));
    const after = await shellCount();
    assert(after <= before, `shell leaked: before=${before} after=${after}`);
    return `timeout reported, shells ${before}->${after}`;
  });

  await check("exec cancellation kills the process", async () => {
    // count marker shells; the cancelled command uses sleep 30 so it
    // cannot be confused with the timeout test's sleep 10
    const countMarker = async (): Promise<number> => {
      const out = WIN
        ? await exec.run({
            command:
              "(Get-Process powershell -ErrorAction SilentlyContinue | Measure-Object).Count",
          })
        : await exec.run({ command: "pgrep -f '^sleep 30$' | wc -l" });
      return parseInt(out.trim(), 10) || 0;
    };
    const before = await countMarker();
    const ac = new AbortController();
    const cmd = WIN ? "Start-Sleep 30" : "sleep 30";
    const p = exec.run({ command: cmd }, { signal: ac.signal });
    setTimeout(() => ac.abort(), 500);
    await rejectsWith(p, /cancelled/, "cancel");
    await new Promise((r) => setTimeout(r, 1000));
    const after = await countMarker();
    assert(after <= before, `shell leaked after cancel: ${before}->${after}`);
    return "cancelled, no orphan";
  });

  await check("exec large output truncated", async () => {
    const out = await exec.run({
      command: "node -e \"console.log('x'.repeat(200000))\"",
    });
    assert(typeof out === "string", "not a string");
    assert(out.length <= 16384, `not truncated: ${out.length}`);
    assert(out.length >= 16000, `too short, maybe failed: ${out.length}`);
    return `${out.length} chars`;
  });

  await check("permissions: defaults", async () => {
    const store = new PermissionStore();
    assert(store.check("fs_read") === "allow_always", "read not allowed");
    assert(store.check("fs_list") === "allow_always", "list not allowed");
    assert(store.check("fs_write") === "ask", "write not ask");
    assert(store.check("exec") === "ask", "exec not ask");
    return "read allowed, write/exec ask";
  });

  await check("permissions: allow_once consumed", async () => {
    const store = new PermissionStore();
    store.grant("fs_write", "allow_once");
    assert(store.check("fs_write") === "allow_once", "grant missing");
    store.consume("fs_write");
    assert(store.check("fs_write") === "ask", "not consumed");
    store.grant("exec", "deny");
    assert(store.check("exec") === "deny", "deny missing");
    return "grant/consume/deny ok";
  });

  await check("permissions: runtime denies write with no approver", async () => {
    const rt = new ToolRuntime(tools.all(), new PermissionStore(), {});
    const res = await rt.execute(
      "fs_write",
      { path: join(root, "denied.txt"), content: "x" },
      "c1"
    );
    assert(!res.ok && res.output === "denied by user", `unexpected: ${res.output}`);
    return "denied, never hung";
  });

  await check("permissions: runtime allows write with approver", async () => {
    const rt = new ToolRuntime(tools.all(), new PermissionStore(), {
      approve: async () => "allow_once",
    });
    const p = join(root, "allowed.txt");
    const res = await rt.execute("fs_write", { path: p, content: "yes" }, "c2");
    assert(res.ok, `write failed: ${res.output}`);
    assert((await fsRead.run({ path: p })) === "yes", "content mismatch");
    return "approver gated, write landed";
  });

  await check("permissions: runtime enforces deny", async () => {
    const store = new PermissionStore();
    store.grant("exec", "deny");
    const rt = new ToolRuntime(tools.all(), store, {
      approve: async () => "allow_once",
    });
    const res = await rt.execute("exec", { command: "echo hi" }, "c3");
    assert(!res.ok && res.output === "denied by policy", `unexpected: ${res.output}`);
    return "deny wins over approver";
  });

  await check("vault: set/get/delete round-trip", async () => {
    const store = defaultStore();
    const backend = keyringAvailable() ? "windows credential manager" : "file fallback";
    const account = `shakedown-${Date.now()}`;
    const value = `s3cr3t-${Math.random().toString(36).slice(2)}`;
    await store.set("Silk", account, value);
    const got = await store.get("Silk", account);
    assert(got === value, "get mismatch");
    await store.delete("Silk", account);
    assert((await store.get("Silk", account)) === null, "delete failed");
    return `round-trip ok via ${backend}`;
  });

  await check("router: all kinds route without network", async () => {
    const registry = createRegistry(DEFAULT_MODELS);
    const kinds: TaskKind[] = ["fast", "reasoning", "coding", "review", "vision"];
    const lines: string[] = [];
    for (const kind of kinds) {
      const d = route({ kind }, registry);
      assert(d.model && d.provider && d.reason, `${kind}: empty decision`);
      lines.push(`${kind} -> ${d.model} via ${d.provider}`);
    }
    const vision = route({ kind: "vision" }, registry);
    const vinfo = registry.get(vision.model);
    assert(vinfo?.supportsVision, "vision model lacks vision");
    const coder = route({ kind: "coding" }, registry);
    const reviewer = route({ kind: "review", coderModel: coder.model }, registry);
    lines.push(`review(${coder.model}) -> ${reviewer.model} via ${reviewer.provider}`);
    if (reviewer.provider !== coder.provider) {
      lines.push("cross-provider review confirmed");
    }
    console.log("    " + lines.join("\n    "));
    return `${kinds.length} kinds routed`;
  });

  // phase 3: durable store, recovery, memory, workspace index.
  // no electron, no api key; all state in a temp dir.
  await check("persistence: store survives reopen", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fibre-shake-"));
    try {
      const s1 = await FibreStore.open(dir);
      const sess = s1.createSession({ title: "shake" });
      const t = s1.createTask({ sessionId: sess.id, goal: "shake task" });
      s1.updateTask(t.id, { status: "executing", stage: "implement" });
      s1.saveCheckpoint(t.id, "implement", { stage: "implement" });
      s1.flush();
      s1.close();
      const s2 = await FibreStore.open(dir);
      assert(s2.getSession(sess.id)?.title === "shake", "session lost");
      assert(s2.getTask(t.id)?.stage === "implement", "task lost");
      assert(s2.latestCheckpoint(t.id)?.stage === "implement", "checkpoint lost");
      s2.close();
      return "session+task+checkpoint round-trip ok";
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await check("recovery: interrupted task is found, never completed", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fibre-shake-"));
    try {
      const s = await FibreStore.open(dir);
      const t = s.createTask({ goal: "mid-run" });
      s.updateTask(t.id, { status: "executing", stage: "test" });
      s.saveCheckpoint(t.id, "test", { stage: "test" });
      const found = reconcileInterrupted(s);
      assert(found.length === 1, "interrupted not detected");
      assert(s.getTask(t.id)?.status === "interrupted", "not marked interrupted");
      const report = await buildRecoveryReport(s, t.id);
      assert(report !== null, "no report");
      assert(recoveryDecision(report!).canResume, "should be resumable with checkpoint");
      s.close();
      return "interrupted detected, resumable";
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await check("memory: secret refusal and search", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fibre-shake-"));
    try {
      const s = await FibreStore.open(dir);
      const mem = new MemoryService(s);
      mem.remember({
        category: "project_fact",
        content: "test command is npx tsx --test",
        provenance: "test_verified",
      });
      assert(mem.search("test command").length >= 1, "search miss");
      let refused = false;
      try {
        mem.remember({
          category: "project_fact",
          content: "api_key = sk-1234567890abcdef1234567890abcdef",
          provenance: "user_statement",
        });
      } catch {
        refused = true;
      }
      assert(refused, "secret-shaped memory was stored");
      s.close();
      return "search ok, secrets refused";
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await check("workspace index: sync and incremental diff", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "fibre-shake-ws-"));
    try {
      await mkdir(path.join(dir, "src"), { recursive: true });
      await writeFile(path.join(dir, "src", "a.ts"), "export const a = 1;\n");
      await writeFile(path.join(dir, "package.json"), "{}\n");
      const s = await FibreStore.open(path.join(dir, ".fibre"));
      const first = await syncWorkspace(s, dir);
      assert(first.index.files.length >= 2, "index too small");
      assert(first.diff === null, "first sync should have no diff");
      await writeFile(path.join(dir, "src", "b.ts"), "export const b = 2;\n");
      const second = await syncWorkspace(s, dir);
      assert(second.diff !== null, "second sync missing diff");
      assert(
        second.diff!.created.some((p) => p.endsWith("b.ts")),
        "created file not detected"
      );
      s.close();
      return "index + incremental diff ok";
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  await rm(root, { recursive: true, force: true });

  const fails = results.filter((r) => r.status === "FAIL").length;
  const skips = results.filter((r) => r.status === "SKIP").length;
  console.log(
    `\n${results.length - fails - skips} passed, ${fails} failed, ${skips} skipped`
  );
  process.exit(fails);
}

main().catch((err) => {
  console.error("harness crashed:", err);
  process.exit(99);
});
