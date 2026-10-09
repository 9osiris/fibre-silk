// verification engine: runs applicable checks for a project and reports.
// failures come back as data so the agent can fix and retry.

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { analyzeWorkspace, type WorkspaceInfo } from "./workspace.js";
import { gitDiffStat } from "./git.js";

export interface CheckResult {
  name: string;
  ok: boolean;
  output: string;
  ms: number;
}

export interface VerificationReport {
  ok: boolean;
  checks: CheckResult[];
}

export type RunFn = (cmd: string, args: string[]) => Promise<{ code: number; out: string }>;

const CHECK_TIMEOUT_MS = 120000;

function withTimeout<T>(p: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(name + " timed out after " + ms + "ms")), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer!));
}

export class VerificationEngine {
  private extra: { name: string; fn: () => Promise<CheckResult> }[] = [];

  constructor(
    private dir: string,
    private exec: RunFn,
    private timeoutMs = CHECK_TIMEOUT_MS
  ) {}

  registerCheck(name: string, fn: () => Promise<CheckResult>): void {
    this.extra.push({ name, fn });
  }

  async detect(): Promise<WorkspaceInfo> {
    return analyzeWorkspace(this.dir);
  }

  private async execCheck(name: string, cmd: string, args: string[]): Promise<CheckResult> {
    const start = Date.now();
    try {
      const res = await withTimeout(this.exec(cmd, args), this.timeoutMs, name);
      return {
        name,
        ok: res.code === 0,
        output: res.out.trim().slice(0, 8000) || "(no output)",
        ms: Date.now() - start,
      };
    } catch (err) {
      return {
        name,
        ok: false,
        output: String(err instanceof Error ? err.message : err).slice(0, 8000),
        ms: Date.now() - start,
      };
    }
  }

  async run(): Promise<VerificationReport> {
    const info = await this.detect();
    const checks: CheckResult[] = [];

    // informational: what changed, never fails
    try {
      const stat = await gitDiffStat(this.dir);
      checks.push({ name: "git diff stat", ok: true, output: stat || "(clean)", ms: 0 });
    } catch {
      checks.push({ name: "git diff stat", ok: true, output: "(not a git repo)", ms: 0 });
    }

    for (const { fn } of this.extra) {
      try {
        checks.push(await fn());
      } catch (err) {
        checks.push({
          name: "custom check",
          ok: false,
          output: String(err instanceof Error ? err.message : err).slice(0, 8000),
          ms: 0,
        });
      }
    }

    if (info.configFiles.includes("tsconfig.json")) {
      checks.push(await this.execCheck("tsc --noEmit", "npx", ["tsc", "--noEmit"]));
    }

    let scripts: Record<string, string> = {};
    try {
      const pkg = JSON.parse(await readFile(join(this.dir, "package.json"), "utf8"));
      scripts = pkg.scripts ?? {};
    } catch {
      // no package.json, skip script-based checks
    }
    if (scripts.test) {
      checks.push(await this.execCheck("npm test", "npm", ["test", "--silent"]));
    }
    if (scripts.build) {
      checks.push(await this.execCheck("npm run build", "npm", ["run", "build"]));
    }

    return { ok: checks.every((c) => c.ok), checks };
  }
}
