// silk credential storage: api keys live in the os credential vault,
// never in plaintext files. windows credential manager on win32 via
// @napi-rs/keyring; dev-only file fallback and a memory store for tests.

import { createRequire } from "node:module";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface CredentialStore {
  get(service: string, account: string): Promise<string | null>;
  set(service: string, account: string, value: string): Promise<void>;
  delete(service: string, account: string): Promise<void>;
}

// service name used in the os credential vault
export const SERVICE_NAME = "Silk";

type AsyncEntryCtor = new (
  service: string,
  account: string
) => {
  getPassword(): Promise<string | null>;
  setPassword(value: string): Promise<void>;
  deletePassword(): Promise<void>;
};

// lazy singleton: the native module may not exist on every machine
let cachedCtor: AsyncEntryCtor | null | undefined;
function keyringCtor(): AsyncEntryCtor | null {
  if (cachedCtor !== undefined) return cachedCtor;
  cachedCtor = null;
  try {
    // specifier assembled at runtime so bundlers leave this require alone
    const req = createRequire(import.meta.url);
    const mod = req(["@napi-rs", "keyring"].join("/"));
    if (mod && typeof mod.AsyncEntry === "function") {
      cachedCtor = mod.AsyncEntry as AsyncEntryCtor;
    }
  } catch {
    cachedCtor = null;
  }
  return cachedCtor;
}

export function keyringAvailable(): boolean {
  return keyringCtor() !== null;
}

// os vault: windows credential manager on win32, secret service / keychain
// elsewhere. throws only when the vault itself cannot load.
export class KeyringStore implements CredentialStore {
  private entry(service: string, account: string) {
    const Ctor = keyringCtor();
    if (!Ctor) throw new Error("os keyring is not available on this machine");
    return new Ctor(service, account);
  }

  async get(service: string, account: string): Promise<string | null> {
    try {
      return await this.entry(service, account).getPassword();
    } catch {
      return null;
    }
  }

  async set(service: string, account: string, value: string): Promise<void> {
    await this.entry(service, account).setPassword(value);
  }

  async delete(service: string, account: string): Promise<void> {
    try {
      await this.entry(service, account).deletePassword();
    } catch {
      // already gone, nothing to do
    }
  }
}

// dev-only fallback: keys in a 0600 json file. never use in packaged builds;
// it exists so development works on machines without a usable os vault.
export class FileStore implements CredentialStore {
  constructor(private dir: string) {}

  private filePath(): string {
    return join(this.dir, "credentials.dev.json");
  }

  private readAll(): Record<string, string> {
    const p = this.filePath();
    if (!existsSync(p)) return {};
    try {
      const raw: unknown = JSON.parse(readFileSync(p, "utf8"));
      return raw && typeof raw === "object"
        ? (raw as Record<string, string>)
        : {};
    } catch {
      return {};
    }
  }

  private writeAll(data: Record<string, string>): void {
    mkdirSync(this.dir, { recursive: true });
    const p = this.filePath();
    writeFileSync(p, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
    try {
      chmodSync(p, 0o600);
    } catch {
      // best effort: windows has no unix permission bits
    }
  }

  private key(service: string, account: string): string {
    return service + "/" + account;
  }

  async get(service: string, account: string): Promise<string | null> {
    return this.readAll()[this.key(service, account)] ?? null;
  }

  async set(service: string, account: string, value: string): Promise<void> {
    const data = this.readAll();
    data[this.key(service, account)] = value;
    this.writeAll(data);
  }

  async delete(service: string, account: string): Promise<void> {
    const data = this.readAll();
    delete data[this.key(service, account)];
    this.writeAll(data);
  }
}

// in-memory store for tests. nothing is persisted.
export class MemoryStore implements CredentialStore {
  private data = new Map<string, string>();

  private key(service: string, account: string): string {
    return service + "/" + account;
  }

  async get(service: string, account: string): Promise<string | null> {
    return this.data.get(this.key(service, account)) ?? null;
  }

  async set(service: string, account: string, value: string): Promise<void> {
    this.data.set(this.key(service, account), value);
  }

  async delete(service: string, account: string): Promise<void> {
    this.data.delete(this.key(service, account));
  }
}

// os vault when it loads, otherwise the dev-only file store with a warning.
// the warning carries no secrets.
export function defaultStore(): CredentialStore {
  if (keyringAvailable()) return new KeyringStore();
  console.warn(
    "silk: os keyring unavailable, using dev-only file credential store"
  );
  return new FileStore(join(homedir(), ".silk"));
}
