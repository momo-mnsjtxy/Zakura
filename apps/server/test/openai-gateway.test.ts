import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { parseCloudAgentSessionOrigin } from "@zakura/shared";
import type { Agent } from "../src/db/schema.js";
import type { AgentService } from "../src/services/agents.js";
import type { CloudAgentSessionStore } from "../src/services/cloud-agent-session.js";
import type { ModelRouterService } from "../src/services/model-router.js";
import {
  OpenAiGatewayService,
  extractClaudeCodeSessionId,
  resolveClientSessionKey,
  resolveGatewayModel,
  rewriteGatewayModel,
  scoreGatewayMessageMatch,
} from "../src/services/openai-gateway.js";
import { hasApiKeyScope } from "../src/services/auth.js";
import { registerOpenAiGatewayRoutes } from "../src/api/openai-gateway-routes.js";
import { ModelCallAbortedError } from "../src/model-router/index.js";

const clientTool = (name: string) => ({
  type: "function" as const,
  function: {
    name,
    description: `client ${name}`,
    parameters: { type: "object", properties: {} },
  },
});

describe("OpenAI gateway session origin", () => {
  it("preserves the gateway channel for the fork-only UI policy", () => {
    assert.equal(
      parseCloudAgentSessionOrigin({
        source: "api",
        channel: "openai-gateway",
      }).channel,
      "openai-gateway",
    );
  });
});

describe("OpenAI gateway model selection", () => {
  it("uses the client model before the Agent fallback", () => {
    assert.equal(resolveGatewayModel("client-model", "agent-model"), "client-model");
    assert.equal(resolveGatewayModel("", "agent-model"), "agent-model");
  });

  it("rewrites client model names via gatewayModelMap in O(1)", () => {
    const map = { "gpt-5.1-codex": "gpt-5.1", "o3-review": "gpt-4.1" };
    assert.equal(rewriteGatewayModel("gpt-5.1-codex", map), "gpt-5.1");
    assert.equal(rewriteGatewayModel("o3-review", map), "gpt-4.1");
    assert.equal(rewriteGatewayModel("gpt-4.1", map), "gpt-4.1");
    assert.equal(rewriteGatewayModel(undefined, map), undefined);
    assert.equal(rewriteGatewayModel("gpt-5.1-codex", undefined), "gpt-5.1-codex");
  });
});

describe("OpenAI gateway key scopes", () => {
  it("treats gateway as a single capability (no models/chat split)", () => {
    // hasApiKeyScope is the primitive; gateway auth accepts any gateway-* or *
    assert.equal(hasApiKeyScope({ scopes: '["gateway:chat"]' }, "gateway:chat"), true);
    assert.equal(hasApiKeyScope({ scopes: '["gateway:models"]' }, "gateway:models"), true);
    assert.equal(hasApiKeyScope({ scopes: '["gateway"]' }, "gateway"), true);
    assert.equal(hasApiKeyScope({ scopes: '["*"]' }, "gateway:chat"), true);
    assert.equal(hasApiKeyScope({ scopes: "invalid" }, "gateway:chat"), false);
  });
});

