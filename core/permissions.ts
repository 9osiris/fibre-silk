// permission levels and per-tool policy. the real gate lives in
// ToolRuntime; this module only holds the policy data.

export type PolicyLevel =
  | "read"
  | "write"
  | "execute"
  | "delete"
  | "network"
  | "git";

export type Permission =
  | "allow_once"
  | "allow_session"
  | "allow_always"
  | "deny";

// tool name -> policy level. git_* entries are for the git tools landing later.
export const TOOL_LEVELS: Record<string, PolicyLevel> = {
  fs_list: "read",
  fs_read: "read",
  fs_write: "write",
  exec: "execute",
  git_status: "git",
  git_diff: "git",
  git_log: "git",
};

export class PermissionStore {
  private grants = new Map<string, Permission>();

  constructor(defaults: Record<string, Permission> = {}) {
    for (const [tool, perm] of Object.entries(defaults)) {
      this.grants.set(tool, perm);
    }
  }

  // read-level tools are always allowed; everything else asks unless granted
  check(tool: string): Permission | "ask" {
    const granted = this.grants.get(tool);
    if (granted) return granted;
    return TOOL_LEVELS[tool] === "read" ? "allow_always" : "ask";
  }

  grant(tool: string, perm: Permission): void {
    this.grants.set(tool, perm);
  }

  // allow_once grants are single use
  consume(tool: string): void {
    if (this.grants.get(tool) === "allow_once") {
      this.grants.delete(tool);
    }
  }
}
