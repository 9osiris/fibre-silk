// unified chat provider layer for silk. pure typescript, no electron apis.

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCalls?: ToolCall[];
  toolCallId?: string;
}

export interface ToolDef {
  name: string;
  description: string;
  // json schema object describing the tool arguments
  schema: Record<string, unknown>;
}

export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "toolCalls"; calls: ToolCall[] }
  | { type: "done"; usage?: { inputTokens: number; outputTokens: number } };

export interface ChatOptions {
  model: string;
  tools?: ToolDef[];
  signal?: AbortSignal;
}

export interface Provider {
  readonly id: "openai" | "anthropic";
  chat(messages: ChatMessage[], opts: ChatOptions): AsyncGenerator<ChatEvent>;
}

// short pause before a single retry
function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function retryable(status: number): boolean {
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

// one parsed sse frame: optional event name plus its data payload
interface SseFrame {
  event: string;
  data: string;
}

// read a fetch response body as a stream of sse frames
async function* readSse(res: Response): AsyncGenerator<SseFrame> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let event = "";
  const dataLines: string[] = [];

  function* flushBlock(): Generator<SseFrame> {
    if (dataLines.length > 0 || event) {
      yield { event, data: dataLines.join("\n") };
    }
    event = "";
    dataLines.length = 0;
  }

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, idx).replace(/\r$/, "");
      buf = buf.slice(idx + 1);
      if (line === "") {
        yield* flushBlock();
      } else if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
      // comment lines starting with ":" are ignored per sse spec
    }
  }
  buf += decoder.decode();
  if (buf) {
    for (const line of buf.split("\n")) {
      const clean = line.replace(/\r$/, "");
      if (clean === "") yield* flushBlock();
      else if (clean.startsWith("event:")) event = clean.slice(6).trim();
      else if (clean.startsWith("data:")) dataLines.push(clean.slice(5).trimStart());
    }
  }
  yield* flushBlock();
}

// parse tool args, falling back to {} on malformed json
function safeArgs(raw: string): Record<string, unknown> {
  if (!raw) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : {};
  } catch {
    return {};
  }
}

async function postWithRetry(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  let lastStatus = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal,
    });
    if (res.ok) return res;
    lastStatus = res.status;
    await res.arrayBuffer().catch(() => null); // drain before retry
    if (!retryable(res.status) || attempt === 1) break;
    await sleep(400 * (attempt + 1));
  }
  // never include headers or body here: they carry the api key
  throw new Error(`provider request failed with status ${lastStatus}`);
}

// ---- openai-compatible (chat/completions) ----

interface OpenAIToolCallFrag {
  id: string;
  name: string;
  args: string;
}

function toOpenAIMessage(m: ChatMessage): Record<string, unknown> {
  if (m.role === "tool") {
    return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
  }
  const out: Record<string, unknown> = { role: m.role, content: m.content };
  if (m.role === "assistant" && m.toolCalls?.length) {
    out.tool_calls = m.toolCalls.map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.name, arguments: JSON.stringify(tc.args) },
    }));
  }
  return out;
}

export class OpenAICompatibleProvider implements Provider {
  readonly id = "openai" as const;
  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;

  constructor(opts: { apiKey: string; baseUrl: string; model?: string }) {
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.defaultModel = opts.model ?? "gpt-4o-mini";
  }

  async *chat(messages: ChatMessage[], opts: ChatOptions): AsyncGenerator<ChatEvent> {
    const body: Record<string, unknown> = {
      model: opts.model || this.defaultModel,
      messages: messages.map(toOpenAIMessage),
      stream: true,
      stream_options: { include_usage: true },
    };
    if (opts.tools?.length) {
      body.tools = opts.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.schema },
      }));
    }
    const res = await postWithRetry(
      `${this.baseUrl}/chat/completions`,
      { "content-type": "application/json", authorization: `Bearer ${this.apiKey}` },
      body,
      opts.signal,
    );

    const frags = new Map<number, OpenAIToolCallFrag>();
    let usage: { inputTokens: number; outputTokens: number } | undefined;

    for await (const frame of readSse(res)) {
      if (frame.data === "[DONE]") break;
      let chunk: any;
      try {
        chunk = JSON.parse(frame.data);
      } catch {
        continue; // skip malformed keepalive chunks
      }
      if (chunk.usage) {
        usage = {
          inputTokens: chunk.usage.prompt_tokens ?? 0,
          outputTokens: chunk.usage.completion_tokens ?? 0,
        };
      }
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;
      if (typeof delta.content === "string" && delta.content) {
        yield { type: "text", delta: delta.content };
      }
      for (const tc of delta.tool_calls ?? []) {
        const i = tc.index ?? 0;
        const cur = frags.get(i) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name = tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        frags.set(i, cur);
      }
    }

    if (frags.size > 0) {
      const calls: ToolCall[] = [...frags.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, f]) => ({ id: f.id, name: f.name, args: safeArgs(f.args) }));
      yield { type: "toolCalls", calls };
    }
    yield usage ? { type: "done", usage } : { type: "done" };
  }
}

