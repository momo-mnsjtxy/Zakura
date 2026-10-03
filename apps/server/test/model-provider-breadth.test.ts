import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ModelCapability, ModelUpstreamProtocol } from "@zakura/shared";
import {
  executeChat,
  executeChatStream,
  executeEmbed,
  executeEvaluation,
  executeImage,
  executeRerank,
  isAbortError,
  isRetryableModelError,
  registerBuiltinModelAdapters,
  UpstreamHttpError,
} from "../src/model-router/index.js";
import { setRouteHydrator } from "../src/model-router/oauth-hook.js";
import type { ResolvedRoute } from "../src/model-router/types.js";
import {
  setCursorLoginApi,
} from "../src/services/model-upstream-auth/providers/cursor.js";

registerBuiltinModelAdapters();

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  setRouteHydrator(undefined);
  setCursorLoginApi(null);
});

function route(
  protocol: ModelUpstreamProtocol,
  capability: ModelCapability,
  options: ResolvedRoute["options"] = {},
): ResolvedRoute {
  return {
    routeId: `${protocol}-${capability}`,
    routeSlug: `${protocol}-${capability}`,
    alias: `${protocol}-${capability}`,
    capability,
    model:
      protocol === "codex"
        ? "gpt-5.4"
        : protocol === "typesafe"
          ? "jev-latest"
          : `${protocol}-fake`,
    weight: 100,
    options,
    upstream: {
      id: `${protocol}-upstream`,
      protocol,
      config: {
        baseUrl: `https://${protocol}.invalid`,
        apiKey: "test-only",
      },
    },
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function sse(payloads: unknown[]): Response {
  return new Response(
    payloads
      .map((payload) =>
        `data: ${typeof payload === "string" ? payload : JSON.stringify(payload)}\n\n`,
      )
      .join(""),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

describe("provider capability breadth over deterministic fake transports", () => {
  it("covers OpenAI-compatible embedding, rerank, image, auth, and options", async () => {
    const requests: Array<{
      path: string;
      authorization: string | null;
      body: Record<string, unknown>;
    }> = [];
    globalThis.fetch = (async (input, init) => {
      const url = new URL(String(input));
      requests.push({
        path: url.pathname,
        authorization: new Headers(init?.headers).get("authorization"),
        body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      });
      if (url.pathname.endsWith("/embeddings")) {
        return json({
          model: "embed-fake",
          data: [
            { index: 1, embedding: [3, 4] },
            { index: 0, embedding: [1, 2] },
          ],
        });
      }
      if (url.pathname.endsWith("/reranks")) {
        return json({
          model: "rerank-fake",
          results: [{ index: 1, relevance_score: 0.9, document: { text: "b" } }],
        });
      }
      if (url.pathname.endsWith("/images/generations")) {
        return json({ model: "image-fake", data: [{ b64_json: "aW1hZ2U=" }] });
      }
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;

    const embedded = await executeEmbed(
      route("openai", "embedding", { dimensions: 2 }),
      ["a", "b"],
    );
    const reranked = await executeRerank(
      route("openai", "rerank", { topN: 1, instruct: "rank" }),
      "q",
      ["a", "b"],
    );
    const image = await executeImage(
      route("openai", "image", {
        size: "1024x1024",
        quality: "hd",
        responseFormat: "b64_json",
      }),
      "draw",
    );

    assert.deepEqual(embedded.vectors, [[1, 2], [3, 4]]);
    assert.equal(reranked.results[0]?.text, "b");
    assert.equal(image.images[0]?.b64Json, "aW1hZ2U=");
    assert.ok(requests.every((request) => request.authorization === "Bearer test-only"));
    assert.equal(requests[0]?.body.dimensions, 2);
    assert.equal(requests[1]?.body.top_n, 1);
    assert.equal(requests[2]?.body.response_format, "b64_json");
  });

  it("covers native Bailian embedding/rerank and classifies a 200 throttle envelope", async () => {
    let throttle = false;
    globalThis.fetch = (async (input, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-only");
      const url = String(input);
      if (throttle) {
        return json({ code: "Throttling.RateQuota", message: "request throttled" });
      }
      if (url.includes("/embeddings/")) {
        return json({
          output: {
            embeddings: [
              { text_index: 1, embedding: [0, 2] },
              { text_index: 0, embedding: [1, 0] },
            ],
          },
        });
      }
      return json({
        output: {
          results: [{ index: 0, relevance_score: 0.75, document: { text: "first" } }],
        },
      });
    }) as typeof fetch;

    assert.deepEqual(
      (await executeEmbed(route("bailian", "embedding"), ["a", "b"])).vectors,
      [[1, 0], [0, 2]],
    );
    assert.equal(
      (await executeRerank(route("bailian", "rerank"), "q", ["first"]))
        .results[0]?.score,
      0.75,
    );

    throttle = true;
    await assert.rejects(
      executeEmbed(route("bailian", "embedding"), ["a"]),
      (error: unknown) => {
        assert.ok(error instanceof UpstreamHttpError);
        assert.equal(error.status, 429);
        assert.equal(error.code, "Throttling.RateQuota");
        assert.equal(isRetryableModelError(error), true);
        return true;
      },
    );
  });

  it("rejects retryable HTTP-200 error envelopes across JSON chat adapters", async () => {
    const cases: Array<{
      protocol: "openai" | "anthropic" | "gemini";
      payload: unknown;
      status: number;
      code?: string;
      providerType?: string;
    }> = [
      {
        protocol: "openai",
        payload: { error: { code: "rate_limit_exceeded", message: "slow down" } },
        status: 429,
        code: "rate_limit_exceeded",
      },
      {
        protocol: "anthropic",
        payload: { error: { type: "overloaded_error", message: "busy" } },
        status: 503,
        providerType: "overloaded_error",
      },
      {
        protocol: "gemini",
        payload: { error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota" } },
        status: 429,
        code: "429",
        providerType: "RESOURCE_EXHAUSTED",
      },
    ];

    for (const testCase of cases) {
      globalThis.fetch = (async () => json(testCase.payload)) as typeof fetch;
      await assert.rejects(
        executeChat(
          route(testCase.protocol, "chat"),
          [{ role: "user", content: "go" }],
        ),
        (error: unknown) => {
          assert.ok(error instanceof UpstreamHttpError);
          assert.equal(error.status, testCase.status);
          assert.equal(error.code, testCase.code);
          assert.equal(error.providerType, testCase.providerType);
          assert.equal(isRetryableModelError(error), true);
          return true;
        },
      );
    }
  });

  it("covers Gemini media/reasoning/tools, embeddings, and images", async () => {
    const bodies: Record<string, Record<string, unknown>> = {};
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (url.includes(":generateContent")) {
        bodies.chat = body;
        return json({
          candidates: [{
            content: { parts: [
              { text: "done" },
              { functionCall: { name: "lookup", args: { q: "x" } } },
            ] },
          }],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 3, totalTokenCount: 5 },
        });
      }
      if (url.includes(":embedContent")) {
        const text = ((body.content as { parts: Array<{ text: string }> }).parts[0]?.text ?? "");
        return json({ embedding: { values: text === "a" ? [1, 0] : [0, 1] } });
      }
      if (url.includes(":predict")) {
        bodies.image = body;
        return json({ predictions: [{ bytesBase64Encoded: "Z2VtaW5p" }] });
      }
      throw new Error(`unexpected request ${url}`);
    }) as typeof fetch;

    const chatRoute = route("gemini", "chat", {
      reasoning: { effort: "high", includeThoughts: true, budgetTokens: 2048 },
    });
    chatRoute.meta = {
      source: "models.dev",
      providerId: "google",
      providerName: "Google",
      modelId: chatRoute.model,
      name: chatRoute.model,
      capabilities: ["chat"],
      modalities: { input: ["text", "image"], output: ["text"] },
    };
    const chat = await executeChat(
      chatRoute,
      [{
        role: "user",
        content: "inspect",
        parts: [
          { type: "text", text: "inspect" },
          { type: "image_url", imageUrl: { url: "data:image/png;base64,UE5H" } },
        ],
      }],
      {
        tools: [{
          type: "function",
          function: { name: "lookup", parameters: { type: "object" } },
        }],
      },
    );
    assert.equal(chat.content, "done");
    assert.equal(chat.toolCalls?.[0]?.function.arguments, '{"q":"x"}');
    const contents = bodies.chat?.contents as Array<{ parts: Array<Record<string, unknown>> }>;
    assert.deepEqual(contents[0]?.parts[1], {
      inline_data: { mime_type: "image/png", data: "UE5H" },
    });
    assert.deepEqual(
      (bodies.chat?.generationConfig as { thinkingConfig?: unknown }).thinkingConfig,
      { thinkingBudget: 2048, includeThoughts: true },
    );
    assert.ok(Array.isArray(bodies.chat?.tools));

    assert.deepEqual(
      (await executeEmbed(route("gemini", "embedding"), ["a", "b"])).vectors,
      [[1, 0], [0, 1]],
    );
    assert.equal(
      (await executeImage(route("gemini", "image", { size: "16:9" }), "draw"))
        .images[0]?.b64Json,
      "Z2VtaW5p",
    );
    assert.deepEqual(
      (bodies.image?.parameters as Record<string, unknown>).aspectRatio,
      "16:9",
    );
  });

  it("preserves Gemini SSE error policy and caller cancellation", async () => {
    globalThis.fetch = (async (input) => {
      assert.match(String(input), /[?&]alt=sse(?:&|$)/);
      return sse([{ error: { code: 429, status: "RESOURCE_EXHAUSTED", message: "quota" } }]);
    }) as typeof fetch;
    await assert.rejects(
      executeChatStream(
        route("gemini", "chat"),
        [{ role: "user", content: "go" }],
        undefined,
        {},
      ),
      (error: unknown) => {
        assert.ok(error instanceof UpstreamHttpError);
        assert.equal(error.status, 429);
        assert.equal(error.code, "429");
        assert.equal(error.providerType, "RESOURCE_EXHAUSTED");
        return true;
      },
    );

    globalThis.fetch = (async (_input, init) => {
      const first = new TextEncoder().encode(
        'data: {"candidates":[{"content":{"parts":[{"text":"first"}]}}]}\n\n',
      );
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(first);
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
      }), { status: 200 });
    }) as typeof fetch;
    const controller = new AbortController();
    await assert.rejects(
      executeChatStream(
        route("gemini", "chat"),
        [{ role: "user", content: "go" }],
        undefined,
        { signal: controller.signal, onDelta: () => controller.abort() },
      ),
      (error: unknown) => isAbortError(error),
    );
  });

  it("covers Anthropic media/reasoning/tools and overloaded SSE errors", async () => {
    let capturedBody: Record<string, unknown> | undefined;
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = (async (_input, init) => {
      capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      capturedHeaders = new Headers(init?.headers);
      return json({
        id: "msg_fake",
        model: "claude-fake",
        content: [
          { type: "text", text: "answer" },
          { type: "tool_use", id: "tool_1", name: "search", input: { q: "x" } },
        ],
        stop_reason: "tool_use",
        usage: { input_tokens: 4, output_tokens: 2 },
      });
    }) as typeof fetch;
    const anthropic = route("anthropic", "chat", {
      reasoning: { effort: "high", budgetTokens: 1024 },
    });
    anthropic.meta = {
      source: "models.dev",
      providerId: "anthropic",
      providerName: "Anthropic",
      modelId: anthropic.model,
      name: anthropic.model,
      capabilities: ["chat"],
      modalities: { input: ["text", "image"], output: ["text"] },
    };
    const result = await executeChat(
      anthropic,
      [{
        role: "user",
        content: "inspect",
        parts: [{ type: "image_url", imageUrl: { url: "data:image/png;base64,UE5H" } }],
      }],
      {
        tools: [{ type: "function", function: { name: "search", parameters: { type: "object" } } }],
        toolChoice: "required",
      },
    );
    assert.equal(result.toolCalls?.[0]?.function.name, "search");
    assert.equal(capturedHeaders?.get("x-api-key"), "test-only");
    assert.deepEqual(capturedBody?.thinking, { type: "enabled", budget_tokens: 1024 });
    assert.deepEqual(capturedBody?.tool_choice, { type: "any" });
    const messages = capturedBody?.messages as Array<{ content: Array<Record<string, unknown>> }>;
    assert.deepEqual(messages[0]?.content[0], {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: "UE5H" },
    });

    globalThis.fetch = (async () =>
      sse([{ type: "error", error: { type: "overloaded_error", message: "busy" } }])) as typeof fetch;
    await assert.rejects(
      executeChatStream(
        anthropic,
        [{ role: "user", content: "go" }],
        undefined,
        {},
      ),
      (error: unknown) => {
        assert.ok(error instanceof UpstreamHttpError);
        assert.equal(error.status, 503);
        assert.equal(error.providerType, "overloaded_error");
        return true;
      },
    );
  });

  it("covers Codex Responses and Cursor subscription adapters without credentials", async () => {
    setRouteHydrator(async (value) => value);
    let codexBody: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer test-only");
      assert.equal(new Headers(init?.headers).get("originator"), "codex_cli_rs");
      codexBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return json({
        model: "gpt-5.4",
        output: [{
          type: "function_call",
          call_id: "call_1",
          name: "lookup",
          arguments: '{"q":"x"}',
        }],
      });
    }) as typeof fetch;
    const codex = await executeChat(
      route("codex", "chat"),
      [{ role: "user", content: "go" }],
      { tools: [{ type: "function", function: { name: "lookup", parameters: { type: "object" } } }] },
    );
    assert.equal(codex.toolCalls?.[0]?.id, "call_1");
    assert.equal(codexBody?.store, false);

    const prompts: string[] = [];
    setCursorLoginApi({
      login: async ({ onLoginUrl }) => {
        onLoginUrl("https://cursor.invalid/login");
        return { apiKey: "unused" };
      },
      listModels: async () => [],
      prompt: async ({ text, apiKey, model }) => {
        prompts.push(`${apiKey}:${model}:${text}`);
        return "cursor-answer";
      },
    });
    const cursor = await executeChat(
      route("cursor", "chat"),
      [
        { role: "system", content: "rules" },
        { role: "user", content: "question" },
      ],
    );
    assert.equal(cursor.content, "cursor-answer");
    assert.match(prompts[0] ?? "", /System:\nrules/);
    assert.match(prompts[0] ?? "", /User:\nquestion/);
  });

  it("covers TypeSafe evaluation and rejects empty success envelopes", async () => {
    let empty = false;
    let body: Record<string, unknown> | undefined;
    globalThis.fetch = (async (_input, init) => {
      body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (empty) return json({ model: "jev-latest" });
      return json({
        model: "jev-latest",
        answers: { safe: { type: "noul", noul: 0.98 } },
        usage: { input_tokens: 7, output_tokens: 2 },
      });
    }) as typeof fetch;
    const input = {
      state: { command: "echo ok" },
      questions: {
        safe: { type: "noul" as const, instructions: "Is it safe?" },
      },
    };
    const result = await executeEvaluation(route("typesafe", "evaluation"), input);
    assert.equal(result.answers.safe?.type, "noul");
    assert.equal(result.usage?.totalTokens, 9);
    assert.deepEqual(body?.state, input.state);

    empty = true;
    await assert.rejects(
      executeEvaluation(route("typesafe", "evaluation"), input),
      /missing answers/,
    );
  });
});
