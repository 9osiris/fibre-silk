// model registry for silk. capability metadata per model, user editable.
// the runtime never branches on model names, only on these flags.

export interface ModelInfo {
  id: string;
  provider: "openai" | "anthropic";
  displayName: string;
  contextWindow: number;
  supportsStreaming: boolean;
  supportsTools: boolean;
  supportsVision: boolean;
  supportsReasoning: boolean;
  supportsStructuredOutput: boolean;
  // rough price ratio, 1.0 is the cheap baseline, higher is pricier
  relativeCost: number;
}

// default data only. users can replace or extend these in config.
// ids below are real public model ids as of late 2025; context windows
// and flags reflect their documented specs. costs are approximate.
export const DEFAULT_MODELS: ModelInfo[] = [
  {
    id: "gpt-4o-mini",
    provider: "openai",
    displayName: "GPT-4o mini",
    contextWindow: 128000,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: false,
    supportsStructuredOutput: true,
    relativeCost: 1.0,
  },
  {
    id: "gpt-4.1",
    provider: "openai",
    displayName: "GPT-4.1",
    contextWindow: 1048576,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: false,
    supportsStructuredOutput: true,
    relativeCost: 6.0,
  },
  {
    id: "o4-mini",
    provider: "openai",
    displayName: "o4 mini",
    contextWindow: 200000,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsStructuredOutput: true,
    relativeCost: 4.0,
  },
  {
    id: "gpt-4o",
    provider: "openai",
    displayName: "GPT-4o",
    contextWindow: 128000,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: false,
    supportsStructuredOutput: true,
    relativeCost: 8.0,
  },
  {
    id: "claude-sonnet-4-5",
    provider: "anthropic",
    displayName: "Claude Sonnet 4.5",
    contextWindow: 200000,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsStructuredOutput: false,
    relativeCost: 10.0,
  },
  {
    id: "claude-opus-4-1",
    provider: "anthropic",
    displayName: "Claude Opus 4.1",
    contextWindow: 200000,
    supportsStreaming: true,
    supportsTools: true,
    supportsVision: true,
    supportsReasoning: true,
    supportsStructuredOutput: false,
    relativeCost: 40.0,
  },
];

export interface ModelRegistry {
  list(): ModelInfo[];
  get(id: string): ModelInfo | undefined;
  add(m: ModelInfo): void;
}

// overrides win over defaults on id collision, so user config replaces
// shipped entries instead of duplicating them
export function createRegistry(
  defaults: ModelInfo[] = DEFAULT_MODELS,
  overrides: ModelInfo[] = []
): ModelRegistry {
  const byId = new Map<string, ModelInfo>();
  for (const m of defaults) byId.set(m.id, { ...m });
  for (const m of overrides) {
    if (!m || typeof m.id !== "string" || m.id.length === 0) {
      throw new Error("model override needs a non-empty id");
    }
    byId.set(m.id, { ...m });
  }
  return {
    list: () => [...byId.values()],
    get: (id: string) => {
      const m = byId.get(id);
      return m ? { ...m } : undefined;
    },
    add: (m: ModelInfo) => {
      if (!m || typeof m.id !== "string" || m.id.length === 0) {
        throw new Error("model needs a non-empty id");
      }
      byId.set(m.id, { ...m });
    },
  };
}

// plain array of ModelInfo, suitable for storing in user config
export function registryToJSON(r: ModelRegistry): ModelInfo[] {
  return r.list();
}

// rebuild a registry from stored json, throws on malformed data
export function registryFromJSON(data: unknown): ModelRegistry {
  if (!Array.isArray(data)) {
    throw new Error("model registry json must be an array");
  }
  const models: ModelInfo[] = data.map((raw, i) => {
    const m = raw as Partial<ModelInfo>;
    if (!m || typeof m.id !== "string" || m.id.length === 0) {
      throw new Error("model registry entry " + i + " needs a non-empty id");
    }
    if (m.provider !== "openai" && m.provider !== "anthropic") {
      throw new Error("model " + m.id + " has an unknown provider");
    }
    return {
      id: m.id,
      provider: m.provider,
      displayName: typeof m.displayName === "string" ? m.displayName : m.id,
      contextWindow:
        typeof m.contextWindow === "number" ? m.contextWindow : 0,
      supportsStreaming: m.supportsStreaming === true,
      supportsTools: m.supportsTools === true,
      supportsVision: m.supportsVision === true,
      supportsReasoning: m.supportsReasoning === true,
      supportsStructuredOutput: m.supportsStructuredOutput === true,
      relativeCost: typeof m.relativeCost === "number" ? m.relativeCost : 1.0,
    };
  });
  return createRegistry(models);
}
