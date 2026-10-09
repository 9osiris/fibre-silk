// tests for models.ts: registry get/add, overrides, json round trip.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_MODELS,
  createRegistry,
  registryToJSON,
  registryFromJSON,
  type ModelInfo,
} from "./models";

describe("model registry", () => {
  it("ships real default models", () => {
    const r = createRegistry();
    const mini = r.get("gpt-4o-mini");
    assert.ok(mini);
    assert.equal(mini.provider, "openai");
    assert.equal(mini.relativeCost, 1.0);
    assert.ok(mini.supportsTools);
    const sonnet = r.get("claude-sonnet-4-5");
    assert.ok(sonnet);
    assert.equal(sonnet.provider, "anthropic");
    assert.ok(sonnet.supportsReasoning);
  });

  it("get returns undefined for unknown ids", () => {
    const r = createRegistry();
    assert.equal(r.get("not-a-real-model"), undefined);
  });

  it("add inserts and replaces by id", () => {
    const r = createRegistry();
    const custom: ModelInfo = {
      id: "my-local",
      provider: "openai",
      displayName: "My local model",
      contextWindow: 32768,
      supportsStreaming: true,
      supportsTools: true,
      supportsVision: false,
      supportsReasoning: false,
      supportsStructuredOutput: false,
      relativeCost: 0.1,
    };
    r.add(custom);
    assert.equal(r.get("my-local")?.displayName, "My local model");
    r.add({ ...custom, displayName: "Renamed" });
    assert.equal(r.get("my-local")?.displayName, "Renamed");
  });

  it("add rejects empty ids", () => {
    const r = createRegistry();
    assert.throws(
      () => r.add({ id: "", provider: "openai" } as ModelInfo),
      /non-empty id/
    );
  });

  it("overrides replace defaults on id collision", () => {
    const r = createRegistry(DEFAULT_MODELS, [
      { ...DEFAULT_MODELS[0], relativeCost: 0.5 },
    ]);
    assert.equal(r.get("gpt-4o-mini")?.relativeCost, 0.5);
    // only one entry per id
    const ids = r.list().map((m) => m.id);
    assert.equal(ids.length, new Set(ids).size);
  });

  it("json round trip preserves entries", () => {
    const r = createRegistry();
    r.add({
      id: "extra",
      provider: "anthropic",
      displayName: "Extra",
      contextWindow: 1000,
      supportsStreaming: true,
      supportsTools: false,
      supportsVision: false,
      supportsReasoning: false,
      supportsStructuredOutput: false,
      relativeCost: 2.0,
    });
    const back = registryFromJSON(JSON.parse(JSON.stringify(registryToJSON(r))));
    assert.equal(back.list().length, r.list().length);
    assert.deepEqual(back.get("extra"), r.get("extra"));
    assert.deepEqual(back.get("gpt-4o"), r.get("gpt-4o"));
  });

  it("fromJSON rejects malformed data", () => {
    assert.throws(() => registryFromJSON({} as any), /must be an array/);
    assert.throws(() => registryFromJSON([{ id: "" }]), /non-empty id/);
    assert.throws(
      () => registryFromJSON([{ id: "x", provider: "nope" }]),
      /unknown provider/
    );
  });
});
