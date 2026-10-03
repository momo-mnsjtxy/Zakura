import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ModelChatMessage, ModelToolDefinition } from "@zakura/shared";
import { registerBuiltinModelAdapters } from "../src/model-router/index.js";
import type { ResolvedRoute } from "../src/model-router/types.js";
import { ModelRouterService } from "../src/services/model-router.js";
import { CloudAgentRuntime } from "../src/services/cloud-agent/runtime.js";
import { runAgentLoop } from "../src/services/cloud-agent/loop.js";

type EventInput = {
  sessionId: string;
  type: string;
  runId?: string | null;
  payload: Record<string, unknown>;
};

function harness(options?: {
  beforeAppend?: (event: EventInput) => Promise<void>;
}) {
  const events: EventInput[] = [];
  let cancelled = false;
  const cancelListeners = new Set<() => void>();
  const finishes: string[] = [];
  const store = {
    async appendEvent(event: EventInput) {
      await options?.beforeAppend?.(event);
      events.push(event);
      return { ...event, id: `e-${events.length}`, seq: events.length, createdAt: "" };
    },
    async isCancelRequested() {
      return cancelled;
    },
    onRunCancel(_runId: string, listener: () => void) {
      cancelListeners.add(listener);
      return () => cancelListeners.delete(listener);
    },
    async finishRun(_sessionId: string, _runId: string, status: string) {
      finishes.push(status);
    },
    async drainSteerQueued() {
      return [];
    },
  };
  return {
    store,
    events,
    finishes,
    cancel() {
      cancelled = true;
      for (const listener of cancelListeners) listener();
    },
  };
}

const agent = { id: "agent", tenantId: "tenant", name: "Agent" } as never;
const baseInput = {
  tenantId: "tenant",
  agent,
  cloud: {},
  sessionId: "session",
  runId: "run",
  messages: [{ role: "user", content: "hello" }] as ModelChatMessage[],
  definitions: [] as ModelToolDefinition[],
  nameMap: new Map<string, string>(),
};

function retryable(message: string): Error & { retryable: true } {
  return Object.assign(new Error(message), { retryable: true as const });
}

describe("cloud agent model/run recovery", () => {
  it("rolls back a visible partial answer before retrying with a new message", async () => {
    const h = harness();
    let calls = 0;
    const modelRouter = {
      async chatStream(
        _tenant: string,
        _messages: unknown,
        _query: unknown,
        _options: unknown,
        callbacks: { onDelta?: (text: string) => void },
      ) {
        calls += 1;
        if (calls === 1) {
          callbacks.onDelta?.("partial");
          throw retryable("terminated");
        }
        callbacks.onDelta?.("final");
        return { content: "final", model: "fake", routeSlug: "second", openai: {} };
      },
    };

    const result = await runAgentLoop(
      { store: h.store as never, modelRouter: modelRouter as never, gateway: {} as never },
      { ...baseInput, modelRetryBaseDelayMs: 0 },
    );

    assert.equal(result.status, "completed");
    assert.equal(calls, 2);
    const rollback = h.events.findIndex((event) => event.type === "assistant_rollback");
    const finalDelta = h.events.findIndex(
      (event) => event.type === "assistant_delta" && event.payload.delta === "final",
    );
    const terminal = h.events.findIndex((event) => event.type === "run_end");
    assert.ok(rollback >= 0);
    assert.ok(finalDelta > rollback);
    assert.ok(terminal > finalDelta);
    assert.deepEqual(h.finishes, ["completed"]);
  });

  it("cancels during outer backoff without another provider call or duplicate run_end", async () => {
    const h = harness();
    let calls = 0;
    const modelRouter = {
      async chatStream() {
        calls += 1;
        setTimeout(() => h.cancel(), 5);
        throw retryable("temporary provider outage");
      },
    };
    const started = Date.now();
    const result = await runAgentLoop(
      { store: h.store as never, modelRouter: modelRouter as never, gateway: {} as never },
      { ...baseInput, modelRetryBaseDelayMs: 10_000 },
    );

    assert.equal(result.status, "cancelled");
    assert.equal(calls, 1);
    assert.ok(Date.now() - started < 1_000, "cancel waited for the retry backoff");
    assert.equal(h.events.filter((event) => event.type === "run_end").length, 1);
    assert.equal(h.events.find((event) => event.type === "run_end")?.payload.status, "cancelled");
    assert.deepEqual(h.finishes, ["cancelled"]);
  });

  it("persists the cancelled current tool before remaining results and run_end", async () => {
    const order: string[] = [];
    const h = harness({
      async beforeAppend(event) {
        if (event.type === "tool_call_result") {
          await new Promise((resolve) => setTimeout(resolve, 10));
          order.push(`result:${String(event.payload.toolCallId)}`);
        }
        if (event.type === "run_end") order.push("run_end");
      },
    });
    const modelRouter = {
      async chatStream() {
        return {
          content: null,
          model: "fake",
          routeSlug: "fake",
          openai: {},
          toolCalls: [
            { id: "first", type: "function", function: { name: "slow", arguments: "{}" } },
            { id: "second", type: "function", function: { name: "later", arguments: "{}" } },
          ],
        };
      },
    };
    let toolCalls = 0;
    const gateway = {
      async callTool() {
        toolCalls += 1;
        setTimeout(() => h.cancel(), 5);
        return new Promise(() => undefined);
      },
    };

    const result = await runAgentLoop(
      { store: h.store as never, modelRouter: modelRouter as never, gateway: gateway as never },
      { ...baseInput, definitions: [{ type: "function", function: { name: "slow" } }] as never },
    );

    assert.equal(result.status, "cancelled");
    assert.equal(toolCalls, 1);
    assert.deepEqual(order, ["result:first", "result:second", "run_end"]);
  });
});

