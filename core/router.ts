// deterministic model router for silk. rules over registry data, no ml.

import type { ModelInfo, ModelRegistry } from "./models.js";

export type TaskKind =
  | "simple"
  | "reasoning"
  | "coding"
  | "review"
  | "vision"
  | "fast";

export interface RouteRequest {
  kind: TaskKind;
  needVision?: boolean;
  estimatedInputTokens?: number;
  preferProvider?: string;
  avoidModel?: string;
  coderModel?: string;
}

export interface RouteDecision {
  model: string;
  provider: string;
  reason: string;
  capabilities: string[];
}

function capabilitiesOf(m: ModelInfo): string[] {
  const caps: string[] = [];
  if (m.supportsStreaming) caps.push("streaming");
  if (m.supportsTools) caps.push("tools");
  if (m.supportsVision) caps.push("vision");
  if (m.supportsReasoning) caps.push("reasoning");
  if (m.supportsStructuredOutput) caps.push("structured-output");
  return caps;
}

function decide(m: ModelInfo, reason: string): RouteDecision {
  return {
    model: m.id,
    provider: m.provider,
    reason,
    capabilities: capabilitiesOf(m),
  };
}

// cheapest first, id as stable tiebreak
function cheapest(models: ModelInfo[]): ModelInfo {
  return [...models].sort(
    (a, b) => a.relativeCost - b.relativeCost || a.id.localeCompare(b.id)
  )[0];
}

// largest context first, cheaper as stable tiebreak
function roomiest(models: ModelInfo[]): ModelInfo {
  return [...models].sort(
    (a, b) => b.contextWindow - a.contextWindow || a.relativeCost - b.relativeCost
  )[0];
}

export function route(
  req: RouteRequest,
  registry: ModelRegistry
): RouteDecision {
  let pool = registry.list();
  if (pool.length === 0) {
    throw new Error("model registry is empty, cannot route");
  }

  // soft provider preference: honored when it matches, otherwise ignored
  let prefNote = "";
  if (req.preferProvider) {
    const wanted = pool.filter((m) => m.provider === req.preferProvider);
    if (wanted.length > 0) {
      pool = wanted;
    } else {
      prefNote =
        "; preferred provider '" + req.preferProvider + "' has no models";
    }
  }

  // unknown avoidModel ids are simply ignored
  if (req.avoidModel) {
    pool = pool.filter((m) => m.id !== req.avoidModel);
  }

  // context overflow disqualifies a model outright
  if (
    typeof req.estimatedInputTokens === "number" &&
    req.estimatedInputTokens > 0
  ) {
    const need = req.estimatedInputTokens;
    pool = pool.filter((m) => m.contextWindow >= need);
    if (pool.length === 0) {
      throw new Error(
        "no registered model has a context window big enough for ~" +
          need +
          " tokens"
      );
    }
  }

  if (pool.length === 0) {
    throw new Error("no models left after applying routing constraints");
  }

  // vision requirement applies to any task kind that asks for it
  if (req.kind === "vision" || req.needVision === true) {
    pool = pool.filter((m) => m.supportsVision);
    if (pool.length === 0) {
      throw new Error(
        "no vision-capable model in the registry; add one or pick a text-only task"
      );
    }
  }

  const withTools = pool.filter((m) => m.supportsTools);
  const needTools = (what: string): ModelInfo[] => {
    if (withTools.length === 0) {
      throw new Error("no tool-capable model registered for " + what);
    }
    return withTools;
  };

  switch (req.kind) {
    case "vision": {
      const pick = roomiest(pool);
      return decide(
        pick,
        "picked " +
          pick.id +
          ": vision-capable with the largest context window (" +
          pick.contextWindow +
          " tokens)" +
          prefNote
      );
    }

    case "reasoning": {
      const thinkers = pool.filter((m) => m.supportsReasoning);
      if (thinkers.length > 0) {
        const pick = roomiest(thinkers);
        return decide(
          pick,
          "picked " +
            pick.id +
            ": reasoning-capable with the largest context window (" +
            pick.contextWindow +
            " tokens)" +
            prefNote
        );
      }
      const pick = roomiest(pool);
      return decide(
        pick,
        "picked " +
          pick.id +
          ": no dedicated reasoning model registered, used the largest context window instead" +
          prefNote
      );
    }

    case "coding": {
      const capable = needTools("coding tasks");
      // mid cost or better: at or under the median price, then roomiest
      const sorted = [...capable].sort(
        (a, b) => a.relativeCost - b.relativeCost
      );
      const median = sorted[Math.floor((sorted.length - 1) / 2)].relativeCost;
      const affordable = sorted.filter((m) => m.relativeCost <= median);
      const pick = roomiest(affordable);
      return decide(
        pick,
        "picked " +
          pick.id +
          ": tool-capable at mid-range cost with a " +
          pick.contextWindow +
          " token window" +
          prefNote
      );
    }

    case "review": {
      const capable = needTools("review tasks");
      const coder = req.coderModel
        ? registry.get(req.coderModel)
        : undefined;
      if (coder) {
        // anti self-confirmation: a different provider reviews when possible
        const others = capable.filter((m) => m.provider !== coder.provider);
        if (others.length > 0) {
          const pick = roomiest(others);
          return decide(
            pick,
            "picked " +
              pick.id +
              ": different provider than the coder (" +
              coder.provider +
              ") for independent review" +
              prefNote
          );
        }
        return decide(
          coder,
          "picked " +
            coder.id +
            ": only one provider available, reviewer reuses the coder model as a separate stage" +
            prefNote
        );
      }
      const pick = roomiest(capable);
      return decide(
        pick,
        "picked " +
          pick.id +
          ": no coder model given, used the largest-context tool-capable model" +
          prefNote
      );
    }

    case "simple":
    case "fast":
    default: {
      const capable = needTools(req.kind + " tasks");
      const pick = cheapest(capable);
      return decide(
        pick,
        "picked " +
          pick.id +
          ": cheapest tool-capable model for a " +
          req.kind +
          " task" +
          prefNote
      );
    }
  }
}