describe("OpenAI gateway session continuation", () => {
  it("reads Claude Code and Codex session headers without Zakura-specific fields", () => {
    assert.equal(
      resolveClientSessionKey(
        new Headers({ "x-claude-code-session-id": "claude-sess" }),
        {},
      ),
      "claude-sess",
    );
    assert.equal(
      resolveClientSessionKey(new Headers({ "session-id": "codex-sess" }), {}),
      "codex-sess",
    );
    assert.equal(
      extractClaudeCodeSessionId(
        "user_abc_account_456_session_f47ac10b-58cc-4372-a567-0e02b2c3d479",
      ),
      "f47ac10b-58cc-4372-a567-0e02b2c3d479",
    );
    assert.equal(
      extractClaudeCodeSessionId(
        JSON.stringify({ session_id: "json-session", device_id: "x" }),
      ),
      "json-session",
    );
    assert.equal(
      resolveClientSessionKey(new Headers(), {
        metadata: {
          user_id: "user_abc_account_456_session_from-body",
        },
      }),
      "from-body",
    );
  });

  it("reuses sessions by client session key from Codex-style headers", async () => {
    const agent = {
      id: "agent-1",
      tenantId: "tenant-1",
      name: "Test Agent",
      slug: "test-agent",
      configJson: JSON.stringify({ cloud: { enableTools: false } }),
      enableMemory: false,
    } as unknown as Agent;
    let created = 0;
    const service = new OpenAiGatewayService({
      agentService: { get: async () => agent } as unknown as AgentService,
      modelRouter: { resolveRoute: async () => null } as unknown as ModelRouterService,
      store: {
        getSession: async () => null,
        listGatewaySessions: async () => [
          {
            id: "zakura-session-1",
            updatedAt: new Date().toISOString(),
            originJson: JSON.stringify({
              source: "api",
              channel: "openai-gateway",
              clientSessionKey: "codex-sess",
            }),
          },
        ],
        listEvents: async () => [],
        createSession: async () => {
          created += 1;
          return { id: "new" };
        },
        appendEvent: async () => ({}),
        warmSession: async () => {},
        updateSession: async () => null,
      } as unknown as CloudAgentSessionStore,
      gatewaySessionCache: {
        // An unavailable optional cache must not block the durable lookup.
        read: async () => new Promise<string | null>(() => {}),
        write: async () => {},
      },
    });

    const startedAt = Date.now();
    const context = await service.prepare(
      "tenant-1",
      "agent-1",
      { messages: [{ role: "user", content: "hello" }] },
      { clientSessionKey: "codex-sess" },
    );
    assert.equal(context.sessionId, "zakura-session-1");
    assert.equal(created, 0);
    assert.ok(Date.now() - startedAt < 1_000, "optional cache lookup must be bounded");
  });

  it("merges by user-message fingerprint even when assistant text diverges", () => {
    // 续聊：客户端更长
    assert.ok(scoreGatewayMessageMatch(["问1", "问2"], ["问1", "问2", "问3"]) > 0);
    // 重试 / 只发最新一句：客户端更短或等长
    assert.ok(scoreGatewayMessageMatch(["问1"], ["问1"]) > 0);
    assert.ok(scoreGatewayMessageMatch(["问1", "问2"], ["问1"]) > 0);
    assert.equal(scoreGatewayMessageMatch(["问1"], ["别的"]), 0);
  });

  it("reuses the gateway session when client retries with the same user turn", async () => {
    const agent = {
      id: "agent-1",
      tenantId: "tenant-1",
      name: "Test Agent",
      slug: "test-agent",
      configJson: JSON.stringify({ cloud: { enableTools: false } }),
      enableMemory: false,
    } as unknown as Agent;
    let created = 0;
    const events: Array<{ type: string; runId: string | null; payload: Record<string, unknown> }> =
      [
        {
          type: "user_message",
          runId: "r1",
          payload: { messageId: "m1", content: "尝试在本地初始化一个vue项目，启动vue-ui" },
        },
        { type: "run_start", runId: "r1", payload: { runId: "r1", replyToMessageId: "m1" } },
        {
          type: "assistant_message",
          runId: "r1",
          payload: { messageId: "a1", content: "" },
        },
        { type: "run_end", runId: "r1", payload: { runId: "r1", status: "completed" } },
      ];
    const service = new OpenAiGatewayService({
      agentService: { get: async () => agent } as unknown as AgentService,
      modelRouter: { resolveRoute: async () => null } as unknown as ModelRouterService,
      store: {
        listGatewaySessions: async () => [
          {
            id: "session-existing",
            updatedAt: new Date().toISOString(),
            originJson: JSON.stringify({ source: "api", channel: "openai-gateway" }),
          },
        ],
        listEvents: async () => events,
        createSession: async () => {
          created += 1;
          return { id: "session-new" };
        },
        getSession: async () => null,
        appendEvent: async () => ({}),
        warmSession: async () => {},
        updateSession: async () => null,
      } as unknown as CloudAgentSessionStore,
    });

    // 客户端重试时往往只带最新 user，且不带回显的空 assistant
    const context = await service.prepare("tenant-1", "agent-1", {
      messages: [{ role: "user", content: "尝试在本地初始化一个vue项目，启动vue-ui" }],
    });
    assert.equal(context.sessionId, "session-existing");
    assert.equal(created, 0);
  });

  it("does not merge the same client session key across different API keys", async () => {
    const agent = {
      id: "agent-1",
      tenantId: "tenant-1",
      name: "Test Agent",
      slug: "test-agent",
      configJson: "{}",
      enableMemory: false,
    } as unknown as Agent;
    let created = 0;
    const stored = {
      id: "session-key-a",
      tenantId: "tenant-1",
      agentId: "agent-1",
      lastSeq: 1,
      updatedAt: new Date().toISOString(),
      originJson: JSON.stringify({
        source: "api",
        channel: "openai-gateway",
        clientSessionKey: "shared-session",
        apiKeyId: "key-a",
      }),
    };
    const service = new OpenAiGatewayService({
      agentService: { get: async () => agent } as unknown as AgentService,
      modelRouter: { resolveRoute: async () => null } as unknown as ModelRouterService,
      store: {
        getSession: async () => stored,
        listGatewaySessions: async () => [stored],
        listEvents: async () => [],
        createSession: async (input: Record<string, unknown>) => ({
          id: `new-${++created}`,
          tenantId: "tenant-1",
          agentId: "agent-1",
          lastSeq: 0,
          title: "OpenAI Gateway",
          ...input,
        }),
        appendEvent: async () => ({}),
        warmSession: async () => {},
        updateSession: async () => null,
      } as unknown as CloudAgentSessionStore,
      gatewaySessionCache: {
        read: async () => stored.id,
        write: async () => {},
      },
    });

    const context = await service.prepare(
      "tenant-1",
      "agent-1",
      { messages: [{ role: "user", content: "hello" }] },
      { clientSessionKey: "shared-session", apiKeyId: "key-b" },
    );
    await context.bookkeeping;
    assert.equal(context.sessionId, "new-1");
    assert.equal(created, 1);
  });
});

