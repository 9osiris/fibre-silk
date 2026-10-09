// persistent memory service over the store: categorized records with
// provenance, secret refusal at the boundary, ranked retrieval with a
// hard size budget. memory is data, never executable policy.
import type {
  FibreStore,
  MemoryCategory,
  MemoryProvenance,
  MemoryRecord,
  TaskRecord,
} from "./store.js";

export type { MemoryCategory, MemoryProvenance, MemoryRecord } from "./store.js";

// --- secret guard ---

const SECRET_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // openai-style keys
  /\bghp_[A-Za-z0-9]{20,}/, // github personal tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}/, // github fine-grained tokens
  /\bAKIA[0-9A-Z]{16}\b/, // aws access key ids
  /\bapi[_-]?key\b\s*[:=]/i, // labeled key assignments
  /\b(api[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token)\b\s*[:=]/i,
  /\bpassword\s*[:=]/i,
  /\bbearer\s+[A-Za-z0-9._~+/=-]{10,}/i,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/, // pem private keys
  /\b[0-9a-f]{32,}\b/i, // long hex blobs (digests, raw keys)
  /\b[A-Za-z0-9+/]{40,}={0,2}\b/, // long base64 blobs
];

// true when the text carries something that looks like a credential.
// memory never stores secrets; callers get a hard refusal, not a filter.
export function looksSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

function assertNotSecret(content: string): void {
  if (looksSecret(content)) {
    throw new Error(
      "memory refused: content looks like a secret (keys, tokens, and credentials are never stored as memory)"
    );
  }
}

// --- retrieval ---

const STOP_WORDS = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in", "is", "it", "for",
  "on", "with", "this", "that", "uses", "use", "used", "when", "into",
]);

function tokenize(text: string): string[] {
  const out: string[] = [];
  for (const t of text.toLowerCase().split(/[^a-z0-9_.-]+/)) {
    if (t.length > 1 && !STOP_WORDS.has(t)) out.push(t);
  }
  return out;
}

interface Scored {
  rec: MemoryRecord;
  score: number;
}

export class MemoryService {
  constructor(private store: FibreStore) {}

  // create a memory after the secret guard. source is a short provenance
  // label (task id, file path, "user"), never a credential carrier.
  remember(input: {
    workspaceId?: string | null;
    category: MemoryCategory;
    content: string;
    provenance: MemoryProvenance;
    confidence?: number;
    importance?: number;
    source?: string;
    expiresAt?: number | null;
  }): MemoryRecord {
    assertNotSecret(input.content);
    return this.store.createMemory(input);
  }

  get(id: string): MemoryRecord | null {
    return this.store.getMemory(id);
  }

  list(opts: {
    workspaceId?: string | null;
    category?: MemoryCategory;
    includeSuperseded?: boolean;
  } = {}): MemoryRecord[] {
    return this.store.listMemories(opts);
  }

  update(
    id: string,
    patch: Partial<Pick<MemoryRecord, "content" | "category" | "confidence" | "importance" | "expiresAt">>
  ): MemoryRecord | null {
    if (patch.content !== undefined) assertNotSecret(patch.content);
    return this.store.updateMemory(id, patch);
  }

  remove(id: string): void {
    this.store.deleteMemory(id);
  }

  // supersede an outdated fact with a corrected one. the old record is
  // kept, marked, and excluded from retrieval; never silently rewritten.
  supersede(
    id: string,
    content: string,
    patch: Partial<MemoryRecord> = {}
  ): MemoryRecord | null {
    assertNotSecret(content);
    return this.store.supersedeMemory(id, content, patch);
  }

