// tests for credentials.ts and the config key migration: keys move from
// plaintext silk.json into the credential store and never linger in files,
// logs, or error messages.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FileStore,
  KeyringStore,
  MemoryStore,
  SERVICE_NAME,
  defaultStore,
  keyringAvailable,
  type CredentialStore,
} from "./credentials";
import {
  getApiKey,
  migrateConfig,
  saveConfig,
  validateConfig,
  validateCredentials,
  type SilkConfig,
} from "./config";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "silk-cred-"));
}

const OPENAI_KEY = "sk-test-openai- migrating-aaa111";
const ANTHROPIC_KEY = "sk-test-anthropic-migrating-bbb222";

function v1File(dir: string): void {
  writeFileSync(
    join(dir, "silk.json"),
    JSON.stringify(
      {
        providers: {
          openai: {
            apiKey: OPENAI_KEY,
            baseUrl: "https://api.openai.com/v1",
            model: "gpt-4o-mini",
          },
          anthropic: { apiKey: ANTHROPIC_KEY, model: "claude-x" },
        },
        activeProvider: "openai",
      },
      null,
      2
    )
  );
}

describe("credential stores", () => {
  it("memory store round trips set/get/delete", async () => {
    const s: CredentialStore = new MemoryStore();
    assert.equal(await s.get(SERVICE_NAME, "openai"), null);
    await s.set(SERVICE_NAME, "openai", OPENAI_KEY);
    assert.equal(await s.get(SERVICE_NAME, "openai"), OPENAI_KEY);
    await s.delete(SERVICE_NAME, "openai");
    assert.equal(await s.get(SERVICE_NAME, "openai"), null);
  });

  it("file store round trips and keeps the file owner-only", async () => {
    const s = new FileStore(tmp());
    await s.set(SERVICE_NAME, "anthropic", ANTHROPIC_KEY);
    assert.equal(await s.get(SERVICE_NAME, "anthropic"), ANTHROPIC_KEY);
    const p = join((s as unknown as { dir: string }).dir, "credentials.dev.json");
    if (process.platform !== "win32") {
      assert.equal(statSync(p).mode & 0o777, 0o600);
    }
    await s.delete(SERVICE_NAME, "anthropic");
    assert.equal(await s.get(SERVICE_NAME, "anthropic"), null);
  });

  it("keyring store round trips", { skip: !keyringAvailable() }, async () => {
    const s: CredentialStore = new KeyringStore();
    const account = "silk-test-acct";
    await s.delete(SERVICE_NAME, account);
    assert.equal(await s.get(SERVICE_NAME, account), null);
    await s.set(SERVICE_NAME, account, "k1");
    assert.equal(await s.get(SERVICE_NAME, account), "k1");
    await s.delete(SERVICE_NAME, account);
    assert.equal(await s.get(SERVICE_NAME, account), null);
  });

  it("defaultStore returns a working store", async () => {
    const s = defaultStore();
    await s.set(SERVICE_NAME, "probe", "v");
    assert.equal(await s.get(SERVICE_NAME, "probe"), "v");
    await s.delete(SERVICE_NAME, "probe");
  });

  it("service name is Silk", () => {
    assert.equal(SERVICE_NAME, "Silk");
  });
});