describe("OpenAI gateway thin proxy", () => {
  it("preserves image detail and maps reasoning_effort into route options", async () => {
    const agent = {
      id: "agent-1",
      tenantId: "tenant-1",
      name: "Test Agent",
      slug: "test-agent",
      configJson: "{}",
      enableMemory: false,
    } as unknown as Agent;
    const service = new OpenAiGatewayService({
      agentService: { get: async () => agent } as unknown as AgentService,
      modelRouter: { resolveRoute: async () => null } as unknown as ModelRouterService,
      store: {
        createSession: async () => ({ id: "session-1", tenantId: "tenant-1", agentId: "agent-1", lastSeq: 0, title: "OpenAI Gateway" }),
        getSession: async () => null,
        listEvents: async () => [],
        listGatewaySessions: async () => [],
        appendEvent: async () => ({}),
        warmSession: async () => {},
        updateSession: async () => null,
      } as unknown as CloudAgentSessionStore,
    });
    const context = await service.prepare("tenant-1", "agent-1", {
      messages: [{
        role: "user",
        content: [{
          type: "image_url",
          image_url: { url: "data:image/png;base64,UE5H", detail: "original" },
        }],
      }],
      reasoning_effort: "high",
    });
    await context.bookkeeping;
    assert.equal(context.messages[0]?.parts?.[0]?.type, "image_url");
    assert.equal(
      context.messages[0]?.parts?.[0]?.type === "image_url"
        ? context.messages[0].parts[0].imageUrl.detail
        : undefined,
      "original",
    );
    assert.deepEqual(context.invokeOptions.routeOptions?.reasoning, { effort: "high" });
    assert.equal(context.invokeOptions.extensions?.reasoning, undefined);
  });

  it("rejects partial tool arguments before invoking a model", async () => {
    const agent = {
      id: "agent-1", tenantId: "tenant-1", name: "Agent", slug: "agent",
      configJson: "{}", enableMemory: false,
    } as unknown as Agent;
    const service = new OpenAiGatewayService({
      agentService: { get: async () => agent } as unknown as AgentService,
      modelRouter: { resolveRoute: async () => null } as unknown as ModelRouterService,
      store: {} as CloudAgentSessionStore,
    });
    await assert.rejects(
      service.prepare("tenant-1", "agent-1", {
        messages: [{
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: { name: "lookup", arguments: '{"q":' },
          }],
        }],
      }),
      /不是完整 JSON 对象/,
    );
  });

  it("orders bookkeeping before deltas and rolls back partial failures", async () => {
    const events: string[] = [];
    const agent = {
      id: "agent-1", tenantId: "tenant-1", name: "Agent", slug: "agent",
      configJson: "{}", enableMemory: false,
    } as unknown as Agent;
    const service = new OpenAiGatewayService({
      agentService: { get: async () => agent } as unknown as AgentService,
      modelRouter: {
        resolveRoute: async () => null,
        chatStream: async (_tenant: string, _messages: unknown, _query: unknown, _options: unknown, callbacks: { onDelta?: (text: string) => void }) => {
          callbacks.onDelta?.("partial");
          throw Object.assign(new Error("terminated"), { retryable: true });
        },
      } as unknown as ModelRouterService,
      store: {
        createSession: async () => ({ id: "session-1", tenantId: "tenant-1", agentId: "agent-1", lastSeq: 0, title: "OpenAI Gateway" }),
        getSession: async () => null,
        listEvents: async () => [],
        listGatewaySessions: async () => [],
        warmSession: async () => {},
        updateSession: async () => null,
        appendEvent: async (event: { type: string }) => {
          if (event.type === "user_message") await new Promise((resolve) => setTimeout(resolve, 5));
          events.push(event.type);
          return {};
        },
      } as unknown as CloudAgentSessionStore,
    });
    const context = await service.prepare("tenant-1", "agent-1", {
      messages: [{ role: "user", content: "hello" }],
    });
    await assert.rejects(
      service.invoke("tenant-1", context, { onDelta: () => {} }),
      /terminated/,
    );
    assert.deepEqual(events, [
      "user_message",
      "run_start",
      "assistant_delta",
      "assistant_rollback",
      "run_error",
      "run_end",
    ]);
  });

  it("records request abort as cancelled without a run error", async () => {
    const events: Array<{ type: string; status?: unknown }> = [];
    const agent = {
      id: "agent-1", tenantId: "tenant-1", name: "Agent", slug: "agent",
      configJson: "{}", enableMemory: false,
    } as unknown as Agent;
    const service = new OpenAiGatewayService({
      agentService: { get: async () => agent } as unknown as AgentService,
      modelRouter: {
        resolveRoute: async () => null,
        chatStream: async (_tenant: string, _messages: unknown, _query: unknown, _options: unknown, callbacks: { signal?: AbortSignal }) =>
          new Promise((_resolve, reject) => {
            callbacks.signal?.addEventListener("abort", () => reject(new ModelCallAbortedError()), { once: true });
          }),
      } as unknown as ModelRouterService,
      store: {
        createSession: async () => ({ id: "session-1", tenantId: "tenant-1", agentId: "agent-1", lastSeq: 0, title: "OpenAI Gateway" }),
        getSession: async () => null,
        listEvents: async () => [],
        listGatewaySessions: async () => [],
        warmSession: async () => {},
        updateSession: async () => null,
        appendEvent: async (event: { type: string; payload?: Record<string, unknown> }) => {
          events.push({ type: event.type, status: event.payload?.status });
          return {};
        },
      } as unknown as CloudAgentSessionStore,
    });
    const context = await service.prepare("tenant-1", "agent-1", {
      messages: [{ role: "user", content: "hello" }],
    });
    const controller = new AbortController();
    const pending = service.invoke("tenant-1", context, { signal: controller.signal });
    controller.abort();
    await assert.rejects(pending, ModelCallAbortedError);
    assert.equal(events.some((event) => event.type === "run_error"), false);
    assert.equal(events.find((event) => event.type === "run_end")?.status, "cancelled");
  });

  it("normalizes OpenAI developer instructions for OpenAI-compatible ACP clients", async () => {
    let seenMessages: Array<{ role: string; content: string | null }> = [];
    const agent = {
      id: "agent-1",
      tenantId: "tenant-1",
      name: "Test Agent",
      slug: "test-agent",
      configJson: JSON.stringify({ cloud: { enableTools: false } }),
      enableMemory: false,
    } as unknown as Agent;
    const service = new OpenAiGatewayService({
      agentService: { get: async () => agent } as unknown as AgentService,
      modelRouter: { resolveRoute: async () => null } as unknown as ModelRouterService,
      store: {
        createSession: async () => ({ id: "session-1" }),
        getSession: async () => null,
        listEvents: async () => [],
        listGatewaySessions: async () => [],
        appendEvent: async () => ({}),
        warmSession: async () => {},
        updateSession: async () => null,
      } as unknown as CloudAgentSessionStore,
    });

    const context = await service.prepare("tenant-1", "agent-1", {
      messages: [
        { role: "developer", content: "Use the workspace tools." },
        { role: "user", content: "hello" },
      ],
    });
    seenMessages = context.messages;
    assert.deepEqual(
      seenMessages.map((message) => [message.role, message.content]),
      [
        ["system", "Use the workspace tools."],
        ["user", "hello"],
      ],
    );
  });

  it("passthrough client tools and messages without injecting Zakura system/tools", async () => {
    let seenTools: string[] = [];
    let seenMessages: Array<{ role: string }> = [];
    const agent = {
      id: "agent-1",
      tenantId: "tenant-1",
      name: "Test Agent",
      slug: "test-agent",
      configJson: JSON.stringify({ cloud: { systemPrompt: "custom" } }),
      enableMemory: false,
    } as unknown as Agent;
    const service = new OpenAiGatewayService({
      agentService: { get: async () => agent } as unknown as AgentService,
      modelRouter: {
        resolveRoute: async () => null,
        chat: async (
          _tenantId: string,
          messages: Array<{ role: string }>,
          _route: unknown,
          options: { tools?: Array<{ function: { name: string } }> },
        ) => {
          seenMessages = messages;
          seenTools = options.tools?.map((tool) => tool.function.name) ?? [];
          return {
            content: "ok",
            model: "client-model",
            openai: {
              id: "chatcmpl_test",
              object: "chat.completion",
              created: 0,
              model: "client-model",
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "ok" },
                  finish_reason: "stop",
                },
              ],
            },
          };
        },
      } as unknown as ModelRouterService,
      store: {
        createSession: async () => ({ id: "session-1" }),
        getSession: async () => null,
        listEvents: async () => [],
        listGatewaySessions: async () => [],
        appendEvent: async () => ({}),
        warmSession: async () => {},
        updateSession: async () => null,
      } as unknown as CloudAgentSessionStore,
    });

    const context = await service.prepare("tenant-1", "agent-1", {
      model: "client-model",
      messages: [{ role: "user", content: "hello" }],
      tools: [clientTool("local_tool")],
    });
    await service.invoke("tenant-1", context);

    assert.equal(context.model, "client-model");
    assert.deepEqual(
      context.messages.map((m) => m.role),
      ["user"],
    );
    assert.deepEqual(
      context.invokeOptions.tools?.map((t) => t.function.name),
      ["local_tool"],
    );
    assert.deepEqual(
      seenMessages.map((m) => m.role),
      ["user"],
    );
    assert.deepEqual(seenTools, ["local_tool"]);
  });

  it("returns tool_calls to the client instead of executing them server-side", async () => {
    let chatCount = 0;
    const agent = {
      id: "agent-1",
      tenantId: "tenant-1",
      name: "Test Agent",
      slug: "test-agent",
      configJson: JSON.stringify({}),
      enableMemory: false,
    } as unknown as Agent;
    const service = new OpenAiGatewayService({
      agentService: { get: async () => agent } as unknown as AgentService,
      modelRouter: {
        resolveRoute: async () => null,
        chat: async () => {
          chatCount += 1;
          return {
            content: "",
            model: "m",
            toolCalls: [
              {
                id: "call_1",
                type: "function",
                function: { name: "Bash", arguments: "{\"command\":\"ls\"}" },
              },
            ],
            openai: { id: "x", object: "chat.completion", created: 0, model: "m", choices: [] },
          };
        },
      } as unknown as ModelRouterService,
      store: {
        createSession: async () => ({ id: "session-1" }),
        getSession: async () => null,
        listEvents: async () => [],
        listGatewaySessions: async () => [],
        appendEvent: async () => ({}),
        warmSession: async () => {},
        updateSession: async () => null,
      } as unknown as CloudAgentSessionStore,
    });

    const context = await service.prepare("tenant-1", "agent-1", {
      messages: [{ role: "user", content: "列出文件" }],
      tools: [clientTool("Bash")],
    });
    const result = await service.invoke("tenant-1", context);

    assert.equal(chatCount, 1);
    assert.equal(result.toolCalls?.length, 1);
    assert.equal(result.toolCalls?.[0]?.function.name, "Bash");
  });
});

