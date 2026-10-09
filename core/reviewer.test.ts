// tests for reviewer.ts. run with: npx tsx --test reviewer.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatEvent, ChatMessage, Provider, ToolDef } from "./providers.js";
import { reviewChanges } from "./reviewer.js";

function scripted(reply: string): Provider {
  return {
    id: "openai",
    async *chat(_m: ChatMessage[], _o: { model?: string; tools?: ToolDef[] }): AsyncGenerator<ChatEvent> {
      yield { type: "text", delta: reply };
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  } as unknown as Provider;
}

const input = { goal: "fix login", diff: "diff --git a/x.ts b/x.ts", testReport: "PASS tsc" };

test("approved with no findings", async () => {
  const r = await reviewChanges(scripted('{"status": "approved", "findings": []}'), input, { model: "m" });
  assert.equal(r.status, "approved");
  assert.deepEqual(r.findings, []);
});

test("changes_required with findings", async () => {
  const r = await reviewChanges(
    scripted('{"status": "changes_required", "findings": [{"severity": "high", "file": "x.ts", "description": "bad"}]}'),
    input,
    { model: "m" }
  );
  assert.equal(r.status, "changes_required");
  assert.equal(r.findings[0].severity, "high");
  assert.equal(r.findings[0].file, "x.ts");
});

test("unknown severity normalizes to medium", async () => {
  const r = await reviewChanges(
    scripted('{"status": "changes_required", "findings": [{"severity": "cosmic", "file": "x", "description": "y"}]}'),
    input,
    { model: "m" }
  );
  assert.equal(r.findings[0].severity, "medium");
});

test("malformed json throws", async () => {
  await assert.rejects(
    () => reviewChanges(scripted("looks fine to me"), input, { model: "m" }),
    /valid JSON/
  );
});

test("invalid status throws", async () => {
  await assert.rejects(
    () => reviewChanges(scripted('{"status": "maybe", "findings": []}'), input, { model: "m" }),
    /approved.*changes_required/
  );
});
