import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ModelChatMessage, ModelToolDefinition } from "@zakura/shared";
import { registerBuiltinModelAdapters } from "../src/model-router/index.js";
import { setRouteHydrator } from "../src/model-router/oauth-hook.js";
import type { ResolvedRoute } from "../src/model-router/types.js";
import { runAgentLoop } from "../src/services/cloud-agent/loop.js";
import { ModelRouterService } from "../src/services/model-router.js";

registerBuiltinModelAdapters();

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  setRouteHydrator(undefined);
});

type EventInput = {
  sessionId: string;
  type: string;
  runId?: string | null;
  payload: Record<string, unknown>;
};

function storeHarness() {
  const events: EventInput[] = [];
  const finishes: string[] = [];
  return {
    events,
    finishes,
    store: {
      async appendEvent(event: EventInput) {
        events.push(event);
        return { ...event, id: `e-${events.length}`, seq: events.length, createdAt: "" };
      },
      async isCancelRequested() { return false; },
      onRunCancel() { return () => {}; },
      async finishRun(_sessionId: string, _runId: string, status: string) { finishes.push(status); },
      async drainSteerQueued() { return []; },
    },
  };
}

const definitions: ModelToolDefinition[] = [{
  type: "function",
  function: {
    name: "lookup",
    description: "Look up one value",
    parameters: {
      type: "object",
      required: ["q"],
      properties: { q: { type: "string" } },
    },
  },
}];

function route(protocol: "anthropic" | "gemini" | "codex"): ResolvedRoute {
  return {
    routeId: `${protocol}-route`,
    routeSlug: `${protocol}-route`,
    alias: protocol,
    capability: "chat",
    model: protocol === "codex" ? "gpt-5.4" : protocol === "gemini" ? "gemini-2.5-pro" : "claude-fake",
    weight: 100,
    options: {},
    upstream: {
      id: `${protocol}-upstream`,
      protocol,
      config: { baseUrl: `https://${protocol}.invalid`, apiKey: "test-only" },
    },
  };
}

function routerFor(resolved: ResolvedRoute): ModelRouterService {
  return new ModelRouterService({} as never, {
    resolveChain: async () => [resolved],
    invalidateTenant() {},
  });
}

