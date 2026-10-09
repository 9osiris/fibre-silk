// local pc tools for the silk agent. windows-first, safe defaults.
// clean-room original code for silk by layered innovation.

import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import type { ToolDef } from "./providers.js";
import type { AgentTool } from "./agent.js";

// roots the file tools may touch. defaults to the user's home dir.
let allowedRoots: string[] = [os.homedir()];

export function setAllowedRoots(roots: string[]): void {
  allowedRoots = roots.map((r) => path.resolve(r));
}

export function getAllowedRoots(): string[] {
  return [...allowedRoots];
}

function insideRoots(p: string): boolean {
  const abs = path.resolve(p);
  const norm = (s: string) =>
    process.platform === "win32" ? s.toLowerCase() : s;
  const target = norm(abs);
  return allowedRoots.some((r) => {
    const root = norm(path.resolve(r));
    return target === root || target.startsWith(root + path.sep);
  });
}

// resolve a user-supplied path to its real location (symlinks and
// windows junctions expanded) and confirm it stays inside allowedRoots.
// path.resolve alone is lexical, so a junction inside the workspace
// pointing at c:\windows would otherwise pass the check.
async function resolveInside(p: string): Promise<string> {
  let real: string;
  try {
    real = await fs.realpath(path.resolve(p));
  } catch {
    // path may not exist yet (fs_write creating a file): resolve the
    // closest existing ancestor and reattach the remainder.
    let dir = path.resolve(p);
    const rest: string[] = [];
    for (;;) {
      try {
        real = await fs.realpath(dir);
        break;
      } catch {
        const parent = path.dirname(dir);
        if (parent === dir) throw new Error(`cannot resolve ${p}`);
        rest.unshift(path.basename(dir));
        dir = parent;
      }
    }
    real = path.join(real, ...rest);
  }
  if (!insideRoots(real)) {
    throw new Error(
      `refused: ${p} resolves outside allowedRoots (${allowedRoots.join(", ")})`
    );
  }
  return real;
}

function toolDef(
  name: string,
  description: string,
  schema: Record<string, unknown>
): ToolDef {
  return { name, description, schema } as unknown as ToolDef;
}

function strArg(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v) throw new Error(`missing "${key}"`);
  return v;
}

const fsList: AgentTool = {
  def: toolDef(
    "fs_list",
    "list files and folders in a directory (stays inside allowedRoots)",
    {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    }
  ),
  async run(args) {
    const p = await resolveInside(strArg(args, "path"));
    const entries = await fs.readdir(p, { withFileTypes: true });
    const rows = await Promise.all(
      entries.slice(0, 500).map(async (e) => {
        const full = path.join(p, e.name);
        let size = 0;
        if (e.isFile()) {
          try {
            size = (await fs.stat(full)).size;
          } catch {
            // unreadable entry, keep size 0
          }
        }
        return `${e.isDirectory() ? "dir " : "file"} ${size
          .toString()
          .padStart(10)} ${e.name}`;
      })
    );
    return rows.join("\n") || "(empty)";
  },
};

const MAX_READ_BYTES = 65536;

const fsRead: AgentTool = {
  def: toolDef(
    "fs_read",
    "read a text file, capped at 64kb (stays inside allowedRoots)",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        maxBytes: { type: "number" },
      },
      required: ["path"],
    }
  ),
  async run(args) {
    const p = await resolveInside(strArg(args, "path"));
    const cap =
      typeof args.maxBytes === "number" && args.maxBytes > 0
        ? Math.min(Math.floor(args.maxBytes), MAX_READ_BYTES)
        : MAX_READ_BYTES;
    const fh = await fs.open(p, "r");
    try {
      const buf = Buffer.alloc(cap + 1);
      const { bytesRead } = await fh.read(buf, 0, cap + 1, 0);
      const truncated = bytesRead > cap;
      return buf.subarray(0, Math.min(bytesRead, cap)).toString("utf8") +
        (truncated ? "\n...(truncated)" : "");
    } finally {
      await fh.close();
    }
  },
};

const fsWrite: AgentTool = {
  def: toolDef(
    "fs_write",
    "write a text file, creating folders as needed. refuses paths outside allowedRoots",
    {
      type: "object",
      properties: {
        path: { type: "string" },
        content: { type: "string" },
      },
      required: ["path", "content"],
    }
  ),
  async run(args) {
    const raw = args["content"];
    if (typeof raw !== "string") throw new Error('missing "content"');
    const p = await resolveInside(strArg(args, "path"));
    const content = raw;
    await fs.mkdir(path.dirname(p), { recursive: true });
    await fs.writeFile(p, content, "utf8");
    return `wrote ${content.length} chars to ${p}`;
  },
};

