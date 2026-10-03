import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { registerSaasRoutes } from "../../../packages/saas/src/server/routes.js";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import {
  AGENT_DEFAULTS_KEY,
  enableWebForUserAgents,
  getAgentWebDefaults,
  saveAgentWebDefaults,
} from "../src/services/agent-defaults.js";
import { signSession, verifySession } from "../src/services/auth.js";
import type { Orchestrator } from "../src/services/orchestrator.js";

type ApiApp = {
  request: (input: string, init?: RequestInit) => Promise<Response>;
};

describe("Agent web defaults lifecycle", () => {
  let root: string;
  let db: Db;
  let close: () => Promise<void>;
  let config: AppConfig;
  let orchestrator: Orchestrator;
  let app: ApiApp;
  let stopApp: () => void;
  let adminToken: string;
  let memberToken: string;
  let targetUserId: string;
  let rollbackUserId: string;
  let activeTenantId: string;
  let suspendedTenantId: string;
  let rollbackTenantId: string;
  let activeChangedAgentId: string;
  let activeUnchangedAgentId: string;
  let suspendedAgentId: string;
  let rollbackAgentIds: string[];
  const createCalls: string[] = [];

  before(async () => {
    process.env.REDIS_URL = "off";
    process.env.ZAKURA_EDITION = "saas";
    root = mkdtempSync(join(tmpdir(), "zakura-agent-defaults-"));
    const databaseUrl = `pglite:${join(root, "db")}`;
    await (await import("../src/db/migrate.js")).runMigrations(databaseUrl);
    const opened = await (
      await import("../src/db/client.js")
    ).createDb({ databaseUrl, dataDir: root });
    db = opened.db;
    close = opened.close;
    config = {
      dataDir: root,
      databaseUrl,
      secret: "agent-defaults-secret",
      publicBaseUrl: "http://localhost",
      internalBaseUrl: "http://localhost",
      multiTenant: true,
      edition: "saas",
    } as AppConfig;

    const {
      agents,
      componentInstances,
      newId,
      providerCatalog,
      spaces,
      tenantMemberships,
      tenants,
      users,
    } = await import("../src/db/schema.js");
    activeTenantId = newId();
    suspendedTenantId = newId();
    rollbackTenantId = newId();
    const adminUserId = newId();
    targetUserId = newId();
    rollbackUserId = newId();
    const activeSpaceId = newId();
    const suspendedSpaceId = newId();
    const rollbackSpaceId = newId();
    activeChangedAgentId = newId();
    activeUnchangedAgentId = newId();
    suspendedAgentId = newId();
    rollbackAgentIds = [newId(), newId()];
    const originalTime = new Date("2025-01-01T00:00:00.000Z");

    await db.insert(tenants).values([
      { id: activeTenantId, name: "Active", slug: "active" },
      {
        id: suspendedTenantId,
        name: "Suspended",
        slug: "suspended",
        suspendedAt: new Date("2025-02-01T00:00:00.000Z"),
      },
      { id: rollbackTenantId, name: "Rollback", slug: "rollback-defaults" },
    ]);
    await db.insert(users).values([
      { id: adminUserId, email: "admin@example.test", isPlatformAdmin: true },
      { id: targetUserId, email: "target@example.test" },
      { id: rollbackUserId, email: "rollback@example.test" },
    ]);
    await db.insert(tenantMemberships).values([
      {
        tenantId: activeTenantId,
        userId: adminUserId,
        role: "owner",
        status: "active",
      },
      {
        tenantId: activeTenantId,
        userId: targetUserId,
        role: "member",
        status: "active",
      },
      {
        tenantId: suspendedTenantId,
        userId: targetUserId,
        role: "member",
        status: "active",
      },
      {
        tenantId: rollbackTenantId,
        userId: rollbackUserId,
        role: "member",
        status: "active",
      },
    ]);
    await db.insert(spaces).values([
      {
        id: activeSpaceId,
        tenantId: activeTenantId,
        name: "Active",
        slug: "active",
      },
      {
        id: suspendedSpaceId,
        tenantId: suspendedTenantId,
        name: "Suspended",
        slug: "suspended",
      },
      {
        id: rollbackSpaceId,
        tenantId: rollbackTenantId,
        name: "Rollback",
        slug: "rollback",
      },
    ]);
    const alreadyEnabled = JSON.stringify({
      custom: "keep",
      providers: {
        webSearch: { enabled: true, defaultEngine: "duckduckgo" },
        webFetch: { enabled: true, defaultBackend: "native" },
      },
    });
    await db.insert(agents).values([
      {
        id: activeChangedAgentId,
        tenantId: activeTenantId,
        spaceId: activeSpaceId,
        name: "Changed",
        slug: "changed",
        configJson: JSON.stringify({
          custom: "keep",
          providers: {
            webSearch: { enabled: false, defaultEngine: "duckduckgo" },
            webFetch: { enabled: false, defaultBackend: "native" },
            mcp: { mode: "all", instanceIds: [] },
          },
        }),
        createdAt: originalTime,
        updatedAt: originalTime,
      },
      {
        id: activeUnchangedAgentId,
        tenantId: activeTenantId,
        spaceId: activeSpaceId,
        name: "Unchanged",
        slug: "unchanged",
        configJson: alreadyEnabled,
        createdAt: originalTime,
        updatedAt: originalTime,
      },
      {
        id: suspendedAgentId,
        tenantId: suspendedTenantId,
        spaceId: suspendedSpaceId,
        name: "Suspended",
        slug: "suspended",
        configJson: "{}",
        createdAt: originalTime,
        updatedAt: originalTime,
      },
      ...rollbackAgentIds.map((id, index) => ({
        id,
        tenantId: rollbackTenantId,
        spaceId: rollbackSpaceId,
        name: `Rollback ${index + 1}`,
        slug: `rollback-${index + 1}`,
        configJson: JSON.stringify({ marker: index + 1 }),
        createdAt: originalTime,
        updatedAt: originalTime,
      })),
    ]);
    const now = new Date();
    await db.insert(providerCatalog).values([
      {
        id: "web-search",
        name: "Web search",
        description: "",
        version: "1.0.0",
        category: "capability",
        capabilities: "[]",
        configSchema: "{}",
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "web-fetch",
        name: "Web fetch",
        description: "",
        version: "1.0.0",
        category: "capability",
        capabilities: "[]",
        configSchema: "{}",
        createdAt: now,
        updatedAt: now,
      },
    ]);

    type Barrier = {
      arrivals: number;
      release?: () => void;
      promise: Promise<void>;
    };
    const barriers = new Map<string, Barrier>();
    const waitForConcurrentCreate = async (key: string) => {
      let barrier = barriers.get(key);
      if (!barrier) {
        let release: (() => void) | undefined;
        const promise = new Promise<void>((resolve) => {
          release = resolve;
        });
        barrier = { arrivals: 0, release, promise };
        barriers.set(key, barrier);
      }
      barrier.arrivals += 1;
      if (barrier.arrivals === 2) barrier.release?.();
      await barrier.promise;
    };
    orchestrator = {
      createInstance: async (input: {
        tenantId: string;
        providerId: string;
        name: string;
        slug: string;
      }) => {
        const key = `${input.tenantId}:${input.providerId}`;
        createCalls.push(key);
        if (input.tenantId === activeTenantId)
          await waitForConcurrentCreate(key);
        const [row] = await db
          .insert(componentInstances)
          .values({
            id: newId(),
            tenantId: input.tenantId,
            providerId: input.providerId,
            name: input.name,
            slug: input.slug,
            configEnc: "{}",
            status: "stopped",
          })
          .returning();
        return row;
      },
      startInstance: async (tenantId: string, instanceId: string) => {
        const [row] = await db
          .update(componentInstances)
          .set({ status: "running", updatedAt: new Date() })
          .where(
            and(
              eq(componentInstances.tenantId, tenantId),
              eq(componentInstances.id, instanceId),
            ),
          )
          .returning();
        return row;
      },
    } as unknown as Orchestrator;

    // Rollback tests begin with admitted capabilities, isolating the Agent DB transaction.
    await db.insert(componentInstances).values([
      {
        id: newId(),
        tenantId: rollbackTenantId,
        providerId: "web-search",
        name: "Web search",
        slug: "web-search",
        configEnc: "{}",
        status: "running",
      },
      {
        id: newId(),
        tenantId: rollbackTenantId,
        providerId: "web-fetch",
        name: "Web fetch",
        slug: "web-fetch",
        configEnc: "{}",
        status: "running",
      },
    ]);

    const routeApp = new Hono<any>();
    routeApp.use("*", async (c, next) => {
      const raw =
        c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      const session = verifySession(config.secret, raw);
      if (!session) return c.json({ error: "Unauthorized" }, 401);
      c.set("session", session);
      await next();
    });
    registerSaasRoutes(
      routeApp as never,
      {
        db,
        config: {
          secret: config.secret,
          webPublicUrl: "http://localhost",
          multiTenant: true,
          edition: "saas",
        },
        agentDefaults: {
          get: () => getAgentWebDefaults(db),
          save: (value: Record<string, unknown>) =>
            saveAgentWebDefaults(db, value),
          enableForUser: (userId: string) =>
            enableWebForUserAgents(db, orchestrator, userId),
          syncManaged: async () => ({ tenants: 0 }),
        },
        schema,
      } as never,
    );
    app = routeApp as unknown as ApiApp;
    stopApp = () => undefined;
    adminToken = signSession(config.secret, {
      userId: adminUserId,
      tenantId: activeTenantId,
      email: "admin@example.test",
      role: "owner",
      isPlatformAdmin: true,
    });
    memberToken = signSession(config.secret, {
      userId: targetUserId,
      tenantId: activeTenantId,
      email: "target@example.test",
      role: "member",
    });
  });

  after(async () => {
    stopApp?.();
    await close?.();
    rmSync(root, { recursive: true, force: true });
  });

  const authHeaders = (token = adminToken) => ({
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
  });

  it("merges concurrent partial default saves without losing fields", async () => {
    const [searchSave, fetchSave] = await Promise.all([
      saveAgentWebDefaults(db, {
        webSearchEnabled: false,
        searchEngine: "searxng",
      }),
      saveAgentWebDefaults(db, {
        webFetchEnabled: false,
        fetchBackend: "jina-reader",
      }),
    ]);
    assert.equal(searchSave.webSearchEnabled, false);
    assert.equal(fetchSave.webFetchEnabled, false);

    const stored = await getAgentWebDefaults(db);
    assert.deepEqual(stored, {
      webSearchEnabled: false,
      webFetchEnabled: false,
      searchEngine: "searxng",
      fetchBackend: "jina-reader",
      autoManagedServices: [],
    });
    const { settings } = await import("../src/db/schema.js");
    const rows = await db
      .select()
      .from(settings)
      .where(
        and(
          eq(settings.ownerKey, "platform"),
          eq(settings.key, AGENT_DEFAULTS_KEY),
        ),
      );
    assert.equal(rows.length, 1);
    const repeated = await saveAgentWebDefaults(db, stored);
    assert.deepEqual(repeated, stored);
    assert.equal(
      (
        await db
          .select()
          .from(settings)
          .where(
            and(
              eq(settings.ownerKey, "platform"),
              eq(settings.key, AGENT_DEFAULTS_KEY),
            ),
          )
      ).length,
      1,
    );
  });

  it("recovers concurrent capability creation and atomically updates only changed active Agents", async () => {
    const { agents, componentInstances } = await import("../src/db/schema.js");
    const [unchangedBefore] = await db
      .select()
      .from(agents)
      .where(eq(agents.id, activeUnchangedAgentId));
    const results = await Promise.all([
      enableWebForUserAgents(db, orchestrator, targetUserId),
      enableWebForUserAgents(db, orchestrator, targetUserId),
    ]);
    assert.equal(
      results.reduce((sum, result) => sum + result.updated, 0),
      1,
    );
    assert.ok(results.every((result) => result.tenants === 1));

    const activeRows = await db
      .select()
      .from(agents)
      .where(eq(agents.tenantId, activeTenantId));
    for (const row of activeRows) {
      const parsed = JSON.parse(row.configJson) as Record<string, any>;
      assert.equal(parsed.providers.webSearch.enabled, true);
      assert.equal(parsed.providers.webFetch.enabled, true);
      assert.equal(parsed.custom, "keep");
    }
    const changed = activeRows.find((row) => row.id === activeChangedAgentId)!;
    assert.equal(
      (JSON.parse(changed.configJson) as any).providers.mcp.mode,
      "all",
    );
    const unchanged = activeRows.find(
      (row) => row.id === activeUnchangedAgentId,
    )!;
    assert.equal(
      unchanged.updatedAt.getTime(),
      unchangedBefore!.updatedAt.getTime(),
    );

    const suspended = await db.query.agents.findFirst({
      where: eq(agents.id, suspendedAgentId),
    });
    assert.equal(suspended!.configJson, "{}");
    assert.equal(
      (
        await db
          .select()
          .from(componentInstances)
          .where(eq(componentInstances.tenantId, suspendedTenantId))
      ).length,
      0,
    );
    assert.equal(
      (
        await db
          .select()
          .from(componentInstances)
          .where(eq(componentInstances.tenantId, activeTenantId))
      ).length,
      2,
    );
    assert.equal(
      createCalls.filter((key) => key.startsWith(`${activeTenantId}:`)).length,
      4,
    );

    assert.deepEqual(
      await enableWebForUserAgents(db, orchestrator, targetUserId),
      {
        updated: 0,
        tenants: 1,
      },
    );
  });

  it("rolls back every Agent in a tenant when a later update fails", async () => {
    const { agents } = await import("../src/db/schema.js");
    const before = await db
      .select()
      .from(agents)
      .where(eq(agents.tenantId, rollbackTenantId));
    let writes = 0;
    await assert.rejects(
      enableWebForUserAgents(db, orchestrator, rollbackUserId, {
        beforeAgentWrite: () => {
          writes += 1;
          if (writes === 2) throw new Error("injected defaults failure");
        },
      }),
      /injected defaults failure/,
    );
    const failed = await db
      .select()
      .from(agents)
      .where(eq(agents.tenantId, rollbackTenantId));
    assert.deepEqual(
      failed
        .map((row) => [row.id, row.configJson, row.updatedAt.getTime()])
        .sort(),
      before
        .map((row) => [row.id, row.configJson, row.updatedAt.getTime()])
        .sort(),
    );

    assert.deepEqual(
      await enableWebForUserAgents(db, orchestrator, rollbackUserId),
      {
        updated: rollbackAgentIds.length,
        tenants: 1,
      },
    );
  });

  it("preserves signed platform-admin route statuses and response bodies", async () => {
    const denied = await app.request("http://local/api/admin/agent-defaults", {
      headers: authHeaders(memberToken),
    });
    assert.equal(denied.status, 403, await denied.clone().text());

    const getResponse = await app.request(
      "http://local/api/admin/agent-defaults",
      {
        headers: authHeaders(),
      },
    );
    assert.equal(getResponse.status, 200, await getResponse.clone().text());
    assert.deepEqual(await getResponse.json(), await getAgentWebDefaults(db));

    const putResponse = await app.request(
      "http://local/api/admin/agent-defaults",
      {
        method: "PUT",
        headers: authHeaders(),
        body: JSON.stringify({
          webSearchEnabled: true,
          autoManagedServices: ["searxng"],
        }),
      },
    );
    assert.equal(putResponse.status, 200, await putResponse.clone().text());
    assert.deepEqual(await putResponse.json(), {
      webSearchEnabled: true,
      webFetchEnabled: false,
      searchEngine: "searxng",
      fetchBackend: "jina-reader",
      autoManagedServices: ["searxng"],
    });

    const applyResponse = await app.request(
      `http://local/api/admin/users/${targetUserId}/agent-defaults/apply`,
      { method: "POST", headers: authHeaders() },
    );
    assert.equal(applyResponse.status, 200, await applyResponse.clone().text());
    assert.deepEqual(await applyResponse.json(), { updated: 0, tenants: 1 });
  });
});