  // ranked retrieval over active memories. score is idf-weighted token
  // overlap plus importance, confidence, recency, and workspace affinity.
  // hard caps: at most `limit` records and never past `budgetChars` of
  // rendered content.
  search(
    query: string,
    opts: {
      workspaceId?: string | null;
      category?: MemoryCategory;
      limit?: number;
      budgetChars?: number;
      includeSuperseded?: boolean;
    } = {}
  ): MemoryRecord[] {
    const limit = opts.limit ?? 8;
    const budgetChars = opts.budgetChars ?? 4000;
    const workspaceId = opts.workspaceId ?? null;
    const now = Date.now();

    const pool = this.store
      .listMemories({ category: opts.category, includeSuperseded: true })
      .filter((m) => {
        if (!opts.includeSuperseded && m.supersededBy) return false;
        if (m.expiresAt !== null && m.expiresAt <= now) return false;
        // with a workspace filter: that workspace plus global only
        if (workspaceId !== null && m.workspaceId !== workspaceId && m.workspaceId !== null) {
          return false;
        }
        return true;
      });
    if (pool.length === 0) return [];

    const docTokens = pool.map((m) => tokenize(m.content + " " + m.category.replace(/_/g, " ")));
    const df = new Map<string, number>();
    for (const toks of docTokens) {
      for (const t of new Set(toks)) df.set(t, (df.get(t) ?? 0) + 1);
    }
    const idf = (t: string): number => Math.log(1 + pool.length / (1 + (df.get(t) ?? 0)));

    const queryTokens = [...new Set(tokenize(query))];
    if (queryTokens.length === 0) return [];
    const maxRelevance = queryTokens.reduce((s, t) => s + idf(t), 0);
    if (maxRelevance <= 0) return [];

    const scored: Scored[] = [];
    for (let i = 0; i < pool.length; i++) {
      const m = pool[i];
      const counts = new Map<string, number>();
      for (const t of docTokens[i]) counts.set(t, (counts.get(t) ?? 0) + 1);
      let relevance = 0;
      for (const t of queryTokens) {
        const c = counts.get(t);
        if (c) relevance += idf(t) * Math.min(c, 3);
      }
      if (relevance <= 0) continue;
      const ageDays = Math.max(0, (now - m.updatedAt) / 86_400_000);
      const recency = 0.3 * Math.max(0, 1 - ageDays / 90);
      const affinity =
        workspaceId !== null && m.workspaceId === workspaceId
          ? 1.0
          : m.workspaceId === null
            ? 0.5
            : 0.25;
      const score =
        2.0 * (relevance / maxRelevance) + m.importance + m.confidence + recency + affinity;
      scored.push({ rec: m, score });
    }
    scored.sort((a, b) => b.score - a.score || b.rec.updatedAt - a.rec.updatedAt);

    const out: MemoryRecord[] = [];
    let used = 0;
    for (const { rec } of scored) {
      if (out.length >= limit) break;
      // rendered as "- [category] content (provenance)": ~48 chars overhead
      used += rec.content.length + 48;
      if (used > budgetChars) break;
      out.push(rec);
    }
    return out;
  }

