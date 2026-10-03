import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, describe, it } from "node:test";
import type { Db } from "../src/db/client.js";
import { UpstreamOauthClientStore } from "../src/services/upstream-oauth-clients.js";

describe("upstream OAuth client persistence lifecycle", () => {
  let root = "";
  let db: Db;
  let close: () => Promise<void>;
  let store: UpstreamOauthClientStore;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "zakura-upstream-oauth-clients-"));
    const databaseUrl = `pglite:${join(root, "db")}`;
    await (await import("../src/db/migrate.js")).runMigrations(databaseUrl);
    const opened = await (await import("../src/db/client.js")).createDb({
      databaseUrl,
      dataDir: root,
    });
    db = opened.db;
    close = opened.close;
    const { tenants } = await import("../src/db/schema.js");
    await db.insert(tenants).values([
      { id: "oauth-client-a", slug: "oauth-client-a", name: "OAuth A" },
      { id: "oauth-client-b", slug: "oauth-client-b", name: "OAuth B" },
    ]);
    store = new UpstreamOauthClientStore(db, {
      secret: "01234567890123456789012345678901",
    } as never);
  });

  after(async () => {
    await close?.();
    rmSync(root, { recursive: true, force: true });
  });

  it("coalesces concurrent records, preserves secrets, and isolates tenants", async () => {
    const records = await Promise.all(
      Array.from({ length: 8 }, () =>
        store.record({
          tenantId: "oauth-client-a",
          mcpUrl: "https://www.example.test/mcp",
          clientId: "client-1",
          clientSecret: "secret-1",
          clientName: "Example",
          source: "byo",
          scope: "mcp tools",
        }),
      ),
    );
    assert.ok(records.every((record) => record?.id === records[0]?.id));
    const listed = await store.list("oauth-client-a");
    assert.equal(listed.length, 1);
    assert.equal(listed[0]?.host, "example.test");
    assert.equal(listed[0]?.hasSecret, true);
    assert.equal("clientSecret" in (listed[0] ?? {}), false);
    assert.equal("secretEnc" in (listed[0] ?? {}), false);

    await store.record({
      tenantId: "oauth-client-a",
      mcpUrl: "https://example.test/renamed",
      clientId: "client-1",
      clientName: "Renamed",
      source: "dcr",
      scope: "mcp",
    });
    assert.deepEqual(await store.resolve("oauth-client-a", {
      mcpUrl: "https://example.test/another-path",
      clientId: "client-1",
    }), {
      id: records[0]!.id,
      clientId: "client-1",
      clientSecret: "secret-1",
      scope: "mcp",
      source: "dcr",
    });

    const foreign = await store.record({
      tenantId: "oauth-client-b",
      mcpUrl: "https://example.test/mcp",
      clientId: "client-1",
      clientSecret: "tenant-b-secret",
      source: "byo",
    });
    assert.notEqual(foreign?.id, records[0]?.id);
    assert.equal(await store.remove("oauth-client-b", records[0]!.id), false);
    assert.ok(await store.resolve("oauth-client-a", {
      mcpUrl: "https://example.test/mcp",
      clientId: "client-1",
    }));
    assert.equal(await store.remove("oauth-client-a", records[0]!.id), true);
    assert.equal(await store.resolve("oauth-client-a", {
      mcpUrl: "https://example.test/mcp",
      clientId: "client-1",
    }), null);
  });

  it("rejects invalid resource URLs instead of merging them under an unknown host", async () => {
    await assert.rejects(
      store.record({
        tenantId: "oauth-client-a",
        mcpUrl: "not-a-url",
        clientId: "bad-client",
        source: "byo",
      }),
      /有效的 HTTP\(S\) URL/,
    );
  });
});
