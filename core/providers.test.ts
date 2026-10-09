// tests for providers.ts against local stub servers, no real network.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import { OpenAICompatibleProvider, AnthropicProvider, type ChatEvent } from "./providers";

interface Seen {
  headers: Record<string, string | string[] | undefined>;
  body: any;
}

type Handler = (seen: Seen[], req: IncomingMessage, res: ServerResponse) => void;

async function startStub(handler: Handler): Promise<{ url: string; seen: Seen[]; close: () => Promise<void> }> {
  const seen: Seen[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body: any = null;
      try {
        body = raw ? JSON.parse(raw) : null;
      } catch {
        body = raw;
      }
      seen.push({ headers: req.headers, body });
      handler(seen, req, res);
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  const port = typeof addr === "object" && addr ? addr.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

function sse(res: ServerResponse, frames: string[]): void {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const f of frames) res.write(f + "\n\n");
  res.end();
}

async function collect(gen: AsyncGenerator<ChatEvent>): Promise<ChatEvent[]> {
  const out: ChatEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

// ---- openai-compatible ----

const openaiFrames = [
  `data: ${JSON.stringify({ choices: [{ delta: { role: "assistant", content: "hi " }, index: 0 }] })}`,
  `data: ${JSON.stringify({ choices: [{ delta: { content: "there" }, index: 0 }] })}`,
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "calc", arguments: '{"expr":' } }] }, index: 0 }] })}`,
  `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"1+1"}' } }] }, index: 0 }] })}`,
  `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 8 } })}`,
  `data: [DONE]`,
];

describe("OpenAICompatibleProvider", () => {
  it("parses sse text, tool calls and usage", async () => {
    const stub = await startStub((_seen, _req, res) => sse(res, openaiFrames));
    try {
      const p = new OpenAICompatibleProvider({ apiKey: "k", baseUrl: stub.url });
      const events = await collect(
        p.chat([{ role: "user", content: "hello" }], { model: "m", tools: [{ name: "calc", description: "math", schema: { type: "object" } }] }),
      );
      assert.deepEqual(events, [
        { type: "text", delta: "hi " },
        { type: "text", delta: "there" },
        { type: "toolCalls", calls: [{ id: "call_1", name: "calc", args: { expr: "1+1" } }] },
        { type: "done", usage: { inputTokens: 12, outputTokens: 8 } },
      ]);
      const body = stub.seen[0].body;
      assert.equal(body.stream, true);
      assert.deepEqual(body.tools, [
        { type: "function", function: { name: "calc", description: "math", parameters: { type: "object" } } },
      ]);
      assert.equal(stub.seen[0].headers.authorization, "Bearer k");
    } finally {
      await stub.close();
    }
  });

  it("maps tool history back into openai format", async () => {
    const stub = await startStub((_seen, _req, res) => sse(res, [`data: [DONE]`]));
    try {
      const p = new OpenAICompatibleProvider({ apiKey: "k", baseUrl: stub.url });
      await collect(
        p.chat(
          [
            { role: "user", content: "q" },
            { role: "assistant", content: "", toolCalls: [{ id: "call_9", name: "calc", args: { expr: "2" } }] },
            { role: "tool", content: "4", toolCallId: "call_9" },
          ],
          { model: "m" },
        ),
      );
      const msgs = stub.seen[0].body.messages;
      assert.deepEqual(msgs[1].tool_calls, [
        { id: "call_9", type: "function", function: { name: "calc", arguments: '{"expr":"2"}' } },
      ]);
      assert.deepEqual(msgs[2], { role: "tool", content: "4", tool_call_id: "call_9" });
    } finally {
      await stub.close();
    }
  });

  it("retries once on 429 then succeeds", async () => {
    const stub = await startStub((seen, _req, res) => {
      if (seen.length === 1) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end("{}");
      } else {
        sse(res, [`data: {"choices":[{"delta":{"content":"ok"},"index":0}]}`, `data: [DONE]`]);
      }
    });
    try {
      const p = new OpenAICompatibleProvider({ apiKey: "k", baseUrl: stub.url });
      const events = await collect(p.chat([{ role: "user", content: "hi" }], { model: "m" }));
      assert.equal(stub.seen.length, 2);
      assert.deepEqual(events, [{ type: "text", delta: "ok" }, { type: "done" }]);
    } finally {
      await stub.close();
    }
  });

  it("throws without leaking the api key after repeated 500s", async () => {
    const stub = await startStub((_seen, _req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end("{}");
    });
    try {
      const p = new OpenAICompatibleProvider({ apiKey: "super-secret-key", baseUrl: stub.url });
      await assert.rejects(() => collect(p.chat([{ role: "user", content: "hi" }], { model: "m" })), (err: Error) => {
        assert.ok(!err.message.includes("super-secret-key"), "error leaked the key");
        return true;
      });
      assert.equal(stub.seen.length, 2); // one retry, then give up
    } finally {
      await stub.close();
    }
  });
});

