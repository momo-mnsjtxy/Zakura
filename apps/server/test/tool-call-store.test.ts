import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { and, eq } from "drizzle-orm";
import { decryptJson, encryptJson, globalRegistry } from "@zakura/core";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import { signSession } from "../src/services/auth.js";
import { ToolCallStore } from "../src/services/tool-call-store.js";

type ApiApp = {
  request: (input: string, init?: RequestInit) => Promise<Response>;
};

const PROVIDER_ID = "test-tool-call-audit";

describe("tool call audit lifecycle", () => {
  let dataDir: string;
  let db: Db;
  let close: () => Promise<void>;
  let store: ToolCallStore;
  let app: ApiApp;
  let gateway: import("../src/services/mcp-gateway.js").McpGateway;
  let tenantA: string;
  let tenantB: string;
  let agentA: string;
  let agentB: string;
  let keyA: string;
  let keyB: string;
  let instanceB: string;
  let tokenA: string;
  let tokenB: string;
  let okTool: string;
  let failTool: string;

  before(async () => {
    process.env.REDIS_URL = "off";
    dataDir = mkdtempSync(join(tmpdir(), "zakura-tool-call-store-"));
    const databaseUrl = `pglite:${join(dataDir, "db")}`;
    await (await import("../src/db/migrate.js")).runMigrations(databaseUrl);
    const opened = await (
      await import("../src/db/client.js")
    ).createDb({ databaseUrl, dataDir });
    db = opened.db;
    close = opened.close;

    const {
      agents,
      apiKeys,
      componentInstances,
      newId,
      providerCatalog,
      spaces,
      tenantMemberships,
      tenants,
      users,
    } = await import("../src/db/schema.js");
    tenantA = newId();
    tenantB = newId();
    const userA = newId();
    const userB = newId();
    const spaceA = newId();
    const spaceB = newId();
    agentA = newId();
    agentB = newId();
    keyA = newId();
    keyB = newId();

    await db.insert(tenants).values([
      { id: tenantA, name: "Audit A", slug: "audit-a" },
      { id: tenantB, name: "Audit B", slug: "audit-b" },
    ]);
    await db.insert(users).values([
      { id: userA, email: "audit-a@example.test" },
      { id: userB, email: "audit-b@example.test" },
    ]);
    await db.insert(tenantMemberships).values([
      { tenantId: tenantA, userId: userA, role: "owner", status: "active" },
      { tenantId: tenantB, userId: userB, role: "owner", status: "active" },
    ]);
    await db.insert(spaces).values([
      { id: spaceA, tenantId: tenantA, name: "Space A", slug: "space-a" },
      { id: spaceB, tenantId: tenantB, name: "Space B", slug: "space-b" },
    ]);
    await db.insert(agents).values([
      {
        id: agentA,
        tenantId: tenantA,
        spaceId: spaceA,
        name: "Agent A",
        slug: "agent-a",
      },
      {
        id: agentB,
        tenantId: tenantB,
        spaceId: spaceB,
        name: "Agent B",
        slug: "agent-b",
      },
    ]);
    await db.insert(apiKeys).values([
      {
        id: keyA,
        tenantId: tenantA,
        agentId: agentA,
        spaceId: spaceA,
        name: "Key A",
        keyHash: "hash-a",
        keyPrefix: "zkr_a",
      },
      {
        id: keyB,
        tenantId: tenantB,
        agentId: agentB,
        spaceId: spaceB,
        name: "Key B",
        keyHash: "hash-b",
        keyPrefix: "zkr_b",
      },
    ]);

    const config = {
      dataDir,
      databaseUrl,
      secret: "tool-call-store-secret",
      publicBaseUrl: "http://localhost",
      internalBaseUrl: "http://localhost",
    } as AppConfig;
    tokenA = signSession(config.secret, {
      userId: userA,
      tenantId: tenantA,
      email: "audit-a@example.test",
      role: "owner",
    });
    tokenB = signSession(config.secret, {
      userId: userB,
      tenantId: tenantB,
      email: "audit-b@example.test",
      role: "owner",
    });

    globalRegistry.register(
      () =>
        ({
          id: PROVIDER_ID,
          name: "Tool audit fake",
          description: "",
          version: "1.0.0",
          category: "mcp",
          capabilities: ["tools"],
          configSchema: { type: "object", properties: {} },
          createRuntimeSpec: () => ({
            containers: [],
            endpointTemplate: "http://localhost",
          }),
          healthCheck: async () => ({ status: "healthy", message: "ok" }),
          listTools: async () => [
            {
              name: "audit_ok",
              description: "success",
              inputSchema: { type: "object" },
            },
            {
              name: "audit_fail",
              description: "failure",
              inputSchema: { type: "object" },
            },
          ],
          callTool: async (_handle: unknown, name: string, args: unknown) => {
            if (name === "audit_fail") throw new Error("fake provider failure");
            return {
              content: [{ type: "text", text: JSON.stringify({ name, args }) }],
            };
          },
        }) as never,
    );
    const now = new Date();
    await db.insert(providerCatalog).values({
      id: PROVIDER_ID,
      name: "Tool audit fake",
      description: "",
      version: "1.0.0",
      category: "mcp",
      capabilities: "[]",
      configSchema: "{}",
      createdAt: now,
      updatedAt: now,
    });
    const instanceA = newId();
    instanceB = newId();
    await db.insert(componentInstances).values([
      {
        id: instanceA,
        tenantId: tenantA,
        providerId: PROVIDER_ID,
        name: "Audit tools",
        slug: "audit-tools",
        status: "running",
        configEnc: encryptJson(config.secret, {}),
        endpointUrl: "https://example.test/mcp",
        healthStatus: "healthy",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: instanceB,
        tenantId: tenantB,
        providerId: PROVIDER_ID,
        name: "Other audit tools",
        slug: "other-audit-tools",
        status: "running",
        configEnc: encryptJson(config.secret, {}),
        endpointUrl: "https://other.example.test/mcp",
        healthStatus: "healthy",
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const loadInstance = (id: string) =>
      db.query.componentInstances.findFirst({
        where: and(
          eq(componentInstances.id, id),
          eq(componentInstances.tenantId, tenantA),
        ),
      });
    const orchestrator = {
      toHandle: async (_tenantId: string, id: string) => {
        const row = await loadInstance(id);
        if (!row) throw new Error("instance not found");
        return {
          id: row.id,
          tenantId: row.tenantId,
          providerId: row.providerId,
          name: row.name,
          slug: row.slug,
          config: decryptJson<Record<string, unknown>>(
            config.secret,
            row.configEnc,
          ),
          endpointUrl: row.endpointUrl,
          containers: {},
        };
      },
      ensureStarted: async () => undefined,
      startInstance: async () => undefined,
    };

    const { DockerRuntime } = await import("../src/runtime/docker.js");
    const { AgentService } = await import("../src/services/agents.js");
    const { McpGateway } = await import("../src/services/mcp-gateway.js");
    const { OauthService } = await import("../src/services/oauth.js");
    const { CloudAgentSessionStore } =
      await import("../src/services/cloud-agent-session.js");
    const { createApiApp } = await import("../src/api/routes.js");
    const agentService = new AgentService(db, {} as never, config);
    store = new ToolCallStore(db);
    gateway = new McpGateway(db, orchestrator as never, new DockerRuntime());
    gateway.setToolCallStore(store);
    await gateway.warmRunningInstanceTools({ tenantId: tenantA });
    const tools = await gateway.listToolsForTenant(tenantA);
    const okResolved = tools.find((tool) => tool.localName === "audit_ok");
    const failResolved = tools.find((tool) => tool.localName === "audit_fail");
    assert.ok(okResolved, `missing audit_ok from ${JSON.stringify(tools)}`);
    assert.ok(failResolved, `missing audit_fail from ${JSON.stringify(tools)}`);
    okTool = okResolved.qualifiedName;
    failTool = failResolved.qualifiedName;
    app = (await createApiApp({
      db,
      config,
      agentService,
      orchestrator: orchestrator as never,
      gateway,
      runtime: {} as never,
      memoryStore: {} as never,
      memoryProviders: {} as never,
      toolCallStore: store,
      oauth: new OauthService(db, config),
      cloudSessionStore: new CloudAgentSessionStore(db),
    })) as unknown as ApiApp;
  });

  after(async () => {
    await store?.flush();
    await close?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const get = (path: string, token = tokenA) =>
    app.request(`http://local${path}`, {
      headers: { authorization: `Bearer ${token}` },
    });

  it("records fake-provider success and failure exactly once and serves authenticated routes", async () => {
    const success = await gateway.callTool(
      tenantA,
      okTool,
      { request: "ok" },
      { agentId: agentA, apiKeyId: keyA },
    );
    assert.equal(success.isError, undefined);
    const failure = await gateway.callTool(
      tenantA,
      failTool,
      { request: "fail" },
      { agentId: agentA, apiKeyId: keyA },
    );
    assert.equal(failure.isError, true);
    await store.flush();

    const response = await get("/api/tool-calls?limit=20");
    assert.equal(response.status, 200, await response.clone().text());
    const listed = (await response.json()) as {
      total: number;
      items: Array<{
        id: string;
        qualifiedName: string;
        argsJson: string;
        resultJson: string;
        isError: boolean;
        agentName: string | null;
        apiKeyName: string | null;
      }>;
    };
    assert.equal(listed.total, 2);
    assert.equal(
      new Set(listed.items.map((item) => item.qualifiedName)).size,
      2,
    );
    assert.equal(listed.items.filter((item) => item.isError).length, 1);
    assert.ok(listed.items.every((item) => item.agentName === "Agent A"));
    assert.ok(listed.items.every((item) => item.apiKeyName === "Key A"));
    for (const item of listed.items) {
      assert.doesNotThrow(() => JSON.parse(item.argsJson));
      assert.doesNotThrow(() => JSON.parse(item.resultJson));
    }

    const statsResponse = await get("/api/tool-calls/stats");
    assert.equal(statsResponse.status, 200, await statsResponse.clone().text());
    const stats = (await statsResponse.json()) as {
      total: number;
      errors: number;
      last24h: number;
    };
    assert.equal(stats.total, 2);
    assert.equal(stats.errors, 1);
    assert.equal(stats.last24h, 2);

    const detail = await get(`/api/tool-calls/${listed.items[0]!.id}`);
    assert.equal(detail.status, 200, await detail.clone().text());
    assert.equal(
      ((await detail.json()) as { id: string }).id,
      listed.items[0]!.id,
    );
  });

  it("drops cross-tenant attribution and never exposes another tenant's log", async () => {
    await store.record({
      tenantId: tenantA,
      agentId: agentB,
      apiKeyId: keyB,
      instanceId: instanceB,
      qualifiedName: "audit_cross_tenant",
      localName: "audit_cross_tenant",
      providerId: PROVIDER_ID,
      args: {},
      result: { content: [{ type: "text", text: "ok" }] },
      durationMs: 1,
    });
    await store.flush();

    const own = await store.list(tenantA, { q: "audit_cross_tenant" });
    assert.equal(own.total, 1);
    assert.equal(own.items[0]!.agentId, null);
    assert.equal(own.items[0]!.apiKeyId, null);
    assert.equal(own.items[0]!.instanceId, null);
    assert.equal(own.items[0]!.agentName, null);
    assert.equal(own.items[0]!.apiKeyName, null);

    const other = await get("/api/tool-calls", tokenB);
    assert.equal(other.status, 200, await other.clone().text());
    assert.deepEqual(await other.json(), { items: [], total: 0 });
    const hidden = await get(`/api/tool-calls/${own.items[0]!.id}`, tokenB);
    assert.equal(hidden.status, 404);
  });

  it("treats wildcard characters literally and bounds valid JSON payloads", async () => {
    const oversized = Object.fromEntries(
      Array.from({ length: 400 }, (_, index) => [
        `field_${index}`,
        "x".repeat(100),
      ]),
    );
    await Promise.all([
      store.record({
        tenantId: tenantA,
        qualifiedName: "literal_100%_tool",
        localName: "literal_100%_tool",
        providerId: "provider_100%",
        args: oversized,
        result: {
          content: [{ type: "text", text: JSON.stringify(oversized) }],
        },
        durationMs: Number.NaN,
      }),
      store.record({
        tenantId: tenantA,
        qualifiedName: "literalX100Ytool",
        localName: "literalX100Ytool",
        providerId: "providerX100Y",
        args: {},
        result: { content: [{ type: "text", text: "decoy" }] },
        durationMs: 2,
      }),
    ]);
    await store.flush();

    const literal = await store.list(tenantA, {
      q: "_100%",
      limit: Number.POSITIVE_INFINITY,
    });
    assert.equal(literal.total, 1);
    assert.equal(literal.items[0]!.qualifiedName, "literal_100%_tool");
    assert.equal(literal.items[0]!.durationMs, 0);
    assert.ok(literal.items[0]!.argsJson.length <= 24_000);
    assert.ok(literal.items[0]!.resultJson.length <= 24_000);
    assert.doesNotThrow(() => JSON.parse(literal.items[0]!.argsJson));
    assert.doesNotThrow(() => JSON.parse(literal.items[0]!.resultJson));
  });

  it("flushes queued writes and paginates equal timestamps deterministically", async () => {
    const writes = Array.from({ length: 12 }, (_, index) =>
      store.record({
        tenantId: tenantA,
        agentId: agentA,
        qualifiedName: `page_${String(index).padStart(2, "0")}`,
        localName: `page_${String(index).padStart(2, "0")}`,
        providerId: PROVIDER_ID,
        args: { index },
        result: { content: [{ type: "text", text: "ok" }] },
        durationMs: index,
      }),
    );
    await store.flush();
    await Promise.all(writes);

    const { toolCallLogs } = await import("../src/db/schema.js");
    const sameTimestamp = new Date("2026-01-02T03:04:05.000Z");
    await db
      .update(toolCallLogs)
      .set({ createdAt: sameTimestamp })
      .where(
        and(
          eq(toolCallLogs.tenantId, tenantA),
          eq(toolCallLogs.providerId, PROVIDER_ID),
        ),
      );

    const first = await store.list(tenantA, {
      q: "page_",
      limit: 5,
      offset: 0,
    });
    const second = await store.list(tenantA, {
      q: "page_",
      limit: 5,
      offset: 5,
    });
    const repeated = await store.list(tenantA, {
      q: "page_",
      limit: 5,
      offset: 0,
    });
    assert.equal(first.total, 12);
    assert.deepEqual(
      first.items.map((item) => item.id),
      repeated.items.map((item) => item.id),
    );
    assert.equal(
      new Set([...first.items, ...second.items].map((item) => item.id)).size,
      first.items.length + second.items.length,
    );
    assert.deepEqual(
      first.items.map((item) => item.id),
      [...first.items.map((item) => item.id)].sort().reverse(),
    );

    const stats = await store.stats(tenantA, agentA);
    const pageTools = stats.byTool.filter((item) =>
      item.qualifiedName.startsWith("page_"),
    );
    assert.deepEqual(
      pageTools.map((item) => item.qualifiedName),
      [...pageTools.map((item) => item.qualifiedName)].sort(),
    );
  });
});
