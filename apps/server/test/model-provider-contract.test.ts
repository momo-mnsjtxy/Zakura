import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ModelChatMessage } from "@zakura/shared";
import {
  executeChatStream,
  isAbortError,
  registerBuiltinModelAdapters,
} from "../src/model-router/index.js";
import type { ResolvedRoute } from "../src/model-router/types.js";

registerBuiltinModelAdapters();

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function route(protocol: "openai" | "anthropic"): ResolvedRoute {
  return {
    routeId: `${protocol}-route`,
    routeSlug: `${protocol}-route`,
    alias: "primary",
    capability: "chat",
    model: protocol === "openai" ? "gpt-fake" : "claude-fake",
    weight: 100,
    options: {},
    upstream: {
      id: `${protocol}-upstream`,
      protocol,
      config: { baseUrl: `https://${protocol}.invalid`, apiKey: "test-only" },
    },
  };
}

function fragmentedResponse(payloads: unknown[]): Response {
  const encoded = new TextEncoder().encode(
    payloads
      .map((payload) =>
        `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\r\n\r\n`,
      )
      .join(""),
  );
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        // One-byte chunks exercise JSON lines and a multibyte UTF-8 character
        // crossing arbitrary transport boundaries.
        for (const byte of encoded) controller.enqueue(Uint8Array.of(byte));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

describe("model provider contracts over deterministic fake HTTP", () => {
  it("normalizes fragmented OpenAI text, reasoning, tools, usage, and tool history", async () => {
    let requestBody: Record<string, unknown> | null = null;
    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return fragmentedResponse([
        { model: "gpt-fake", choices: [{ delta: { content: "你" } }] },
        {
          choices: [
            {
              delta: {
                reasoning_content: "think",
                tool_calls: [
                  { index: 0, id: "call_new", function: { name: "look" } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                content: "好",
                tool_calls: [
                  { index: 0, function: { name: "up", arguments: "{\"q\":" } },
                ],
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                tool_calls: [{ index: 0, function: { arguments: "\"x\"}" } }],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
        {
          choices: [],
          usage: { prompt_tokens: 8, completion_tokens: 3, total_tokens: 11 },
        },
        "[DONE]",
      ]);
    }) as typeof fetch;

    const history: ModelChatMessage[] = [
      { role: "user", content: "before" },
      {
        role: "assistant",
        content: null,
        toolCalls: [
          {
            id: "call_old",
            type: "function",
            function: { name: "lookup", arguments: "{\"q\":\"old\"}" },
          },
        ],
      },
      { role: "tool", content: "old-result", toolCallId: "call_old" },
      { role: "user", content: "next" },
    ];
    const text: string[] = [];
    const reasoning: string[] = [];
    const result = await executeChatStream(route("openai"), history, undefined, {
      onDelta: (delta) => text.push(delta),
      onReasoningDelta: (delta) => reasoning.push(delta),
    });

    assert.deepEqual(text, ["你", "好"]);
    assert.deepEqual(reasoning, ["think"]);
    assert.equal(result.content, "你好");
    assert.equal(result.finishReason, "tool_calls");
    assert.deepEqual(result.toolCalls, [
      {
        id: "call_new",
        type: "function",
        function: { name: "lookup", arguments: "{\"q\":\"x\"}" },
      },
    ]);
    assert.deepEqual(result.usage, {
      promptTokens: 8,
      completionTokens: 3,
      totalTokens: 11,
    });
    const sent = requestBody!.messages as Array<Record<string, unknown>>;
    assert.deepEqual(sent.map((message) => message.role), [
      "user",
      "assistant",
      "tool",
      "user",
    ]);
    assert.equal(sent[2]!.tool_call_id, "call_old");
  });

  it("normalizes fragmented Anthropic thinking and tool_use events", async () => {
    globalThis.fetch = (async () =>
      fragmentedResponse([
        {
          type: "message_start",
          message: { model: "claude-fake", usage: { input_tokens: 5 } },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "plan" },
        },
        {
          type: "content_block_start",
          index: 1,
          content_block: { type: "text" },
        },
        {
          type: "content_block_delta",
          index: 1,
          delta: { type: "text_delta", text: "answer" },
        },
        {
          type: "content_block_start",
          index: 2,
          content_block: { type: "tool_use", id: "tool_1", name: "search" },
        },
        {
          type: "content_block_delta",
          index: 2,
          delta: { type: "input_json_delta", partial_json: "{\"q\":\"x\"}" },
        },
        {
          type: "message_delta",
          delta: { stop_reason: "tool_use" },
          usage: { output_tokens: 7 },
        },
        "[DONE]",
      ])) as typeof fetch;

    const text: string[] = [];
    const reasoning: string[] = [];
    const result = await executeChatStream(
      route("anthropic"),
      [{ role: "user", content: "go" }],
      undefined,
      {
        onDelta: (delta) => text.push(delta),
        onReasoningDelta: (delta) => reasoning.push(delta),
      },
    );

    assert.deepEqual(text, ["answer"]);
    assert.deepEqual(reasoning, ["plan"]);
    assert.equal(result.content, "answer");
    assert.equal(result.finishReason, "tool_calls");
    assert.equal(result.toolCalls?.[0]?.function.name, "search");
    assert.equal(result.toolCalls?.[0]?.function.arguments, "{\"q\":\"x\"}");
    assert.equal(result.usage?.totalTokens, 12);
  });

  it("propagates caller cancellation from a live provider stream", async () => {
    globalThis.fetch = (async (_input, init) => {
      const first = new TextEncoder().encode(
        'data: {"choices":[{"delta":{"content":"first"}}]}\n\n',
      );
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(first);
          init?.signal?.addEventListener("abort", () => {
            controller.error(init.signal?.reason);
          });
        },
      });
      return new Response(stream, { status: 200 });
    }) as typeof fetch;

    const controller = new AbortController();
    let visible = "";
    await assert.rejects(
      executeChatStream(
        route("openai"),
        [{ role: "user", content: "go" }],
        undefined,
        {
          signal: controller.signal,
          onDelta(delta) {
            visible += delta;
            controller.abort();
          },
        },
      ),
      (error: unknown) => {
        assert.equal(isAbortError(error), true);
        return true;
      },
    );
    assert.equal(visible, "first");
  });
});
