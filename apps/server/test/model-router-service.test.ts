import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { registerBuiltinModelAdapters } from "../src/model-router/index.js";
import type { ResolvedRoute } from "../src/model-router/types.js";
import {
  ChatStreamPartialError,
  ModelRouterService,
} from "../src/services/model-router.js";

registerBuiltinModelAdapters();

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function fakeRoute(name: string): ResolvedRoute {
  return {
    routeId: `${name}-id`,
    routeSlug: name,
    alias: "logical-model",
    capability: "chat",
    model: "fake-model",
    weight: 100,
    options: {},
    upstream: {
      id: `${name}-upstream`,
      protocol: "openai",
      config: { baseUrl: `https://${name}.invalid`, apiKey: "test-only" },
    },
  };
}

function serviceFor(routes: ResolvedRoute[]): ModelRouterService {
  const resolver = {
    async resolveChain() {
      return routes;
    },
    invalidateTenant() {},
  };
  return new ModelRouterService({} as never, resolver);
}

function successfulStream(text: string): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          encoder.encode(
            `data: ${JSON.stringify({
              model: "fake-model",
              choices: [{ delta: { content: text }, finish_reason: "stop" }],
            })}\n\ndata: [DONE]\n\n`,
          ),
        );
        controller.close();
      },
    }),
    { status: 200 },
  );
}

describe("ModelRouterService route lifecycle", () => {
  it("retries one transient provider before failing over with route identity", async () => {
    const requests: string[] = [];
    globalThis.fetch = (async (input) => {
      const url = String(input);
      requests.push(url);
      if (url.includes("first.invalid")) {
        return new Response(JSON.stringify({ error: { message: "busy" } }), {
          status: 503,
        });
      }
      return successfulStream("from-second");
    }) as typeof fetch;

    const result = await serviceFor([
      fakeRoute("first"),
      fakeRoute("second"),
    ]).chatStream(
      "tenant",
      [{ role: "user", content: "hello" }],
      { capability: "chat" },
      undefined,
      {},
    );

    assert.equal(result.content, "from-second");
    assert.equal(result.routeId, "second-id");
    assert.equal(result.routeSlug, "second");
    assert.equal(result.upstreamId, "second-upstream");
    assert.deepEqual(
      requests.map((url) => new URL(url).hostname),
      ["first.invalid", "first.invalid", "second.invalid"],
    );
  });

  it("does not retry or fail over after a visible provider delta", async () => {
    const requests: string[] = [];
    const firstChunk = new TextEncoder().encode(
      'data: {"choices":[{"delta":{"content":"visible"}}]}\n\n',
    );
    globalThis.fetch = (async (input) => {
      requests.push(String(input));
      let read = false;
      return new Response(
        new ReadableStream<Uint8Array>({
          pull(controller) {
            if (!read) {
              read = true;
              controller.enqueue(firstChunk);
            } else {
              controller.error(new TypeError("terminated"));
            }
          },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    let visible = "";
    await assert.rejects(
      serviceFor([fakeRoute("first"), fakeRoute("second")]).chatStream(
        "tenant",
        [{ role: "user", content: "hello" }],
        { capability: "chat" },
        undefined,
        { onDelta: (delta) => (visible += delta) },
      ),
      (error: unknown) => {
        assert.ok(error instanceof ChatStreamPartialError);
        assert.equal(error.retryable, true);
        assert.equal(error.emitted, true);
        return true;
      },
    );
    assert.equal(visible, "visible");
    assert.deepEqual(
      requests.map((url) => new URL(url).hostname),
      ["first.invalid"],
    );
  });
});