// ---- anthropic (messages api) ----

function toAnthropicMessages(messages: ChatMessage[]): {
  system?: string;
  messages: Record<string, unknown>[];
} {
  const systemParts = messages.filter((m) => m.role === "system").map((m) => m.content);
  const out: Record<string, unknown>[] = [];
  for (const m of messages) {
    if (m.role === "system") continue;
    if (m.role === "tool") {
      out.push({
        role: "user",
        content: [{ type: "tool_result", tool_use_id: m.toolCallId, content: m.content }],
      });
      continue;
    }
    if (m.role === "assistant" && m.toolCalls?.length) {
      const content: Record<string, unknown>[] = [];
      if (m.content) content.push({ type: "text", text: m.content });
      for (const tc of m.toolCalls) {
        content.push({ type: "tool_use", id: tc.id, name: tc.name, input: tc.args });
      }
      out.push({ role: "assistant", content });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  return {
    system: systemParts.length ? systemParts.join("\n\n") : undefined,
    messages: out,
  };
}

export class AnthropicProvider implements Provider {
  readonly id = "anthropic" as const;
  private apiKey: string;
  private defaultModel: string;

  constructor(opts: { apiKey: string; model?: string }) {
    this.apiKey = opts.apiKey;
    this.defaultModel = opts.model ?? "claude-sonnet-4-20250514";
  }

  async *chat(messages: ChatMessage[], opts: ChatOptions): AsyncGenerator<ChatEvent> {
    const { system, messages: apiMessages } = toAnthropicMessages(messages);
    const body: Record<string, unknown> = {
      model: opts.model || this.defaultModel,
      max_tokens: 4096,
      messages: apiMessages,
      stream: true,
    };
    if (system) body.system = system;
    if (opts.tools?.length) {
      body.tools = opts.tools.map((t) => ({
        name: t.name,
        description: t.description,
        input_schema: t.schema,
      }));
    }
    const res = await postWithRetry(
      "https://api.anthropic.com/v1/messages",
      {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body,
      opts.signal,
    );

    let inputTokens = 0;
    let outputTokens = 0;
    // index -> { id, name, argsJson } for tool_use blocks
    const toolBlocks = new Map<number, { id: string; name: string; argsJson: string }>();

    for await (const frame of readSse(res)) {
      let data: any;
      try {
        data = JSON.parse(frame.data);
      } catch {
        continue;
      }
      const kind = frame.event || data.type;
      if (kind === "message_start") {
        inputTokens = data.message?.usage?.input_tokens ?? 0;
      } else if (kind === "content_block_start") {
        const block = data.content_block ?? {};
        if (block.type === "tool_use") {
          toolBlocks.set(data.index, { id: block.id ?? "", name: block.name ?? "", argsJson: "" });
        }
      } else if (kind === "content_block_delta") {
        const delta = data.delta ?? {};
        if (delta.type === "text_delta" && delta.text) {
          yield { type: "text", delta: delta.text };
        } else if (delta.type === "input_json_delta" && delta.partial_json) {
          const cur = toolBlocks.get(data.index);
          if (cur) cur.argsJson += delta.partial_json;
        }
      } else if (kind === "message_delta") {
        if (typeof data.usage?.output_tokens === "number") {
          outputTokens = data.usage.output_tokens;
        }
      } else if (kind === "message_stop") {
        break;
      }
    }

    if (toolBlocks.size > 0) {
      const calls: ToolCall[] = [...toolBlocks.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, b]) => ({ id: b.id, name: b.name, args: safeArgs(b.argsJson) }));
      yield { type: "toolCalls", calls };
    }
    yield { type: "done", usage: { inputTokens, outputTokens } };
  }
}
