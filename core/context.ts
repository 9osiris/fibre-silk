// context assembly with budgets. large parts get truncated, never
// silently dropped; error lines are hoisted so they survive truncation.

export interface ContextPart {
  label: string;
  text: string;
  budget?: number; // max chars for this part
  keep?: "head" | "tail" | "both";
}

const ERROR_RE = /error|failed|exception|traceback|panic/i;
const MIN_KEEP = 400; // chars per side when a part must not vanish

function errorLines(text: string, max = 12): string[] {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    if (ERROR_RE.test(line)) {
      found.push(line.trim());
      if (found.length >= max) break;
    }
  }
  return found;
}

function truncate(text: string, budget: number, keep: "head" | "tail" | "both"): string {
  if (text.length <= budget) return text;
  const dropped = text.length - budget;
  const marker = "\n[...truncated " + dropped + " chars...]\n";
  const hoisted = errorLines(text);
  const hoistBlock = hoisted.length > 0
    ? "[important lines]\n" + hoisted.join("\n") + "\n"
    : "";
  if (keep === "head") {
    return hoistBlock + text.slice(0, budget) + marker;
  }
  if (keep === "tail") {
    return hoistBlock + marker + text.slice(-budget);
  }
  const side = Math.max(1, Math.floor((budget - marker.length) / 2));
  return (
    hoistBlock +
    text.slice(0, side) + marker + text.slice(-side)
  );
}

export function assembleContext(parts: ContextPart[], totalBudget = 12000): string {
  let remaining = totalBudget;
  const out: string[] = [];
  for (const part of parts) {
    const keep = part.keep ?? "both";
    let budget = part.budget ?? remaining;
    if (keep === "both" && part.budget === undefined) {
      // these parts always survive, at least as head+tail
      budget = Math.max(budget, Math.min(MIN_KEEP * 2, totalBudget));
    } else {
      budget = Math.max(0, Math.min(budget, remaining));
    }
    if (budget <= 0 && keep !== "both") continue;
    const text = truncate(part.text, budget, keep);
    remaining = Math.max(0, remaining - text.length);
    out.push("## " + part.label + "\n" + text);
  }
  return out.join("\n\n");
}
