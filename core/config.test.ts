// tests for config.ts: round trip, validation, missing files.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, validateConfig, defaultConfig, type SilkConfig } from "./config";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "silk-cfg-"));
}

describe("config", () => {
  it("round trips through silk.json", () => {
    const dir = tmp();
    const cfg: SilkConfig = {
      providers: {
        openai: { apiKey: "sk-x", baseUrl: "https://api.openai.com/v1", model: "gpt-4o-mini" },
        anthropic: { apiKey: "sk-ant-y", model: "claude-sonnet-4-20250514" },
      },
      activeProvider: "anthropic",
    };
    saveConfig(dir, cfg);
    assert.deepEqual(loadConfig(dir), cfg);
  });

  it("returns null when no config file exists", () => {
    assert.equal(loadConfig(tmp()), null);
  });

  it("returns null on corrupt json", () => {
    const dir = tmp();
    writeFileSync(join(dir, "silk.json"), "not json{");
    assert.equal(loadConfig(dir), null);
  });

  it("tolerates partial files with defaults", () => {
    const dir = tmp();
    writeFileSync(join(dir, "silk.json"), JSON.stringify({ activeProvider: "anthropic" }));
    assert.deepEqual(loadConfig(dir), { providers: {}, activeProvider: "anthropic" });
  });

  it("validates a good openai config", () => {
    const cfg: SilkConfig = {
      providers: { openai: { apiKey: "k", baseUrl: "https://x/v1", model: "m" } },
      activeProvider: "openai",
    };
    assert.deepEqual(validateConfig(cfg), []);
  });

  it("flags missing keys and bad urls", () => {
    assert.deepEqual(validateConfig(null), ["no config found, add your api keys first"]);
    assert.deepEqual(validateConfig({ activeProvider: "nope" }), ['activeProvider must be "openai" or "anthropic"']);
    assert.deepEqual(validateConfig({ providers: {}, activeProvider: "openai" }), [
      "openai is the active provider but has no settings",
    ]);
    const bad: SilkConfig = {
      providers: { openai: { apiKey: "", baseUrl: "notaurl", model: "" } },
      activeProvider: "openai",
    };
    assert.deepEqual(validateConfig(bad), [
      "openai api key is missing",
      "openai base url should start with http:// or https://",
      "openai model is missing",
    ]);
    const badAnthropic: SilkConfig = {
      providers: { anthropic: { apiKey: "", model: "" } },
      activeProvider: "anthropic",
    };
    assert.deepEqual(validateConfig(badAnthropic), [
      "anthropic api key is missing",
      "anthropic model is missing",
    ]);
  });
});
