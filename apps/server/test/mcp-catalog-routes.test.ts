import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Hono } from "hono";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import { registerMcpRoutes } from "../src/api/mcp-routes.js";
import { McpStoreService } from "../src/services/mcp-store.js";
const tenantId = "tenant-mcp-catalog";
describe("MCP catalog mutation routes", () => {
  let dir: string; let db: Db; let close: () => Promise<void>; let app: Hono<any>; let revision = 1;
  before(async () => {
    process.env.REDIS_URL = "off";
    dir = mkdtempSync(join(tmpdir(), "zakura-mcp-catalog-"));
    const databaseUrl = `pglite:${join(dir, "db")}`;
    await (await import("../src/db/migrate.js")).runMigrations(databaseUrl);
    const created = await (await import("../src/db/client.js")).createDb({ databaseUrl, dataDir: dir }); db = created.db; close = created.close;
    const { tenants } = await import("../src/db/schema.js"); await db.insert(tenants).values({ id: tenantId, name: "Catalog", slug: "catalog" });
    const config = { dataDir: dir, databaseUrl, secret: "catalog-secret", publicBaseUrl: "http://localhost", internalBaseUrl: "http://localhost" } as AppConfig;
    const mcpStore = new McpStoreService(db, config, { marketplaceJsonLoader: async (url) => {
      assert.equal(url.hostname, "catalog.example.test");
      return { name: "Test Catalog", description: `revision-${revision}`, plugins: [{ name: `echo-${revision}`, description: "fake stdio server", mcpServers: { echo: { command: "node", args: [`echo-${revision}.mjs`] } } }] };
    }});
    app = new Hono(); app.use("*", async (c, next) => { c.set("session", { userId: "user", tenantId, email: "owner@example.test", role: "owner" }); await next(); });
    registerMcpRoutes(app, { db, config, mcpStore, integrationCatalog: {} as never, upstreamOauth: {} as never, upstreamOauthClients: {} as never, agentService: {} as never, orchestrator: {} as never, gateway: {} as never, syncConnectorCapabilities: async () => undefined });
  });
  after(async () => { await close?.(); rmSync(dir, { recursive: true, force: true }); });
  it("imports, lists, synchronizes and idempotently removes a persisted custom catalog", async () => {
    const imported = await app.request("http://local/api/mcp/store/sources", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sourceUrl: "https://catalog.example.test/marketplace.json", format: "codex" }) });
    assert.equal(imported.status, 201, await imported.clone().text()); const source = ((await imported.json()) as any).source; assert.match(source.id, /^custom:/); assert.equal(source.count, 1);
    const listed = await app.request("http://local/api/mcp/store/sources"); assert.equal(listed.status, 200); assert.ok(((await listed.json()) as any).sources.some((item: any) => item.id === source.id));
    let search = await app.request(`http://local/api/mcp/store/search?store=${encodeURIComponent(source.id)}&q=echo-1`); assert.equal(search.status, 200); assert.equal(((await search.json()) as any).items.length, 1);
    revision = 2; const synced = await app.request("http://local/api/mcp/store/sync", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ stores: [source.id] }) });
    assert.equal(synced.status, 200, await synced.clone().text()); assert.equal(((await synced.json()) as any).results[0].count, 1);
    search = await app.request(`http://local/api/mcp/store/search?store=${encodeURIComponent(source.id)}&q=echo-2`); assert.equal(((await search.json()) as any).items[0].name.includes("echo-2"), true);
    const removed = await app.request(`http://local/api/mcp/store/sources/${encodeURIComponent(source.id)}`, { method: "DELETE" }); assert.equal(removed.status, 200);
    const retried = await app.request(`http://local/api/mcp/store/sources/${encodeURIComponent(source.id)}`, { method: "DELETE" }); assert.equal(retried.status, 404);
    const { mcpStoreSources } = await import("../src/db/schema.js"); assert.equal((await db.select().from(mcpStoreSources)).length, 0);
  });
  it("does not persist a catalog when provider loading fails", async () => {
    const { mcpStoreSources } = await import("../src/db/schema.js"); const beforeCount = (await db.select().from(mcpStoreSources)).length;
    const badStore = new McpStoreService(db, { dataDir: dir, databaseUrl: "unused", secret: "x" } as AppConfig, { marketplaceJsonLoader: async () => { throw new Error("provider offline"); } });
    await assert.rejects(() => badStore.importSource(tenantId, { sourceUrl: "https://catalog.example.test/fail.json", format: "codex" }), /provider offline/);
    assert.equal((await db.select().from(mcpStoreSources)).length, beforeCount);
  });
});