  // derive durable facts from a finished task. only observed or verified
  // facts are created here; never user preferences, never inferences.
  // duplicates (same workspace, category, content) are skipped.
  memoriesFromTask(
    task: TaskRecord,
    workspace: {
      languages: string[];
      testCommand?: string;
      buildCommand?: string;
      verificationOk?: boolean;
    }
  ): MemoryRecord[] {
    const out: MemoryRecord[] = [];
    const workspaceId = task.workspaceId ?? null;
    const existing = new Set(
      this.store
        .listMemories({ includeSuperseded: false })
        .map((m) => `${m.workspaceId ?? ""}|${m.category}|${m.content}`)
    );
    const add = (
      category: MemoryCategory,
      content: string,
      provenance: MemoryProvenance,
      confidence: number,
      importance: number
    ): void => {
      const key = `${workspaceId ?? ""}|${category}|${content}`;
      if (existing.has(key) || looksSecret(content)) return;
      existing.add(key);
      out.push(
        this.remember({
          workspaceId,
          category,
          content,
          provenance,
          confidence,
          importance,
          source: "task " + task.id,
        })
      );
    };

    if (workspace.languages.length > 0) {
      add(
        "project_fact",
        "project languages: " + workspace.languages.join(", "),
        "repo_observed",
        0.9,
        0.4
      );
    }
    if (workspace.buildCommand) {
      add("project_fact", "build command: " + workspace.buildCommand, "repo_observed", 0.8, 0.5);
    }
    if (workspace.testCommand) {
      add(
        "project_fact",
        "test command: " + workspace.testCommand,
        workspace.verificationOk ? "test_verified" : "repo_observed",
        workspace.verificationOk ? 0.95 : 0.7,
        0.7
      );
    }
    const changed = [
      ...task.filesChanged.created,
      ...task.filesChanged.modified,
      ...task.filesChanged.deleted,
    ];
    if (task.status === "completed") {
      add(
        "task_knowledge",
        "task completed: " + task.goal +
          (changed.length > 0 ? " (changed: " + changed.slice(0, 10).join(", ") + ")" : ""),
        workspace.verificationOk ? "test_verified" : "repo_observed",
        workspace.verificationOk ? 0.9 : 0.6,
        0.5
      );
    } else if (task.status === "failed") {
      add(
        "known_issue",
        "task failed: " + task.goal + (task.error ? " (" + task.error.slice(0, 120) + ")" : ""),
        "repo_observed",
        0.5,
        0.5
      );
    }
    return out;
  }

  // export every memory (including superseded) as portable json.
  exportJson(): string {
    const memories = this.store.listMemories({ includeSuperseded: true });
    return JSON.stringify({ format: "fibre-memory-export", version: 1, memories }, null, 2);
  }

  // import memories produced by exportJson. records identical to an
  // existing one (same workspace, category, content) are skipped, as
  // are secret-shaped or malformed entries. superseded links are not
  // reconstructed; imported records start active.
  importJson(text: string): { imported: number; skipped: number } {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error("memory import failed: not valid json");
    }
    const entries: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray((parsed as { memories?: unknown }).memories)
        ? ((parsed as { memories: unknown[] }).memories ?? [])
        : [];
    const existing = new Set(
      this.store
        .listMemories({ includeSuperseded: true })
        .map((m) => `${m.workspaceId ?? ""}|${m.category}|${m.content}`)
    );
    let imported = 0;
    let skipped = 0;
    for (const e of entries) {
      const r = e as Partial<MemoryRecord>;
      if (
        typeof r?.content !== "string" ||
        typeof r?.category !== "string" ||
        typeof r?.provenance !== "string" ||
        looksSecret(r.content)
      ) {
        skipped++;
        continue;
      }
      const key = `${r.workspaceId ?? ""}|${r.category}|${r.content}`;
      if (existing.has(key)) {
        skipped++;
        continue;
      }
      existing.add(key);
      this.store.createMemory({
        workspaceId: (r.workspaceId as string | null) ?? null,
        category: r.category as MemoryCategory,
        content: r.content,
        provenance: r.provenance as MemoryProvenance,
        confidence: typeof r.confidence === "number" ? r.confidence : 0.5,
        importance: typeof r.importance === "number" ? r.importance : 0.5,
        source: typeof r.source === "string" ? r.source : "import",
        expiresAt: typeof r.expiresAt === "number" ? r.expiresAt : null,
      });
      imported++;
    }
    return { imported, skipped };
  }
}

// compact memory block for model context: one line per record, hard
// truncated at the budget. empty string when there is nothing to say.
export function memoryContextBlock(records: MemoryRecord[], budgetChars = 3000): string {
  if (records.length === 0) return "";
  const lines: string[] = [];
  let used = 0;
  for (const r of records) {
    const line = `- [${r.category}] ${r.content} (${r.provenance})`;
    const add = used === 0 ? line.length : line.length + 1;
    if (used + add > budgetChars) {
      if (used === 0) lines.push(line.slice(0, budgetChars));
      break;
    }
    lines.push(line);
    used += add;
  }
  return lines.join("\n");
}
