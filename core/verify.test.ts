// tests for verify.ts. run with: npx tsx --test verify.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { VerificationEngine, type RunFn } from "./verify.js";

function fixture(scripts: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "silk-verify-"));
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "d", scripts }));
  return dir;
}

const okRun: RunFn = async () => ({ code: 0, out: "all good" });

test("all passing checks produce ok report", async () => {
  const dir = fixture({ test: "node -e 1", build: "node -e 1" });
  const engine = new VerificationEngine(dir, okRun);
  const report = await engine.run();
  assert.equal(report.ok, true);
  const names = report.checks.map((c) => c.name);
  assert.ok(names.includes("npm test"));
  assert.ok(names.includes("npm run build"));
  assert.ok(names.includes("git diff stat"));
});

test("a failing check makes the report fail but completes", async () => {
  const dir = fixture({ test: "node -e 1" });
  const run: RunFn = async (cmd, args) => {
    if (cmd === "npm" && args[0] === "test") return { code: 1, out: "FAIL: boom" };
    return { code: 0, out: "ok" };
  };
  const engine = new VerificationEngine(dir, run);
  const report = await engine.run();
  assert.equal(report.ok, false);
  const failed = report.checks.find((c) => c.name === "npm test");
  assert.ok(failed && !failed.ok);
  assert.ok(failed.output.includes("boom"));
});

test("custom checks run and a throwing one becomes a failure", async () => {
  const dir = fixture({});
  const engine = new VerificationEngine(dir, okRun);
  engine.registerCheck("custom pass", async () => ({ name: "custom pass", ok: true, output: "fine", ms: 1 }));
  engine.registerCheck("custom boom", async () => {
    throw new Error("kaput");
  });
  const report = await engine.run();
  assert.equal(report.ok, false);
  assert.ok(report.checks.some((c) => c.name === "custom pass" && c.ok));
  const boom = report.checks.find((c) => c.output.includes("kaput"));
  assert.ok(boom && !boom.ok);
});

test("tsc check is added when tsconfig exists", async () => {
  const dir = fixture({});
  writeFileSync(join(dir, "tsconfig.json"), "{}");
  const seen: string[] = [];
  const run: RunFn = async (cmd, args) => {
    seen.push(cmd + " " + args.join(" "));
    return { code: 0, out: "ok" };
  };
  const engine = new VerificationEngine(dir, run);
  const report = await engine.run();
  assert.ok(report.checks.some((c) => c.name === "tsc --noEmit"));
  assert.ok(seen.some((s) => s.includes("tsc")));
});