function sse(payloads: unknown[]): Response {
  return new Response(
    payloads.map((payload) =>
      `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`
    ).join(""),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

function providerResponse(protocol: "anthropic" | "gemini" | "codex", requestIndex: number): Response {
  if (protocol === "anthropic") {
    return requestIndex === 0
      ? sse([
          { type: "message_start", message: { model: "claude-fake" } },
          { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: "call-anthropic", name: "lookup" } },
          { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: '{"q":"x"}' } },
          { type: "message_delta", delta: { stop_reason: "tool_use" } },
          { type: "message_stop" },
          "[DONE]",
        ])
      : sse([
          { type: "message_start", message: { model: "claude-fake" } },
          { type: "content_block_start", index: 0, content_block: { type: "text" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
          { type: "message_delta", delta: { stop_reason: "end_turn" } },
          { type: "message_stop" },
          "[DONE]",
        ]);
  }
  if (protocol === "gemini") {
    return requestIndex === 0
      ? sse([{
          candidates: [{
            content: { parts: [{ functionCall: { name: "lookup", args: { q: "x" } } }] },
            finishReason: "STOP",
          }],
        }])
      : sse([{
          candidates: [{ content: { parts: [{ text: "done" }] }, finishReason: "STOP" }],
        }]);
  }
  return requestIndex === 0
    ? sse([
        {
          type: "response.output_item.added",
          output_index: 0,
          item: { type: "function_call", id: "fc-codex", call_id: "call-codex", name: "lookup", arguments: "" },
        },
        { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc-codex", delta: '{"q":"x"}' },
        { type: "response.completed", response: { id: "response-codex", status: "completed" } },
        "[DONE]",
      ])
    : sse([
        { type: "response.output_text.delta", delta: "done" },
        { type: "response.completed", response: { id: "response-codex-2", status: "completed" } },
        "[DONE]",
      ]);
}

describe("cloud loop provider-native tool continuation", () => {
  for (const protocol of ["anthropic", "gemini", "codex"] as const) {
    it(`${protocol} executes once and sends its native tool-result continuation`, async () => {
      if (protocol === "codex") setRouteHydrator(async (value) => value);
      const requests: Array<Record<string, unknown>> = [];
      globalThis.fetch = (async (_input, init) => {
        requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return providerResponse(protocol, requests.length - 1);
      }) as typeof fetch;
      const h = storeHarness();
      let toolCalls = 0;
      const result = await runAgentLoop(
        {
          store: h.store as never,
          modelRouter: routerFor(route(protocol)),
          gateway: {
            async callTool(_tenantId: string, qualifiedName: string, args: Record<string, unknown>) {
              toolCalls += 1;
              assert.equal(qualifiedName, "qualified.lookup");
              assert.deepEqual(args, { q: "x" });
              return { content: [{ type: "text", text: '{"answer":42}' }] };
            },
          } as never,
        },
        {
          tenantId: "tenant",
          agent: { id: "agent", tenantId: "tenant", name: "Agent" } as never,
          cloud: {},
          sessionId: "session",
          runId: "run",
          messages: [{ role: "user", content: "lookup" }] as ModelChatMessage[],
          definitions,
          nameMap: new Map([["lookup", "qualified.lookup"]]),
          modelRetryBaseDelayMs: 0,
        },
      );

      assert.equal(result.status, "completed");
      assert.equal(toolCalls, 1);
      assert.equal(requests.length, 2);
      assert.equal(h.events.filter((event) => event.type === "tool_call_result").length, 1);
      assert.deepEqual(h.finishes, ["completed"]);
      const continuation = requests[1]!;
      if (protocol === "anthropic") {
        assert.match(JSON.stringify(continuation.messages), /"type":"tool_result"/);
        assert.match(JSON.stringify(continuation.messages), /call-anthropic/);
      } else if (protocol === "gemini") {
        assert.match(JSON.stringify(continuation.contents), /functionResponse/);
        assert.match(JSON.stringify(continuation.contents), /"name":"lookup"/);
      } else {
        const input = continuation.input as Array<Record<string, unknown>>;
        assert.ok(input.some((item) => item.type === "function_call_output" && item.call_id === "call-codex"));
      }
    });
  }

  it("rolls back reasoning-only Anthropic partial output before a new message id", async () => {
    let requests = 0;
    globalThis.fetch = (async () => {
      requests += 1;
      if (requests === 1) {
        const encoder = new TextEncoder();
        return new Response(new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode([
              'data: {"type":"message_start","message":{"model":"claude-fake"}}',
              'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking"}}',
              'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"partial thought"}}',
              "",
            ].join("\n\n")));
            setTimeout(() => controller.error(new TypeError("terminated")), 0);
          },
        }), { status: 200, headers: { "Content-Type": "text/event-stream" } });
      }
      return sse([
        { type: "message_start", message: { model: "claude-fake" } },
        { type: "content_block_start", index: 0, content_block: { type: "text" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "final answer" } },
        { type: "message_delta", delta: { stop_reason: "end_turn" } },
        { type: "message_stop" },
        "[DONE]",
      ]);
    }) as typeof fetch;
    const h = storeHarness();
    const result = await runAgentLoop(
      { store: h.store as never, modelRouter: routerFor(route("anthropic")), gateway: {} as never },
      {
        tenantId: "tenant",
        agent: { id: "agent", tenantId: "tenant", name: "Agent" } as never,
        cloud: {},
        sessionId: "session",
        runId: "run",
        messages: [{ role: "user", content: "think" }],
        definitions: [],
        nameMap: new Map(),
        modelRetryBaseDelayMs: 0,
      },
    );

    assert.equal(result.status, "completed");
    assert.equal(requests, 2);
    const reasoningIndex = h.events.findIndex((event) => event.type === "reasoning_delta");
    const rollbackIndex = h.events.findIndex((event) => event.type === "assistant_rollback");
    const finalIndex = h.events.findIndex(
      (event) => event.type === "assistant_delta" && event.payload.delta === "final answer",
    );
    assert.ok(reasoningIndex >= 0 && rollbackIndex > reasoningIndex && finalIndex > rollbackIndex);
    const reasoningId = h.events[reasoningIndex]!.payload.messageId;
    assert.equal(h.events[rollbackIndex]!.payload.messageId, reasoningId);
    assert.notEqual(h.events[finalIndex]!.payload.messageId, reasoningId);
    assert.deepEqual(h.finishes, ["completed"]);
  });
});