registerBuiltinModelAdapters();
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function route(host: string): ResolvedRoute {
  return {
    routeId: host,
    routeSlug: host,
    alias: "chat",
    capability: "chat",
    model: "fake",
    weight: 100,
    options: {},
    upstream: {
      id: `${host}-upstream`,
      protocol: "openai",
      config: { baseUrl: `https://${host}.invalid`, apiKey: "test" },
    },
  };
}

function sse(payloads: unknown[]): Response {
  return new Response(
    payloads.map((payload) => `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`).join(""),
    { status: 200, headers: { "content-type": "text/event-stream" } },
  );
}

describe("model behavior through the cloud loop", () => {
  it("executes a tool-only successful failover exactly once", async () => {
    const h = harness();
    let successfulRounds = 0;
    globalThis.fetch = (async (input) => {
      const host = new URL(String(input)).hostname;
      if (host === "first.invalid") return new Response("busy", { status: 503 });
      successfulRounds += 1;
      return successfulRounds === 1
        ? sse([
            { choices: [{ delta: { tool_calls: [{ index: 0, id: "call", function: { name: "work", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
            "[DONE]",
          ])
        : sse([{ choices: [{ delta: { content: "done" }, finish_reason: "stop" }] }, "[DONE]"]);
    }) as typeof fetch;
    const resolver = { async resolveChain() { return [route("first"), route("second")]; }, invalidateTenant() {} };
    const router = new ModelRouterService({} as never, resolver);
    let executions = 0;
    const gateway = { async callTool() { executions += 1; return { content: [{ type: "text", text: "ok" }] }; } };

    const result = await runAgentLoop(
      { store: h.store as never, modelRouter: router, gateway: gateway as never },
      {
        ...baseInput,
        definitions: [{ type: "function", function: { name: "work", parameters: { type: "object" } } }],
        nameMap: new Map([["work", "work"]]),
        modelRetryBaseDelayMs: 0,
      },
    );
    assert.equal(result.status, "completed");
    assert.equal(executions, 1);
    assert.equal(h.events.filter((event) => event.type === "tool_call_result").length, 1);
  });

  it("never executes a tool truncated by a length finish", async () => {
    const h = harness();
    globalThis.fetch = (async () =>
      sse([
        { choices: [{ delta: { tool_calls: [{ index: 0, id: "call", function: { name: "work", arguments: '{"path":' } }] }, finish_reason: "length" }] },
        "[DONE]",
      ])) as typeof fetch;
    const resolver = { async resolveChain() { return [route("only")]; }, invalidateTenant() {} };
    const router = new ModelRouterService({} as never, resolver);
    let executions = 0;

    await assert.rejects(
      runAgentLoop(
        { store: h.store as never, modelRouter: router, gateway: { async callTool() { executions += 1; } } as never },
        {
          ...baseInput,
          definitions: [{ type: "function", function: { name: "work", parameters: { type: "object" } } }],
          nameMap: new Map([["work", "work"]]),
          modelRetryBaseDelayMs: 0,
        },
      ),
      /截断|不完整/,
    );
    assert.equal(executions, 0);
    assert.equal(h.events.some((event) => event.type === "tool_call_start"), false);
  });

  it("records one run_error and one failed run_end when the route chain is exhausted", async () => {
    const h = harness();
    let nextId = 0;
    const store = {
      ...h.store,
      async createSession(input: Record<string, unknown>) {
        return { id: `session-${++nextId}`, title: String(input.title ?? "task"), ...input };
      },
      async createRun(sessionId: string) {
        return { id: `run-${++nextId}`, sessionId, status: "queued", cancelRequested: false };
      },
      async markRunStarted() {},
      async listQueued() { return []; },
      async takeNextQueued() { return null; },
      async enqueueQueued() { return []; },
      async publishQueueSnapshot() {},
    };
    const runtime = new CloudAgentRuntime({
      store: store as never,
      agentService: {} as never,
      gateway: { async listToolsForAgent() { return []; } } as never,
      modelRouter: {
        async resolveRoute() { return { meta: { contextLimit: 32_000 } }; },
        async chatStream() { throw new Error("all routes exhausted"); },
      } as never,
    });

    await assert.rejects(
      runtime.runSubagent(
        "tenant",
        { id: "agent", tenantId: "tenant", name: "Agent", configJson: "{}" } as never,
        { task: "fail deterministically" },
        {},
      ),
      /all routes exhausted/,
    );
    assert.equal(h.events.filter((event) => event.type === "run_error").length, 1);
    const failed = h.events.filter(
      (event) => event.type === "run_end" && event.payload.status === "failed",
    );
    assert.equal(failed.length, 1);
    assert.deepEqual(h.finishes, ["failed"]);
  });
});
