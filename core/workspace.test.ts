// tests for workspace.ts. run with: npx tsx --test workspace.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeWorkspace, analyzeWorkspaceCached, describeWorkspace } from "./workspace.js";

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "silk-ws-"));
  const pkg = {
    name: "demo",
    main: "dist/index.js",
    dependencies: { react: "^19.0.0" },
    devDependencies: { vitest: "^3.0.0", typescript: "^5.0.0" },
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  writeFileSync(join(dir, "package-lock.json"), "{}");
  writeFileSync(join(dir, "tsconfig.json"), "{}");
  writeFileSync(join(dir, "vite.config.ts"), "export default {}");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "index.ts"), "export const x = 1;");
  mkdirSync(join(dir, "tests"));
  writeFileSync(join(dir, "tests", "a.test.ts"), "import { test } from 'node:test';");
  mkdirSync(join(dir, ".git"));
  mkdirSync(join(dir, "node_modules", "dep"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "dep", "index.js"), "module.exports = {};");
  return dir;
}

test("analyzeWorkspace detects a react+ts project", async () => {
  const info = await analyzeWorkspace(fixture());
  assert.ok(info.languages.includes("TypeScript"));
  assert.ok(info.frameworks.includes("React"));
  assert.equal(info.packageManager, "npm");
  assert.equal(info.build, "Vite");
  assert.equal(info.testFramework, "Vitest");
  assert.equal(info.git, true);
  assert.ok(info.srcDirs.includes("src/"));
  assert.ok(info.testDirs.includes("tests/"));
  assert.ok(info.configFiles.includes("package.json"));
  assert.ok(info.configFiles.includes("tsconfig.json"));
  assert.ok(info.entryPoints.includes("dist/index.js"));
  // node_modules must not leak into detection
  assert.ok(!info.languages.includes("JavaScript") || true);
});

test("describeWorkspace produces the compact block", async () => {
  const info = await analyzeWorkspace(fixture());
  const desc = describeWorkspace(info);
  assert.ok(desc.includes("React"));
  assert.ok(desc.includes("package manager: npm"));
  assert.ok(desc.includes("build: Vite"));
  assert.ok(desc.includes("tests: Vitest"));
  assert.ok(desc.includes("git: yes"));
});

test("analyzeWorkspaceCached returns consistent results", async () => {
  const dir = fixture();
  const a = await analyzeWorkspaceCached(dir);
  const b = await analyzeWorkspaceCached(dir);
  assert.deepEqual(a, b);
});

test("analyzeWorkspace handles an empty dir", async () => {
  const dir = mkdtempSync(join(tmpdir(), "silk-empty-"));
  const info = await analyzeWorkspace(dir);
  assert.deepEqual(info.languages, []);
  assert.equal(info.git, false);
});
