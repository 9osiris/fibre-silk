// task planner: asks the model for a machine-readable plan, tracks step state.
// Plan/PlanStep come from the canonical event protocol in events.ts.

import type { ChatMessage, Provider } from "./providers.js";
import type { Plan, PlanStep, StepStatus } from "./events.js";

export type StepState = StepStatus;
export type { Plan, PlanStep };

// pull the first {...} json object out of a reply, tolerating fences
export function extractJsonObject(text: string): string {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const src = fenced ? fenced[1] : text;
  const start = src.indexOf("{");
  const end = src.lastIndexOf("}");
  if (start < 0 || end <= start) {
    throw new Error("no json object found in model reply");
  }
  return src.slice(start, end + 1);
}

export async function generatePlan(
  provider: Provider,
  goal: string,
  opts?: { model?: string }
): Promise<Plan> {
  const messages: ChatMessage[] = [
    {
      role: "system",
      content:
        "You are a planning assistant. Reply with ONLY a JSON object, no prose.",
    },
    {
      role: "user",
      content:
        "Break this goal into a short ordered list of concrete steps. " +
        'Reply with exactly: {"goal": "...", "steps": [{"id": "inspect", "description": "..."}, ...]}. ' +
        "Keep ids short lowercase slugs, 3 to 8 steps.\n\nGoal: " + goal,
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
      "planner: model did not return a valid JSON plan: " +
        (err instanceof Error ? err.message : String(err)) +
        " (reply started: " + JSON.stringify(text.slice(0, 120)) + ")"
    );
  }
  if (!raw || typeof raw !== "object" || !Array.isArray(raw.steps)) {
    throw new Error("planner: plan JSON missing a steps array");
  }
  const steps: PlanStep[] = raw.steps.map((s: any, i: number) => ({
    id: String(s?.id ?? "step-" + (i + 1)),
    description: String(s?.description ?? ""),
    status: "pending" as StepStatus,
  }));
  if (steps.length === 0) throw new Error("planner: plan has no steps");
  return { goal: String(raw.goal ?? goal), steps };
}

export function setStepState(plan: Plan, id: string, status: StepStatus): Plan {
  const step = plan.steps.find((s) => s.id === id);
  if (!step) throw new Error("planner: unknown step id " + id);
  step.status = status;
  return plan;
}

export function nextPending(plan: Plan): PlanStep | undefined {
  return plan.steps.find((s) => s.status === "pending");
}
