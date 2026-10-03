import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, describe, it } from "node:test";
import { and, eq, sql } from "drizzle-orm";
import { ensureTestSpace } from "./helpers/spaces.js";

describe("memory provider persistence invariants", () => {
  let dataDir = "";
  let databaseUrl = "";
  let db: import("../src/db/client.js").Db;
  let close: () => Promise<void>;
  let tenantId = "";
  let agentId = "";
  const secret = "memory-provider-test-secret-32bytes";

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "zakura-memory-provider-"));
    databaseUrl = `pglite:${join(dataDir, "pglite")}`;
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(databaseUrl);
    const { createDb } = await import("../src/db/client.js");
    const opened = await createDb({ databaseUrl, dataDir });
    db = opened.db;
    close = opened.close;
    const { agents, newId, tenants } = await import("../src/db/schema.js");
    tenantId = newId();
    agentId = newId();
    const now = new Date();
    await db.insert(tenants).values({
      id: tenantId, slug: `memory-provider-${tenantId}`, name: "Memory Provider",
      isDefault: false, createdAt: now, updatedAt: now,
    });
    const spaceId = await ensureTestSpace(db, tenantId, { enableComputer: false });
    await db.insert(agents).values({
      id: agentId, tenantId, spaceId, name: "Memory Agent", slug: `memory-${agentId}`,
      description: "", status: "ready", enableFs: true, enableComputer: false,
      enableMemory: true, runtimeNodeId: null, workspaceStatus: "ready", configJson: "{}",
      createdAt: now, updatedAt: now,
    });
  });

  after(async () => {
    await close?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("discovers migration 0067 after 0066", () => {
    const journal = JSON.parse(readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    assert.deepEqual(journal.entries.find((entry) => entry.idx === 67), {
      idx: 67, version: "7", when: 1790380800000,
      tag: "0067_memory_invariants", breakpoints: true,
    });
    const migration = readFileSync(new URL("../drizzle/0067_memory_invariants.sql", import.meta.url), "utf8");
    assert.match(migration, /row_number\(\).*PARTITION BY tenant_id/s);
    assert.match(migration, /memory_providers_one_default/);
    assert.match(migration, /memory_edges_tenant_agent_pair_rel/);
  });

  it("encrypts provider secrets, redacts reads, and preserves KEEP_VALUE", async () => {
    const { MemoryProvidersService, MEMORY_SECRET_KEEP_VALUE } = await import("../src/services/memory-providers.js");
    const providers = new MemoryProvidersService(db, secret);
    const created = await providers.create(tenantId, {
      name: "Mem0", kind: "mem0",
      config: { baseUrl: "https://memory.invalid", apiKey: "top-secret" },
    });
    assert.equal(created.config.apiKey, MEMORY_SECRET_KEEP_VALUE);
    const { memoryProviders } = await import("../src/db/schema.js");
    const raw = await db.query.memoryProviders.findFirst({ where: eq(memoryProviders.id, created.id) });
    assert.ok(raw);
    assert.equal(raw.configJson.includes("top-secret"), false);
    assert.equal(typeof (JSON.parse(raw.configJson) as { apiKeyEnc?: unknown }).apiKeyEnc, "string");

    const updated = await providers.update(tenantId, created.id, {
      config: { baseUrl: "https://memory-2.invalid", apiKey: MEMORY_SECRET_KEEP_VALUE },
    });
    assert.equal(updated.config.apiKey, MEMORY_SECRET_KEEP_VALUE);
    const internal = await providers.getRow(tenantId, created.id);
    assert.equal((JSON.parse(internal!.configJson) as { apiKey: string }).apiKey, "top-secret");
  });

  it("keeps exactly one default under concurrent service instances", async () => {
    const { MemoryProvidersService } = await import("../src/services/memory-providers.js");
    const left = new MemoryProvidersService(db, secret);
    const right = new MemoryProvidersService(db, secret);
    await Promise.all(Array.from({ length: 8 }, (_, index) =>
      (index % 2 ? left : right).ensureDefault(tenantId)));
    const a = await left.create(tenantId, { name: "Traditional A", kind: "traditional" });
    const b = await right.create(tenantId, { name: "Traditional B", kind: "traditional" });
    await Promise.allSettled([
      left.update(tenantId, a.id, { isDefault: true }),
      right.update(tenantId, b.id, { isDefault: true }),
    ]);
    const { memoryProviders } = await import("../src/db/schema.js");
    const defaults = await db.select().from(memoryProviders).where(and(
      eq(memoryProviders.tenantId, tenantId), eq(memoryProviders.isDefault, true),
    ));
    assert.equal(defaults.length, 1);
  });

  it("creates one graph link under concurrent callers", async () => {
    const { MemoryStore } = await import("../src/services/memory-store.js");
    const { memoryEdges } = await import("../src/db/schema.js");
    const store = new MemoryStore(db);
    const from = await store.add(tenantId, agentId, { content: "from" });
    const to = await store.add(tenantId, agentId, { content: "to" });
    const links = await Promise.all(Array.from({ length: 12 }, () =>
      store.link(tenantId, agentId, from.id, to.id, " owner ")));
    assert.equal(new Set(links.map((link) => link.id)).size, 1);
    const rows = await db.select().from(memoryEdges).where(eq(memoryEdges.tenantId, tenantId));
    assert.equal(rows.length, 1);
  });

  it("purges tenant-owned external mem0 records before tenant deletion", async () => {
    const { MemoryProvidersService } = await import("../src/services/memory-providers.js");
    const { agents, newId, tenants } = await import("../src/db/schema.js");
    const cleanupTenant = newId();
    const cleanupAgent = newId();
    const now = new Date();
    await db.insert(tenants).values({
      id: cleanupTenant, slug: `memory-cleanup-${cleanupTenant}`, name: "Cleanup",
      isDefault: false, createdAt: now, updatedAt: now,
    });
    const spaceId = await ensureTestSpace(db, cleanupTenant, { enableComputer: false });
    await db.insert(agents).values({
      id: cleanupAgent, tenantId: cleanupTenant, spaceId, name: "Cleanup Agent",
      slug: `cleanup-${cleanupAgent}`, description: "", status: "ready",
      enableFs: true, enableComputer: false, enableMemory: true,
      runtimeNodeId: null, workspaceStatus: "ready", configJson: "{}",
      createdAt: now, updatedAt: now,
    });
    const providers = new MemoryProvidersService(db, secret);
    const provider = await providers.create(cleanupTenant, {
      name: "External", kind: "mem0", isDefault: true,
      config: { baseUrl: "https://mem0.cleanup.test", apiKey: "secret", defaultUserId: "u" },
    });
    await db.update(agents).set({ memoryProviderId: provider.id }).where(eq(agents.id, cleanupAgent));

    const originalFetch = globalThis.fetch;
    const deleted: string[] = [];
    let listed = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (String(init?.method ?? "GET").toUpperCase() === "DELETE") {
        deleted.push(url);
        return new Response(null, { status: 204 });
      }
      listed += 1;
      return Response.json({
        results: listed === 1
          ? [{ id: "memory-a", memory: "a" }, { id: "memory-b", memory: "b" }]
          : [],
      });
    }) as typeof fetch;
    try {
      await providers.cleanupTenantExternalData(cleanupTenant);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(deleted, [
      `https://mem0.cleanup.test/v1/memories/?agent_id=${cleanupAgent}`,
    ]);
    assert.equal(listed, 0, "bulk agent purge should cover non-default user namespaces");
  });

  it("repairs duplicate legacy defaults when 0067 is replayed", async () => {
    const { memoryProviders } = await import("../src/db/schema.js");
    await db.execute(sql.raw('DROP INDEX IF EXISTS "memory_providers_one_default"'));
    await db.update(memoryProviders).set({ isDefault: true }).where(eq(memoryProviders.tenantId, tenantId));
    const before = await db.select().from(memoryProviders).where(and(
      eq(memoryProviders.tenantId, tenantId), eq(memoryProviders.isDefault, true),
    ));
    assert.ok(before.length > 1);
    await db.execute(sql.raw(
      'DELETE FROM drizzle.__drizzle_migrations WHERE id >= (SELECT id FROM drizzle.__drizzle_migrations ORDER BY id DESC OFFSET 1 LIMIT 1)',
    ));
    await close();
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(databaseUrl);
    const { createDb } = await import("../src/db/client.js");
    const reopened = await createDb({ databaseUrl, dataDir });
    db = reopened.db;
    close = reopened.close;
    const afterRows = await db.select().from(memoryProviders).where(and(
      eq(memoryProviders.tenantId, tenantId), eq(memoryProviders.isDefault, true),
    ));
    assert.equal(afterRows.length, 1);
  });
});
