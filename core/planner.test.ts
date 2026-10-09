// tests for planner.ts. run with: npx tsx --test planner.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatEvent, ChatMessage, Provider, ToolDef } from "./providers.js";
import {
  extractJsonObject,
  generatePlan,
  nextPending,
  setStepState,
} from "./planner.js";

function scripted(reply: string): Provider {
  return {
    id: "openai",
    async *chat(_m: ChatMessage[], _o: { model?: string; tools?: ToolDef[] }): AsyncGenerator<ChatEvent> {
      yield { type: "text", delta: reply };
      yield { type: "done", usage: { inputTokens: 1, outputTokens: 1 } };
    },
  } as unknown as Provider;
}

test("extractJsonObject handles fenced and bare json", () => {
  const fenced = 'here you go:\n```json\n{"a": 1}\n```\ndone';
  assert.equal(extractJsonObject(fenced), '{"a": 1}');
  assert.equal(extractJsonObject('prefix {"a": 1} suffix'), '{"a": 1}');
  assert.throws(() => extractJsonObject("no json here at all"), /no json object/);
});

test("generatePlan parses a valid plan", async () => {
  const p = scripted('{"goal": "fix login", "steps": [{"id": "inspect", "description": "look"}, {"id": "fix", "description": "patch"}]}');
  const plan = await generatePlan(p, "fix login", { model: "m" });
  assert.equal(plan.goal, "fix login");
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].id, "inspect");
  assert.equal(plan.steps[0].status, "pending");
});

test("generatePlan tolerates fences and prose", async () => {
  const p = scripted('Sure thing:\n```json\n{"goal": "g", "steps": [{"id": "a", "description": "b"}]}\n```');
  const plan = await generatePlan(p, "g", { model: "m" });
  assert.equal(plan.steps[0].id, "a");
});

test("generatePlan throws clearly on malformed json", async () => {
  const p = scripted("i have no idea what to do, good luck");
  await assert.rejects(() => generatePlan(p, "g", { model: "m" }), /valid JSON plan/);
});

test("generatePlan throws on missing steps array", async () => {
  const p = scripted('{"goal": "g", "nope": true}');
  await assert.rejects(() => generatePlan(p, "g", { model: "m" }), /steps array/);
});

test("setStepState and nextPending", async () => {
  const p = scripted('{"goal": "g", "steps": [{"id": "a", "description": "x"}, {"id": "b", "description": "y"}]}');
  const plan = await generatePlan(p, "g", { model: "m" });
  assert.equal(nextPending(plan)?.id, "a");
  setStepState(plan, "a", "completed");
  assert.equal(nextPending(plan)?.id, "b");
  assert.throws(() => setStepState(plan, "zzz", "failed"), /unknown step id/);
});