// commands that never run, matched case-insensitively.
// this is a backstop, not the security boundary: the permission gate
// in runtime.ts is what actually stands between the model and the shell.
const DENY = [
  /\bformat\s+[a-z]:/i,
  /\bformat-volume\b/i,
  /\bclear-disk\b/i,
  /\bdiskpart\b/i,
  /\breg\s+delete\b/i,
  /\bbcdedit\b/i,
  /\bshutdown\b/i,
  /\bstop-computer\b/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\btakeown\b/i,
  /\bremove-item\b[^;|&]*(-recurse[^;|&]*[a-z]:\\|[a-z]:\\[^;|&]*-recurse)/i,
  /\brd\s+\/s(\s|\/q)*\s*[a-z]:\\/i,
];

const MAX_OUT = 16384;
const DEFAULT_TIMEOUT_MS = 30000;

// kill a spawned process and its children. on win32 taskkill /T takes
// the whole tree. on posix the child is spawned detached (a process group
// leader), so killing the negative pid takes the group: plain
// child.kill only reaches the direct child and forked grandchildren
// (sh -c "sleep 10") would leak as orphans.
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid == null) return;
  try {
    if (process.platform === "win32") {
      execFile("taskkill", ["/PID", String(pid), "/T", "/F"]);
    } else {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  } catch {
    // process already gone
  }
}

const execTool: AgentTool = {
  def: toolDef(
    "exec",
    "run a shell command with a timeout. powershell on windows, sh elsewhere. destructive patterns are blocked",
    {
      type: "object",
      properties: {
        command: { type: "string" },
        timeoutMs: { type: "number" },
        cwd: { type: "string" },
      },
      required: ["command"],
    }
  ),
  async run(args, ctx?: { signal?: AbortSignal }) {
    const command = strArg(args, "command");
    if (DENY.some((re) => re.test(command))) {
      return `refused: command blocked by denylist: ${command}`;
    }
    const timeoutMs =
      typeof args.timeoutMs === "number" && args.timeoutMs > 0
        ? Math.min(Math.floor(args.timeoutMs), 120000)
        : DEFAULT_TIMEOUT_MS;
    // optional working directory, confined to allowedRoots like the
    // file tools. defaults to the process cwd.
    let cwd: string | undefined;
    if (typeof args.cwd === "string" && args.cwd) {
      cwd = await resolveInside(args.cwd);
    }
    const shell =
      process.platform === "win32"
        ? {
            cmd: "powershell",
            argv: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", command],
          }
        : { cmd: "sh", argv: ["-c", command] };
    const signal = ctx?.signal;
    // spawn (not execFile): execFile ignores detached on some node
    // versions, and without a real process group the tree kill below
    // cannot reach forked grandchildren.
    return await new Promise<string>((resolve, reject) => {
      let done = false;
      const finish = (fn: () => void): void => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const child = spawn(shell.cmd, shell.argv, {
        cwd,
        // own process group on posix so killTree takes grandchildren too
        detached: process.platform !== "win32",
        windowsHide: true,
      });
      let out = "";
      let errOut = "";
      const take = (cur: string, d: Buffer): string =>
        cur.length >= MAX_OUT
          ? cur
          : cur + d.toString("utf8").slice(0, MAX_OUT - cur.length);
      child.stdout?.on("data", (d: Buffer) => {
        out = take(out, d);
      });
      child.stderr?.on("data", (d: Buffer) => {
        errOut = take(errOut, d);
      });
      const timer = setTimeout(() => {
        // timeout: kill the whole tree, then report what we got
        killTree(child);
        finish(() => resolve(`timed out after ${timeoutMs}ms\n${out}${errOut}`));
      }, timeoutMs);
      // the timer must not hold the loop open by itself
      timer.unref();
      child.on("error", (err) => {
        finish(() =>
          resolve(`failed to start: ${String(err).slice(0, 200)}`)
        );
      });
      // close fires after stdio is flushed, so output is complete
      child.on("close", (code, sig) => {
        finish(() => {
          // nonzero exits are signal-worthy; zero is the quiet default
          const codeStr =
            typeof code === "number" && code !== 0
              ? ` (exit ${code})`
              : sig
                ? ` (signal ${sig})`
                : "";
          resolve(
            `${out}${errOut ? "\nstderr:\n" + errOut : ""}${codeStr}`.trim() ||
              "(no output)"
          );
        });
      });
      const onAbort = (): void => {
        // stop button: kill the tree, never leave an orphaned shell
        killTree(child);
        finish(() => reject(new Error("cancelled")));
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort, { once: true });
      }
    });
  },
};

export class ToolRegistry {
  private tools = new Map<string, AgentTool>();

  register(tool: AgentTool): void {
    this.tools.set(tool.def.name, tool);
  }

  list(): ToolDef[] {
    return [...this.tools.values()].map((t) => t.def);
  }

  all(): AgentTool[] {
    return [...this.tools.values()];
  }

  get(name: string): AgentTool | undefined {
    return this.tools.get(name);
  }
}

// the default local toolset for a silk agent on the user's pc
export function createLocalTools(opts?: {
  allowedRoots?: string[];
}): ToolRegistry {
  if (opts?.allowedRoots) setAllowedRoots(opts.allowedRoots);
  const r = new ToolRegistry();
  r.register(fsList);
  r.register(fsRead);
  r.register(fsWrite);
  r.register(execTool);
  return r;
}
