import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, afterEach, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { generateApiKey } from "@zakura/core";
import { Hono } from "hono";
import type { Db } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { registerBuiltinModelAdapters } from "../src/model-router/index.js";
import { registerOpenAiGatewayRoutes } from "../src/api/openai-gateway-routes.js";
import { OpenAiGatewayService } from "../src/services/openai-gateway.js";
import { ModelRouterService } from "../src/services/model-router.js";
import { ModelCatalogService } from "../src/services/model-catalog.js";
import { ModelUpstreamsService } from "../src/services/model-upstreams.js";
import { UpstreamModelsService } from "../src/services/upstream-models.js";
import { ensureTestSpace } from "./helpers/spaces.js";

registerBuiltinModelAdapters();

describe("gateway key and catalog lifecycle", () => {
  let root = "";
  let db: Db;
  let close: () => Promise<void>;
  let rawKey = "";
  let keyId = "";
  let app: Hono;
  const tenantId = "gateway-lifecycle-a";
  const otherTenantId = "gateway-lifecycle-b";
  const agentId = "gateway-agent-a";
  const originalFetch = globalThis.fetch;
  const upstreamRequests: Array<Record<string, unknown>> = [];
  const sessionEvents: Array<{ type: string; payload: Record<string, unknown> }> = [];

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "zakura-gateway-key-lifecycle-"));
    const databaseUrl = `pglite:${join(root, "db")}`;
    await (await import("../src/db/migrate.js")).runMigrations(databaseUrl);
    const opened = await (await import("../src/db/client.js")).createDb({
      databaseUrl,
      dataDir: root,
    });
    db = opened.db;
    close = opened.close;
    await db.insert(schema.tenants).values([
      { id: tenantId, slug: tenantId, name: "Gateway A" },
      { id: otherTenantId, slug: otherTenantId, name: "Gateway B" },
    ]);
    const spaceId = await ensureTestSpace(db, tenantId);
    const otherSpaceId = await ensureTestSpace(db, otherTenantId);
    const agent = {
      id: agentId,
      tenantId,
      spaceId,
      name: "Gateway Agent",
      slug: "gateway-agent",
      description: "",
      enableMemory: false,
      configJson: JSON.stringify({
        cloud: {
          model: "catalog-a",
          autoTitle: false,
          gatewayModelMap: { "client-alias": "catalog-a" },
        },
      }),
    };
    await db.insert(schema.agents).values([
      agent,
      {
        id: "gateway-agent-b",
        tenantId: otherTenantId,
        spaceId: otherSpaceId,
        name: "Gateway Agent B",
        slug: "gateway-agent-b",
        description: "",
        enableMemory: false,
        configJson: "{}",
      },
    ]);
    await db.insert(schema.modelUpstreams).values([
      {
        id: "gateway-upstream-a",
        tenantId,
        name: "Provider A",
        slug: "provider-a",
        protocol: "openai",
        configJson: JSON.stringify({
          baseUrl: "https://provider.invalid/v1",
          apiKey: "provider-secret",
        }),
      },
      {
        id: "gateway-upstream-b",
        tenantId: otherTenantId,
        name: "Provider B",
        slug: "provider-b",
        protocol: "openai",
        configJson: JSON.stringify({
          baseUrl: "https://other-provider.invalid/v1",
          apiKey: "other-secret",
        }),
      },
    ]);
    await db.insert(schema.upstreamModels).values([
      {
        id: "gateway-model-a",
        tenantId,
        upstreamId: "gateway-upstream-a",
        nativeModel: "native-a",
        canonicalModel: "catalog-a",
        capability: "chat",
        isDefault: true,
        metaJson: JSON.stringify({
          source: "models.dev",
          providerId: "provider-a",
          providerName: "Provider A",
          modelId: "native-a",
          name: "Native A",
          capabilities: ["chat"],
          contextLimit: 64_000,
          outputLimit: 8_192,
          reasoning: true,
          toolCall: true,
          attachment: true,
          modalities: { input: ["text", "image"], output: ["text"] },
        }),
      },
      {
        id: "gateway-model-b",
        tenantId: otherTenantId,
        upstreamId: "gateway-upstream-b",
        nativeModel: "native-b",
        canonicalModel: "catalog-b-private",
        capability: "chat",
      },
    ]);

    const generated = generateApiKey();
    rawKey = generated.raw;
    keyId = "gateway-key-a";
    await db.insert(schema.apiKeys).values({
      id: keyId,
      tenantId,
      agentId,
      spaceId,
      name: "Gateway key",
      keyHash: generated.hash,
      keyPrefix: generated.prefix,
      scopes: '["gateway"]',
    });

    const sessions = new Map<string, Record<string, unknown>>();
    const events = new Map<string, Array<Record<string, unknown>>>();
    let sessionNumber = 0;
    const store = {
      async createSession(input: Record<string, unknown>) {
        const id = `gateway-session-${++sessionNumber}`;
        const session = {
          id,
          tenantId: input.tenantId,
          agentId: input.agentId,
          title: input.title,
          lastSeq: 0,
          originJson: JSON.stringify(input.origin ?? {}),
          updatedAt: new Date(),
        };
        sessions.set(id, session);
        events.set(id, []);
        return session;
      },
      async getSession(currentTenant: string, currentAgent: string, id: string) {
        const session = sessions.get(id);
        return session?.tenantId === currentTenant && session.agentId === currentAgent
          ? session
          : null;
      },
      async listGatewaySessions(currentTenant: string, currentAgent: string) {
        return [...sessions.values()].filter(
          (session) => session.tenantId === currentTenant && session.agentId === currentAgent,
        );
      },
      async listEvents(sessionId: string) {
        return events.get(sessionId) ?? [];
      },
      async appendEvent(input: { sessionId: string; type: string; payload: Record<string, unknown>; runId?: string }) {
        const list = events.get(input.sessionId) ?? [];
        const event = {
          id: `event-${list.length + 1}`,
          seq: list.length + 1,
          createdAt: new Date(),
          ...input,
        };
        list.push(event);
        events.set(input.sessionId, list);
        const session = sessions.get(input.sessionId);
        if (session) session.lastSeq = list.length;
        sessionEvents.push({ type: input.type, payload: input.payload });
        return event;
      },
      async warmSession() {},
      async updateSession(_tenant: string, _agent: string, sessionId: string, patch: Record<string, unknown>) {
        const session = sessions.get(sessionId);
        if (session) Object.assign(session, patch, { updatedAt: new Date() });
        return session ?? null;
      },
    };
    const modelRouter = new ModelRouterService(db);
    const gateway = new OpenAiGatewayService({
      agentService: {
        get: async (currentTenant: string, currentAgent: string) =>
          currentTenant === tenantId && currentAgent === agentId ? agent : null,
      } as never,
      modelRouter,
      store: store as never,
      gatewaySessionCache: {
        read: async () => null,
        write: async () => {},
      },
    });
    const upstreams = new ModelUpstreamsService(db);
    const catalog = new ModelCatalogService(db);
    const upstreamModels = new UpstreamModelsService(db, upstreams, catalog);
    app = new Hono();
    registerOpenAiGatewayRoutes(app as never, {
      db,
      agentService: {
        get: async (currentTenant: string, currentAgent: string) =>
          currentTenant === tenantId && currentAgent === agentId ? agent : null,
      } as never,
      gateway,
      upstreamModels,
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  after(async () => {
    await close?.();
    rmSync(root, { recursive: true, force: true });
  });

  it("authenticates, exposes tenant catalog metadata, invokes fake upstream, and revokes", async () => {
    const modelsResponse = await app.request("/v1/models", {
      headers: { Authorization: `Bearer ${rawKey}` },
    });
    assert.equal(modelsResponse.status, 200);
    const models = await modelsResponse.json() as {
      data: Array<{ id: string; metadata?: Record<string, unknown> }>;
    };
    assert.deepEqual(models.data.map((model) => model.id).sort(), ["catalog-a", "client-alias"]);
    assert.equal(models.data.some((model) => model.id === "catalog-b-private"), false);
    assert.deepEqual(
      models.data.find((model) => model.id === "catalog-a")?.metadata,
      {
        contextLimit: 64_000,
        outputLimit: 8_192,
        reasoning: true,
        toolCall: true,
        attachment: true,
      },
    );

    globalThis.fetch = (async (_input, init) => {
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer provider-secret");
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      upstreamRequests.push(body);
      return Response.json({
        id: "chatcmpl-upstream",
        model: "native-a",
        choices: [{
          index: 0,
          message: { role: "assistant", content: "gateway-ok" },
          finish_reason: "stop",
        }],
        usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
      });
    }) as typeof fetch;
    const chatResponse = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rawKey}`,
        "Content-Type": "application/json",
        "session-id": "client-session",
      },
      body: JSON.stringify({
        model: "client-alias",
        reasoning_effort: "high",
        messages: [{
          role: "user",
          content: [
            { type: "text", text: "inspect" },
            {
              type: "image_url",
              image_url: {
                url: "data:image/png;base64,UE5H",
                detail: "original",
              },
            },
          ],
        }],
      }),
    });
    assert.equal(chatResponse.status, 200);
    const completion = await chatResponse.json() as {
      model: string;
      choices: Array<{ message: { content: string } }>;
    };
    assert.equal(completion.model, "native-a");
    assert.equal(completion.choices[0]?.message.content, "gateway-ok");
    assert.equal(upstreamRequests.length, 1);
    assert.equal(upstreamRequests[0]?.model, "native-a");
    assert.equal(upstreamRequests[0]?.reasoning_effort, "high");
    const sentMessages = upstreamRequests[0]?.messages as Array<{ content: unknown }>;
    assert.deepEqual(sentMessages[0]?.content, [
      { type: "text", text: "inspect" },
      {
        type: "image_url",
        image_url: {
          url: "data:image/png;base64,UE5H",
          detail: "high",
        },
      },
    ]);
    assert.ok(sessionEvents.findIndex((event) => event.type === "run_start") <
      sessionEvents.findIndex((event) => event.type === "assistant_message"));

    globalThis.fetch = (async () =>
      Response.json(
        { error: { type: "server_error", code: "server_error", message: "busy" } },
        { status: 503 },
      )) as typeof fetch;
    const unavailable = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rawKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: "client-alias",
        messages: [{ role: "user", content: "retry later" }],
      }),
    });
    assert.equal(unavailable.status, 503);
    assert.equal(
      (await unavailable.json() as { error: { type: string } }).error.type,
      "server_error",
    );

    await db.delete(schema.apiKeys).where(eq(schema.apiKeys.id, keyId));
    const revoked = await app.request("/v1/models", {
      headers: { Authorization: `Bearer ${rawKey}` },
    });
    assert.equal(revoked.status, 401);
  });

  it("rejects expired keys and suspended tenants", async () => {
    const expired = generateApiKey();
    await db.insert(schema.apiKeys).values({
      id: "gateway-key-expired",
      tenantId,
      agentId,
      name: "Expired",
      keyHash: expired.hash,
      keyPrefix: expired.prefix,
      scopes: '["gateway"]',
      expiresAt: new Date(Date.now() - 1_000),
    });
    assert.equal((await app.request("/v1/models", {
      headers: { Authorization: `Bearer ${expired.raw}` },
    })).status, 401);

    const suspended = generateApiKey();
    await db.insert(schema.apiKeys).values({
      id: "gateway-key-suspended",
      tenantId,
      agentId,
      name: "Suspended",
      keyHash: suspended.hash,
      keyPrefix: suspended.prefix,
      scopes: '["gateway"]',
    });
    await db.update(schema.tenants).set({ suspendedAt: new Date() })
      .where(eq(schema.tenants.id, tenantId));
    const response = await app.request("/v1/models", {
      headers: { Authorization: `Bearer ${suspended.raw}` },
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json() as { error: { code?: string } }).error.code, "account_suspended");
    await db.update(schema.tenants).set({ suspendedAt: null })
      .where(eq(schema.tenants.id, tenantId));
  });
});
