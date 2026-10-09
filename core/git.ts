// read-only git inspection for silk. shells out to git, never commits.

import { execFile } from "node:child_process";

export interface GitStatus {
  clean: boolean;
  files: string[];
}

function runGit(dir: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile("git", args, { cwd: dir, timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message || "").trim();
        reject(new Error("git " + args[0] + " failed: " + msg));
        return;
      }
      resolve(stdout);
    });
  });
}

// porcelain v1 with -z so weird filenames survive; strips the XY status
// prefix so callers get clean paths
export async function gitStatus(dir: string): Promise<GitStatus> {
  const out = await runGit(dir, ["status", "--porcelain=v1", "-z"]);
  const raw = out.split("\0").filter((s) => s.length > 0);
  const files: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    const code = entry.slice(0, 2);
    if (code[0] === "R" || code[1] === "R") {
      files.push(entry.slice(3)); // rename: destination path
      i++; // skip the source path field
    } else {
      files.push(entry.slice(3));
    }
  }
  return { clean: files.length === 0, files };
}

export async function gitDiffStat(dir: string): Promise<string> {
  return (await runGit(dir, ["diff", "--stat"])).trim();
}

export async function gitDiff(dir: string, paths?: string[]): Promise<string> {
  const args = ["diff", "--"];
  if (paths && paths.length > 0) args.push(...paths);
  return (await runGit(dir, args)).trim();
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const out = await runGit(dir, ["rev-parse", "--is-inside-work-tree"]);
    return out.trim() === "true";
  } catch {
    return false;
  }
}

export interface ChangedFiles {
  created: string[];
  modified: string[];
  deleted: string[];
}

// pure set diff of two file lists (e.g. git status snapshots taken before
// and after a task). created = newly dirty, deleted = became clean,
// modified = dirty in both snapshots.
export function changedFiles(before: string[], after: string[]): ChangedFiles {
  const b = new Set(before);
  const a = new Set(after);
  return {
    created: after.filter((f) => !b.has(f)),
    modified: after.filter((f) => b.has(f)),
    deleted: before.filter((f) => !a.has(f)),
  };
}
