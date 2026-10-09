// tests for router.ts: deterministic routing rules over the registry.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createRegistry, type ModelInfo } from "./models";
import { route } from "./router";

const reg = () => createRegistry();

function textOnly(): ModelInfo {
  return {
    id: "text-only",
    provider: "openai",
    displayName: "Text only",
    contextWindow: 8192,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: false,
    supportsReasoning: false,
    supportsStructuredOutput: false,
    relativeCost: 1.0,
  };
}

describe("model router", () => {
  it("vision picks a vision-capable model", () => {
    const d = route({ kind: "vision" }, reg());
    assert.ok(d.capabilities.includes("vision"));
    assert.ok(d.reason.length > 0);
    assert.ok(!d.reason.includes("\n"));
  });

  it("vision throws clearly when no vision model exists", () => {
    const r = createRegistry([textOnly()]);
    assert.throws(() => route({ kind: "vision" }, r), /vision-capable/);
  });

  it("needVision filters on other task kinds too", () => {
    const d = route({ kind: "coding", needVision: true }, reg());
    assert.ok(d.capabilities.includes("vision"));
  });

  it("review prefers a different provider than the coder", () => {
    const d = route({ kind: "review", coderModel: "gpt-4o" }, reg());
    assert.equal(d.provider, "anthropic");
    assert.notEqual(d.model, "gpt-4o");
    assert.match(d.reason, /different provider/);
  });

  it("review reuses the coder model when only one provider exists", () => {
    const r = createRegistry([textOnly()]);
    const d = route({ kind: "review", coderModel: "text-only" }, r);
    assert.equal(d.model, "text-only");
    assert.match(d.reason, /separate stage/);
  });

  it("fast picks the cheapest tool-capable model", () => {
    const d = route({ kind: "fast" }, reg());
    assert.equal(d.model, "gpt-4o-mini");
  });

  it("simple also picks the cheapest tool-capable model", () => {
    const d = route({ kind: "simple" }, reg());
    assert.equal(d.model, "gpt-4o-mini");
  });

  it("coding picks a mid-cost model with a big window", () => {
    const d = route({ kind: "coding" }, reg());
    assert.equal(d.model, "gpt-4.1");
    assert.ok(d.capabilities.includes("tools"));
  });

  it("reasoning picks a reasoning-capable model", () => {
    const d = route({ kind: "reasoning" }, reg());
    assert.ok(d.capabilities.includes("reasoning"));
    assert.equal(d.model, "o4-mini");
  });

  it("context overflow disqualifies small models", () => {
    const d = route({ kind: "fast", estimatedInputTokens: 500000 }, reg());
    assert.equal(d.model, "gpt-4.1");
  });

  it("impossible context size throws clearly", () => {
    assert.throws(
      () => route({ kind: "fast", estimatedInputTokens: 5000000 }, reg()),
      /context window/
    );
  });

  it("unknown avoidModel is ignored gracefully", () => {
    const d = route(
      { kind: "fast", avoidModel: "does-not-exist" },
      reg()
    );
    assert.equal(d.model, "gpt-4o-mini");
  });

  it("avoidModel excludes the named model", () => {
    const d = route({ kind: "fast", avoidModel: "gpt-4o-mini" }, reg());
    assert.notEqual(d.model, "gpt-4o-mini");
    assert.equal(d.model, "o4-mini");
  });

  it("preferProvider is honored when it matches", () => {
    const d = route({ kind: "fast", preferProvider: "anthropic" }, reg());
    assert.equal(d.provider, "anthropic");
  });

  it("preferProvider falls back gracefully when it matches nothing", () => {
    const d = route({ kind: "fast", preferProvider: "nope" }, reg());
    assert.equal(d.model, "gpt-4o-mini");
    assert.match(d.reason, /preferred provider/);
  });

  it("empty registry throws", () => {
    assert.throws(() => route({ kind: "fast" }, createRegistry([])), /empty/);
  });

  it("reason is a one-line human explanation", () => {
    for (const kind of ["simple", "reasoning", "coding", "review", "vision", "fast"] as const) {
      const d = route({ kind }, reg());
      assert.ok(d.reason.length > 10, kind);
      assert.ok(!d.reason.includes("\n"), kind);
    }
  });
});
