// tests for the silk tool registry and local pc tools.
// run with: npx tsx --test tools.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import * as os from "node:os";
import * as path from "node:path";
import { promises as fs } from "node:fs";
import {
  ToolRegistry,
  createLocalTools,
  setAllowedRoots,
  getAllowedRoots,
} from "./tools.js";
import { StubComputer } from "./computer.js";

async function withTmp(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "silk-test-"));
  const prev = getAllowedRoots();
  setAllowedRoots([dir]);
  try {
    await fn(dir);
  } finally {
    setAllowedRoots(prev);
    await fs.rm(dir, { recursive: true, force: true });
  }
}

test("registry list/get", () => {
  const r = new ToolRegistry();
  assert.deepEqual(r.list(), []);
  const tools = createLocalTools();
  for (const t of tools.list()) r.register({ def: t, run: async () => "x" });
  const names = r.list().map((d) => (d as { name: string }).name);
  assert.ok(names.includes("fs_list"));
  assert.ok(names.includes("fs_read"));
  assert.ok(names.includes("fs_write"));
  assert.ok(names.includes("exec"));
  assert.ok(r.get("fs_write"));
  assert.equal(r.get("nope"), undefined);
});

test("fs_write refuses paths outside allowedRoots", async () => {
  await withTmp(async () => {
    const tools = createLocalTools();
    const write = tools.get("fs_write")!;
    await assert.rejects(
      write.run({ path: "/etc/silk-should-not-exist", content: "x" }),
      /outside allowedRoots/
    );
    await assert.rejects(
      write.run({ path: "C:\\Windows\\Temp\\x.txt", content: "x" }),
      /outside allowedRoots/
    );
  });
});

test("path traversal with .. is refused", async () => {
  await withTmp(async (dir) => {
    const tools = createLocalTools();
    const evil = path.join(dir, "sub", "..", "..", "escape.txt");
    await assert.rejects(
      tools.get("fs_write")!.run({ path: evil, content: "x" }),
      /outside allowedRoots/
    );
  });
});

test("symlink escape is refused", async () => {
  await withTmp(async (dir) => {
    const tools = createLocalTools();
    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "silk-outside-"));
    try {
      const secret = path.join(outsideDir, "secret.txt");
      await fs.writeFile(secret, "top secret");
      const link = path.join(dir, "link");
      await fs.symlink(outsideDir, link, "dir");
      await assert.rejects(
        tools.get("fs_read")!.run({ path: path.join(link, "secret.txt") }),
        /outside allowedRoots/
      );
      await assert.rejects(
        tools.get("fs_list")!.run({ path: link }),
        /outside allowedRoots/
      );
    } finally {
      await fs.rm(outsideDir, { recursive: true, force: true });
    }
  });
});

test("fs_write allows empty content", async () => {
  await withTmp(async (dir) => {
    const tools = createLocalTools();
    const p = path.join(dir, "empty.txt");
    const w = await tools.get("fs_write")!.run({ path: p, content: "" });
    assert.ok(w.startsWith("wrote"));
    const r = await tools.get("fs_read")!.run({ path: p });
    assert.equal(r, "");
  });
});

test("exec cwd outside allowedRoots is refused", async () => {
  await withTmp(async () => {
    const tools = createLocalTools();
    const exec = tools.get("exec")!;
    await assert.rejects(
      exec.run({ command: "echo hi", cwd: "/etc" }),
      /outside allowedRoots/
    );
  });
});

test("exec denylist blocks powershell destructive patterns", async () => {
  const tools = createLocalTools();
  const exec = tools.get("exec")!;
  for (const cmd of [
    "Remove-Item C:\\ -Recurse -Force",
    "Format-Volume -DriveLetter C",
    "Clear-Disk -Number 0 -RemoveData",
    "Stop-Computer -Force",
    "rd /s /q C:\\Windows",
  ]) {
    const res = await exec.run({ command: cmd });
    assert.ok(res.startsWith("refused:"), `not blocked: ${cmd}`);
  }
});

test("fs_write then fs_read round-trips inside allowedRoots", async () => {
  await withTmp(async (dir) => {
    const tools = createLocalTools();
    const p = path.join(dir, "sub", "note.txt");
    const w = await tools.get("fs_write")!.run({ path: p, content: "hello silk" });
    assert.ok(w.startsWith("wrote"));
    const r = await tools.get("fs_read")!.run({ path: p });
    assert.equal(r, "hello silk");
    const l = await tools.get("fs_list")!.run({ path: path.join(dir, "sub") });
    assert.ok(l.includes("note.txt"));
  });
});

test("fs_read caps output", async () => {
  await withTmp(async (dir) => {
    const tools = createLocalTools();
    const p = path.join(dir, "big.txt");
    await tools.get("fs_write")!.run({ path: p, content: "a".repeat(100) });
    const r = await tools.get("fs_read")!.run({ path: p, maxBytes: 10 });
    assert.equal(r, "a".repeat(10) + "\n...(truncated)");
  });
});

test("exec denylist blocks destructive commands", async () => {
  const tools = createLocalTools();
  const exec = tools.get("exec")!;
  for (const cmd of [
    "format C: /q",
    "diskpart",
    "reg delete HKLM\\Software\\x /f",
    "bcdedit /delete {current}",
    "shutdown /s /t 0",
  ]) {
    const res = await exec.run({ command: cmd });
    assert.ok(res.startsWith("refused:"), `not blocked: ${cmd}`);
  }
});

test("exec runs a harmless command", async () => {
  const tools = createLocalTools();
  const res = await tools.get("exec")!.run({ command: "echo hello" });
  assert.ok(res.includes("hello"), `unexpected output: ${res}`);
});

test("stub computer throws a clear not-wired message", async () => {
  const stub = new StubComputer();
  assert.equal(stub.id, "stub");
  await assert.rejects(() => stub.launch(), /not wired yet/);
});
