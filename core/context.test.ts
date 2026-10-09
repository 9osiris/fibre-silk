// tests for context.ts. run with: npx tsx --test context.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { assembleContext } from "./context.js";

test("under-budget parts pass through untouched", () => {
  const out = assembleContext([{ label: "a", text: "hello" }], 1000);
  assert.equal(out, "## a\nhello");
});

test("over-budget part truncates with a marker", () => {
  const text = "x".repeat(1000);
  const out = assembleContext([{ label: "big", text, budget: 100 }], 10000);
  assert.ok(out.includes("truncated"));
  assert.ok(out.length < 1000);
});

test("error lines are hoisted when truncating", () => {
  const lines = Array.from({ length: 50 }, (_, i) => "line " + i);
  lines[40] = "ERROR: something failed badly";
  const text = lines.join("\n");
  const out = assembleContext([{ label: "log", text, budget: 200 }], 10000);
  assert.ok(out.includes("ERROR: something failed badly"));
  // hoisted block comes before the truncated body
  assert.ok(out.indexOf("ERROR:") < out.indexOf("truncated"));
});

test("keep both is never dropped entirely", () => {
  const out = assembleContext(
    [
      { label: "first", text: "y".repeat(5000), budget: 10 },
      { label: "must-keep", text: "z".repeat(5000), keep: "both" },
    ],
    20
  );
  assert.ok(out.includes("## must-keep"));
});

test("head and tail modes keep the right end", () => {
  const text = "HEAD" + "x".repeat(1000) + "TAIL";
  const head = assembleContext([{ label: "h", text, budget: 20, keep: "head" }], 10000);
  assert.ok(head.includes("HEAD"));
  assert.ok(!head.includes("TAIL"));
  const tail = assembleContext([{ label: "t", text, budget: 20, keep: "tail" }], 10000);
  assert.ok(tail.includes("TAIL"));
  assert.ok(!tail.includes("HEAD"));
});

test("multiple parts are labeled in order", () => {
  const out = assembleContext(
    [
      { label: "one", text: "1" },
      { label: "two", text: "2" },
    ],
    1000
  );
  assert.ok(out.indexOf("## one") < out.indexOf("## two"));
});