describe("OpenAI gateway authentication", () => {
  it("rejects requests without an API key", async () => {
    const app = new Hono();
    registerOpenAiGatewayRoutes(app as never, {
      db: {} as never,
      agentService: {} as AgentService,
      gateway: {} as OpenAiGatewayService,
    });
    const response = await app.request("/v1/models");
    assert.equal(response.status, 401);
  });
});

describe("OpenAI gateway responses bridge", () => {
  it("translates Responses input items into chat messages", async () => {
    const { translateResponsesRequest } = await import(
      "../src/services/openai-gateway-responses.js"
    );
    const translated = translateResponsesRequest({
      model: "gpt-5.6-sol",
      stream: true,
      instructions: "你是编码助手",
      input: [
        { type: "message", role: "user", content: "运行 echo" },
        {
          type: "function_call",
          call_id: "call_1",
          name: "shell",
          arguments: "{\"command\":\"echo\"}",
        },
        { type: "function_call_output", call_id: "call_1", output: "hi" },
        { type: "reasoning", summary: [] },
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "继续" },
            { type: "input_image", image_url: "data:image/png;base64,xxx" },
          ],
        },
      ],
      tools: [{ type: "function", name: "shell", description: "run", parameters: { type: "object" } }],
      tool_choice: "auto",
      reasoning: { effort: "high" },
      max_output_tokens: 4096,
    });
    const messages = translated.messages as Array<Record<string, unknown>>;
    assert.deepEqual(messages[0], { role: "system", content: "你是编码助手" });
    assert.deepEqual(messages[1], { role: "user", content: "运行 echo" });
    const assistantCall = messages[2] as {
      role: string;
      tool_calls: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
    assert.equal(assistantCall.role, "assistant");
    assert.equal(assistantCall.tool_calls[0].id, "call_1");
    const toolOutput = messages[3] as { role: string; tool_call_id: string; content: string };
    assert.equal(toolOutput.role, "tool");
    assert.equal(toolOutput.tool_call_id, "call_1");
    assert.equal(toolOutput.content, "hi");
    // reasoning 项无法在 chat 里表达，跳过；多段 content（文本+图片）保留结构。
    const mixed = messages[4] as { role: string; content: unknown };
    assert.equal(mixed.role, "user");
    assert.ok(Array.isArray(mixed.content));
    assert.equal(translated.reasoning_effort, "high");
    assert.equal(translated.max_tokens, 4096);
    const tools = translated.tools as Array<Record<string, unknown>>;
    assert.equal((tools[0].function as { name: string }).name, "shell");
  });

  it("preserves structured media in tool outputs and rejects partial calls", async () => {
    const { translateResponsesRequest } = await import(
      "../src/services/openai-gateway-responses.js"
    );
    const translated = translateResponsesRequest({
      input: [
        {
          type: "function_call",
          call_id: "call-media",
          name: "inspect",
          arguments: "{}",
        },
        {
          type: "function_call_output",
          call_id: "call-media",
          output: [
            { type: "input_text", text: "screenshot" },
            {
              type: "input_image",
              image_url: "data:image/png;base64,UE5H",
              detail: "original",
            },
          ],
        },
      ],
    });
    const tool = (translated.messages as Array<Record<string, unknown>>)[1]!;
    assert.equal(tool.role, "tool");
    assert.deepEqual(tool.content, [
      { type: "text", text: "screenshot" },
      {
        type: "image_url",
        image_url: {
          url: "data:image/png;base64,UE5H",
          detail: "original",
        },
      },
    ]);
    assert.throws(
      () => translateResponsesRequest({
        input: [{
          type: "function_call",
          call_id: "call-bad",
          name: "inspect",
          arguments: '{"path":',
        }],
      }),
      /不是完整 JSON 对象/,
    );
    assert.throws(
      () => translateResponsesRequest({
        input: [{ type: "function_call_output", output: "orphan" }],
      }),
      /缺少 call_id/,
    );
  });

  it("feeds translated Responses requests through gateway prepare", async () => {
    const agent = {
      id: "agent-1",
      tenantId: "tenant-1",
      name: "Test Agent",
      slug: "test-agent",
      configJson: JSON.stringify({ cloud: {} }),
      enableMemory: false,
    } as unknown as Agent;
    const service = new OpenAiGatewayService({
      agentService: { get: async () => agent } as unknown as AgentService,
      modelRouter: { resolveRoute: async () => null } as unknown as ModelRouterService,
      store: {
        createSession: async () => ({ id: "session-1" }),
        getSession: async () => null,
        listEvents: async () => [],
        listGatewaySessions: async () => [],
        appendEvent: async () => ({}),
        warmSession: async () => {},
        updateSession: async () => null,
      } as unknown as CloudAgentSessionStore,
    });
    const { translateResponsesRequest } = await import(
      "../src/services/openai-gateway-responses.js"
    );
    const translated = translateResponsesRequest({
      model: "gpt-5.6-sol",
      input: [
        { type: "message", role: "user", content: "hello" },
        { type: "function_call_output", call_id: "c1", output: "42" },
      ],
    });
    const context = await service.prepare("tenant-1", "agent-1", translated, {});
    assert.equal(context.model, "gpt-5.6-sol");
    assert.equal(context.messages.length, 2);
    assert.equal(context.messages[1].role, "tool");
  });

  it("stamps sequence numbers on Responses SSE events", async () => {
    const {
      createResponsesEventFactory,
      responsesEvent,
      responsesId,
      itemId,
    } = await import(
      "../src/services/openai-gateway-responses.js"
    );
    const a = responsesEvent("response.created", { response: { id: "r" } });
    const b = responsesEvent("response.completed");
    assert.equal(a.type, "response.created");
    assert.ok(typeof a.sequence_number === "number");
    assert.ok((b.sequence_number as number) > (a.sequence_number as number));
    assert.ok(responsesId().startsWith("resp_"));
    assert.ok(itemId("fc").startsWith("fc_"));
    const firstStream = createResponsesEventFactory();
    const secondStream = createResponsesEventFactory();
    assert.equal(firstStream("response.created").sequence_number, 1);
    assert.equal(firstStream("response.completed").sequence_number, 2);
    assert.equal(secondStream("response.created").sequence_number, 1);
  });
});
