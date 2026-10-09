// independent reviewer: inspects a diff + test report, returns structured
// findings. the reviewer never edits files, it only reports.

import type { ChatMessage, Provider } from "./providers.js";

export interface Finding {
  severity: "high" | "medium" | "low";
  file: string;
  description: string;
}

export interface ReviewResult {
  status: "approved" | "changes_required";
  findings: Finding[];
}

export interface ReviewInput {
  goal: string;
  diff: string;
  testReport: string;
}

const SEVERITIES = new Set(["high", "medium", "low"]);

function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const src = fenced ? fenced[1] : text;
  const start = src.indexOf("{");
  const end = src.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("no json object found in model reply");
  }
  return src.slice(start, end + 1);
}

export async function reviewChanges(
  provider: Provider,
  input: ReviewInput,
  opts?: { model?: string }
): Promise<ReviewResult> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a strict code reviewer. Reply with ONLY a JSON object, no prose.",
    },
    {
      role: "user",
      content:
        "Review these changes against the goal. Be strict but fair: flag " +
        "real bugs, security issues, incomplete work, and regressions. " +
        "Do not nitpick style.\n\n" +
        'Reply with exactly: {"status": "approved" | "changes_required", ' +
        '"findings": [{"severity": "high" | "medium" | "low", "file": "...", ' +
        '"description": "..."}]}.\n\n' +
        "Goal: " + input.goal + "\n\nDiff:\n" + input.diff.slice(0, 20000) +
        "\n\nTest report:\n" + input.testReport.slice(0, 8000),
    },
  ];
  let text = "";
  for await (const ev of provider.chat(messages, { model: opts?.model ?? "" })) {
    if (ev.type === "text") text += ev.delta;
  }
  let raw: any;
  try {
    raw = JSON.parse(extractJsonObject(text));
  } catch (err) {
    throw new Error(
      "reviewer: model did not return valid JSON: " +
        (err instanceof Error ? err.message : String(err))
    );
  }
  if (raw?.status !== "approved" && raw?.status !== "changes_required") {
    throw new Error('reviewer: status must be "approved" or "changes_required"');
  }
  const findings: Finding[] = Array.isArray(raw.findings)
    ? raw.findings.map((f: any) => ({
        severity: SEVERITIES.has(f?.severity) ? f.severity : "medium",
        file: String(f?.file ?? ""),
        description: String(f?.description ?? ""),
      }))
    : [];
  return { status: raw.status, findings };
}