describe("migration", () => {
  it("moves plaintext keys into the store and rewrites v2 without them", async () => {
    const dir = tmp();
    v1File(dir);
    const store = new MemoryStore();
    const res = await migrateConfig(dir, store);
    assert.deepEqual(res, { migrated: ["openai", "anthropic"], version: 2 });
    assert.equal(await store.get(SERVICE_NAME, "openai"), OPENAI_KEY);
    assert.equal(await store.get(SERVICE_NAME, "anthropic"), ANTHROPIC_KEY);
    const raw = readFileSync(join(dir, "silk.json"), "utf8");
    assert.ok(!raw.includes(OPENAI_KEY), "openai key must not remain in silk.json");
    assert.ok(!raw.includes(ANTHROPIC_KEY), "anthropic key must not remain in silk.json");
    const parsed = JSON.parse(raw);
    assert.equal(parsed.version, 2);
    assert.equal(parsed.providers.openai.baseUrl, "https://api.openai.com/v1");
    assert.equal(parsed.providers.openai.model, "gpt-4o-mini");
    assert.equal(parsed.activeProvider, "openai");
  });

  it("migrates only providers that have keys", async () => {
    const dir = tmp();
    writeFileSync(
      join(dir, "silk.json"),
      JSON.stringify({
        providers: { openai: { apiKey: OPENAI_KEY, baseUrl: "https://x/v1", model: "m" } },
        activeProvider: "openai",
      })
    );
    const store = new MemoryStore();
    const res = await migrateConfig(dir, store);
    assert.deepEqual(res.migrated, ["openai"]);
    assert.equal(await store.get(SERVICE_NAME, "anthropic"), null);
  });

  it("is a no-op on v2 files and missing files", async () => {
    const dir = tmp();
    const store = new MemoryStore();
    assert.deepEqual(await migrateConfig(dir, store), { migrated: [], version: 2 });
    const v2 = { version: 2, providers: {}, activeProvider: "openai" };
    writeFileSync(join(dir, "silk.json"), JSON.stringify(v2));
    assert.deepEqual(await migrateConfig(dir, store), { migrated: [], version: 2 });
    assert.equal(readFileSync(join(dir, "silk.json"), "utf8"), JSON.stringify(v2));
  });

  it("v2 saveConfig strips inline keys", () => {
    const dir = tmp();
    const cfg: SilkConfig = {
      version: 2,
      providers: {
        openai: { apiKey: OPENAI_KEY, baseUrl: "https://x/v1", model: "m" },
      },
      activeProvider: "openai",
    };
    saveConfig(dir, cfg);
    const raw = readFileSync(join(dir, "silk.json"), "utf8");
    assert.ok(!raw.includes(OPENAI_KEY), "v2 save must strip key material");
    assert.equal(JSON.parse(raw).version, 2);
  });
});

describe("key resolution", () => {
  it("getApiKey prefers the store, falls back to legacy inline, else null", async () => {
    const store = new MemoryStore();
    const cfg: SilkConfig = {
      providers: {
        openai: { apiKey: OPENAI_KEY, baseUrl: "https://x/v1", model: "m" },
      },
      activeProvider: "openai",
    };
    // legacy inline fallback
    assert.equal(await getApiKey(cfg, "openai", store), OPENAI_KEY);
    // store wins over inline
    await store.set(SERVICE_NAME, "openai", "sk-from-vault");
    assert.equal(await getApiKey(cfg, "openai", store), "sk-from-vault");
    // absent everywhere -> null, never a placeholder
    const bare: SilkConfig = { version: 2, providers: {}, activeProvider: "openai" };
    await store.delete(SERVICE_NAME, "openai");
    assert.equal(await store.get(SERVICE_NAME, "openai"), null);
    assert.equal(await getApiKey(bare, "openai", store), null);
    // empty string is not a key
    const empty: SilkConfig = {
      providers: { openai: { apiKey: "", baseUrl: "https://x/v1", model: "m" } },
      activeProvider: "openai",
    };
    assert.equal(await getApiKey(empty, "openai", store), null);
  });

  it("validateCredentials checks the vault", async () => {
    const store = new MemoryStore();
    const cfg: SilkConfig = {
      version: 2,
      providers: { openai: { apiKey: "", baseUrl: "https://x/v1", model: "m" } },
      activeProvider: "openai",
    };
    assert.deepEqual(await validateCredentials(cfg, store), ["openai api key is missing"]);
    await store.set(SERVICE_NAME, "openai", "sk-x");
    assert.deepEqual(await validateCredentials(cfg, store), []);
  });

  it("validateConfig never leaks key material in messages", () => {
    const fake = "sk-fake-key-DO-NOT-LOG-99999";
    const cfg: SilkConfig = {
      providers: { openai: { apiKey: fake, baseUrl: "notaurl", model: "" } },
      activeProvider: "openai",
    };
    const problems = validateConfig(cfg);
    assert.ok(problems.length > 0);
    for (const p of problems) {
      assert.ok(!p.includes(fake), "error message leaked key material: " + p);
    }
    // v2 configs do not complain about missing inline keys
    const v2: SilkConfig = {
      version: 2,
      providers: { openai: { apiKey: "", baseUrl: "https://x/v1", model: "m" } },
      activeProvider: "openai",
    };
    assert.deepEqual(validateConfig(v2), []);
  });
});