// ---- anthropic ----

const anthropicFrames = [
  `event: message_start\ndata: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 5 } } })}`,
  `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 0, content_block: { type: "text" } })}`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "hello" } })}`,
  `event: content_block_start\ndata: ${JSON.stringify({ type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "calc" } })}`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"expr":' } })}`,
  `event: content_block_delta\ndata: ${JSON.stringify({ type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '"2+2"}' } })}`,
  `event: message_delta\ndata: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 9 } })}`,
  `event: message_stop\ndata: ${JSON.stringify({ type: "message_stop" })}`,
];

describe("AnthropicProvider", () => {
  it("parses sse text, tool_use blocks and usage", async () => {
    const stub = await startStub((_seen, _req, res) => sse(res, anthropicFrames));
    // point the provider at the stub by overriding fetch target is not
    // possible (url is fixed), so we test the mapping + parsing via a
    // subclass-free trick: temporarily rewrite the url through a proxy var.
    // instead we run the same flow the provider uses against the stub by
    // calling chat on a provider whose base we patch below.
    try {
      const p = new AnthropicProvider({ apiKey: "k" });
      // patch the hardcoded url for this test via module-level fetch wrap
      const realFetch = globalThis.fetch;
      (globalThis as any).fetch = (url: string, init: any) =>
        realFetch(url.replace("https://api.anthropic.com", stub.url), init);
      try {
        const events = await collect(
          p.chat(
            [
              { role: "system", content: "you are silk" },
              { role: "user", content: "hello" },
            ],
            { model: "m", tools: [{ name: "calc", description: "math", schema: { type: "object" } }] },
          ),
        );
        assert.deepEqual(events, [
          { type: "text", delta: "hello" },
          { type: "toolCalls", calls: [{ id: "toolu_1", name: "calc", args: { expr: "2+2" } }] },
          { type: "done", usage: { inputTokens: 5, outputTokens: 9 } },
        ]);
        const body = stub.seen[0].body;
        assert.equal(body.system, "you are silk");
        assert.deepEqual(body.tools, [{ name: "calc", description: "math", input_schema: { type: "object" } }]);
        assert.equal(stub.seen[0].headers["x-api-key"], "k");
        assert.equal(stub.seen[0].headers["anthropic-version"], "2023-06-01");
      } finally {
        (globalThis as any).fetch = realFetch;
      }
    } finally {
      await stub.close();
    }
  });

  it("maps tool history into anthropic blocks", async () => {
    const stub = await startStub((_seen, _req, res) => sse(res, anthropicFrames.slice(0, 1).concat(anthropicFrames.slice(-1))));
    try {
      const p = new AnthropicProvider({ apiKey: "k" });
      const realFetch = globalThis.fetch;
      (globalThis as any).fetch = (url: string, init: any) =>
        realFetch(url.replace("https://api.anthropic.com", stub.url), init);
      try {
        await collect(
          p.chat(
            [
              { role: "assistant", content: "let me calc", toolCalls: [{ id: "toolu_7", name: "calc", args: { expr: "3" } }] },
              { role: "tool", content: "9", toolCallId: "toolu_7" },
            ],
            { model: "m" },
          ),
        );
        const msgs = stub.seen[0].body.messages;
        assert.deepEqual(msgs[0], {
          role: "assistant",
          content: [
            { type: "text", text: "let me calc" },
            { type: "tool_use", id: "toolu_7", name: "calc", input: { expr: "3" } },
          ],
        });
        assert.deepEqual(msgs[1], {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "toolu_7", content: "9" }],
        });
      } finally {
        (globalThis as any).fetch = realFetch;
      }
    } finally {
      await stub.close();
    }
  });

  it("retries once on 429 then succeeds", async () => {
    const stub = await startStub((seen, _req, res) => {
      if (seen.length === 1) {
        res.writeHead(429, { "content-type": "application/json" });
        res.end("{}");
      } else {
        sse(res, anthropicFrames);
      }
    });
    try {
      const p = new AnthropicProvider({ apiKey: "k" });
      const realFetch = globalThis.fetch;
      (globalThis as any).fetch = (url: string, init: any) =>
        realFetch(url.replace("https://api.anthropic.com", stub.url), init);
      try {
        const events = await collect(p.chat([{ role: "user", content: "hi" }], { model: "m" }));
        assert.equal(stub.seen.length, 2);
        assert.ok(events.some((e) => e.type === "text" && (e as any).delta === "hello"));
        assert.ok(events.some((e) => e.type === "done"));
      } finally {
        (globalThis as any).fetch = realFetch;
      }
    } finally {
      await stub.close();
    }
  });
});
