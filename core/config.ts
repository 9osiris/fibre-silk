// silk config: provider prefs in silk.json, api keys in the credential store.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CredentialStore } from "./credentials.js";
import { SERVICE_NAME } from "./credentials.js";

export type ProviderId = "openai" | "anthropic";

export interface OpenAISettings {
  // legacy v1 only: inline keys are moved to the credential store by
  // migrateConfig. v2 files never contain key material.
  apiKey: string;
  baseUrl: string;
  model: string;
}

export interface AnthropicSettings {
  // legacy v1 only, see above
  apiKey: string;
  model: string;
}

export interface SilkConfig {
  // absent or 1 = legacy (keys may be inline in this file).
  // 2 = vault-backed (keys live in the credential store, never here).
  version?: number;
  providers: {
    openai?: OpenAISettings;
    anthropic?: AnthropicSettings;
  };
  activeProvider: ProviderId;
  // project directory the coding agent works in. empty = plain chat.
  workspaceDir?: string;
}

export interface MigrationResult {
  migrated: ProviderId[];
  version: number;
}

const FILE_NAME = "silk.json";

export function configPath(dir: string): string {
  return join(dir, FILE_NAME);
}

// fresh installs start vault-backed
export function defaultConfig(): SilkConfig {
  return { version: 2, providers: {}, activeProvider: "openai" };
}

// missing file is not an error: caller falls back to setup flow
export function loadConfig(dir: string): SilkConfig | null {
  const path = configPath(dir);
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const parsed = raw as Partial<SilkConfig> & { version?: unknown };
  const cfg: SilkConfig = { providers: {}, activeProvider: "openai" };
  // version passes through only when the file carries one, so legacy
  // shapes keep round-tripping exactly
  if (typeof parsed.version === "number") cfg.version = parsed.version;
  if (parsed.activeProvider === "openai" || parsed.activeProvider === "anthropic") {
    cfg.activeProvider = parsed.activeProvider;
  }
  const providers = (parsed as any).providers ?? {};
  if (providers.openai && typeof providers.openai === "object") {
    cfg.providers.openai = {
      apiKey: providers.openai.apiKey ?? "",
      baseUrl: providers.openai.baseUrl ?? "",
      model: providers.openai.model ?? "",
    };
  }
  if (providers.anthropic && typeof providers.anthropic === "object") {
    cfg.providers.anthropic = {
      apiKey: providers.anthropic.apiKey ?? "",
      model: providers.anthropic.model ?? "",
    };
  }
  return cfg;
}

// v2 invariant: silk.json never holds key material. inline keys are stripped
// on write, so callers must persist them through the credential store first.
// v1 configs keep legacy behavior so old files round-trip untouched.
export function saveConfig(dir: string, cfg: SilkConfig): void {
  mkdirSync(dir, { recursive: true });
  const out: SilkConfig =
    cfg.version === 2 ? stripKeys(cfg) : { ...cfg };
  writeFileSync(configPath(dir), JSON.stringify(out, null, 2) + "\n", "utf8");
}

function stripKeys(cfg: SilkConfig): SilkConfig {
  const providers: SilkConfig["providers"] = {};
  if (cfg.providers.openai) {
    const { baseUrl, model } = cfg.providers.openai;
    providers.openai = { apiKey: "", baseUrl, model };
  }
  if (cfg.providers.anthropic) {
    const { model } = cfg.providers.anthropic;
    providers.anthropic = { apiKey: "", model };
  }
  return {
    version: 2,
    activeProvider: cfg.activeProvider,
    providers,
    workspaceDir: cfg.workspaceDir,
  };
}

// the only config.ts function that returns key material. checks the vault
// first, then the legacy inline key for the migration window. returns null
// when absent, never a placeholder or an empty string.
export async function getApiKey(
  cfg: SilkConfig,
  provider: ProviderId,
  store: CredentialStore
): Promise<string | null> {
  const fromStore = await store.get(SERVICE_NAME, provider).catch(() => null);
  if (fromStore) return fromStore;
  const inline =
    provider === "openai"
      ? cfg.providers.openai?.apiKey
      : cfg.providers.anthropic?.apiKey;
  return inline || null;
}

// first-run migration: moves plaintext keys from a v1 silk.json into the
// credential store, then rewrites the file as v2 without key material.
// no-op when there is no file or the file is already v2.
export async function migrateConfig(
  dir: string,
  store: CredentialStore
): Promise<MigrationResult> {
  const cfg = loadConfig(dir);
  if (!cfg || (cfg.version ?? 1) >= 2) return { migrated: [], version: 2 };
  const migrated: ProviderId[] = [];
  const found: Array<[ProviderId, string | undefined]> = [
    ["openai", cfg.providers.openai?.apiKey],
    ["anthropic", cfg.providers.anthropic?.apiKey],
  ];
  for (const [provider, key] of found) {
    if (key) {
      await store.set(SERVICE_NAME, provider, key);
      migrated.push(provider);
    }
  }
  saveConfig(dir, { ...cfg, version: 2 });
  return { migrated, version: 2 };
}

// human-readable list of problems, empty means the config is usable.
// checks prefs only; key presence comes from validateCredentials below.
// messages are static strings and never include key material.
export function validateConfig(cfg: unknown): string[] {
  if (!cfg || typeof cfg !== "object") {
    return ["no config found, add your api keys first"];
  }
  const c = cfg as Partial<SilkConfig>;
  if (c.activeProvider !== "openai" && c.activeProvider !== "anthropic") {
    return ['activeProvider must be "openai" or "anthropic"'];
  }
  const problems: string[] = [];
  // v2 configs keep keys in the vault, so only v1 checks inline keys
  const checksInlineKey = (c.version ?? 1) < 2;
  if (c.activeProvider === "openai") {
    const p = c.providers?.openai;
    if (!p) {
      problems.push("openai is the active provider but has no settings");
    } else {
      if (checksInlineKey && !p.apiKey) problems.push("openai api key is missing");
      if (!p.baseUrl) problems.push("openai base url is missing");
      else if (!/^https?:\/\//.test(p.baseUrl)) {
        problems.push("openai base url should start with http:// or https://");
      }
      if (!p.model) problems.push("openai model is missing");
    }
  } else {
    const p = c.providers?.anthropic;
    if (!p) {
      problems.push("anthropic is the active provider but has no settings");
    } else {
      if (checksInlineKey && !p.apiKey) problems.push("anthropic api key is missing");
      if (!p.model) problems.push("anthropic model is missing");
    }
  }
  return problems;
}

// async companion to validateConfig: confirms the vault (or legacy inline
// key) actually holds a key for the active provider.
export async function validateCredentials(
  cfg: SilkConfig,
  store: CredentialStore
): Promise<string[]> {
  const p = cfg.activeProvider;
  if (p !== "openai" && p !== "anthropic") return [];
  const key = await getApiKey(cfg, p, store).catch(() => null);
  return key ? [] : [`${p} api key is missing`];
}
