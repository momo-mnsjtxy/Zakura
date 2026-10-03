import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, afterEach, before, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import type { Db } from "../src/db/client.js";
import * as schema from "../src/db/schema.js";
import { ModelRoutesService } from "../src/services/model-routes.js";
import {
  MODEL_UPSTREAM_SECRET_KEEP_VALUE,
  ModelUpstreamsService,
} from "../src/services/model-upstreams.js";
import { UpstreamModelsService } from "../src/services/upstream-models.js";

describe("model upstream administration lifecycle", () => {
  let root = "";
  let db: Db;
  let close: () => Promise<void>;
  let upstreams: ModelUpstreamsService;
  let routes: ModelRoutesService;
  let inventory: UpstreamModelsService;
  const tenantA = "model-admin-a";
  const tenantB = "model-admin-b";
  const originalFetch = globalThis.fetch;

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "zakura-model-admin-"));
    const databaseUrl = `pglite:${join(root, "db")}`;
    await (await import("../src/db/migrate.js")).runMigrations(databaseUrl);
    const opened = await (await import("../src/db/client.js")).createDb({
      databaseUrl,
      dataDir: root,
    });
    db = opened.db;
    close = opened.close;
    await db.insert(schema.tenants).values([
      { id: tenantA, slug: tenantA, name: "Model Admin A" },
      { id: tenantB, slug: tenantB, name: "Model Admin B" },
    ]);
    upstreams = new ModelUpstreamsService(db);
    routes = new ModelRoutesService(db, upstreams);
    inventory = new UpstreamModelsService(
      db,
      upstreams,
      { matchBest: async () => null } as never,
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  after(async () => {
    await close?.();
    rmSync(root, { recursive: true, force: true });
  });

  it("redacts every credential DTO and preserves masked secrets on edit", async () => {
    const created = await upstreams.create(tenantA, {
      name: "Secret Provider",
      protocol: "openai",
      config: {
        baseUrl: "https://secret.invalid/v1",
        apiKey: "provider-secret",
        accessToken: "access-secret",
        extraHeaders: {
          Authorization: "Bearer header-secret",
          "x-provider-key": "header-key",
        },
      },
    });
    assert.equal(created.config.apiKey, MODEL_UPSTREAM_SECRET_KEEP_VALUE);
    assert.equal(created.config.accessToken, MODEL_UPSTREAM_SECRET_KEEP_VALUE);
    assert.deepEqual(created.config.extraHeaders, {
      Authorization: MODEL_UPSTREAM_SECRET_KEEP_VALUE,
      "x-provider-key": MODEL_UPSTREAM_SECRET_KEEP_VALUE,
    });
    assert.equal(created.resolvedConfig.apiKey, MODEL_UPSTREAM_SECRET_KEEP_VALUE);
    assert.equal(JSON.stringify(created).includes("provider-secret"), false);
    assert.equal(JSON.stringify(created).includes("header-secret"), false);

    const updated = await upstreams.update(tenantA, created.id, {
      config: {
        ...created.config,
        baseUrl: "https://updated.invalid/v1",
      },
    });
    assert.equal(updated.config.apiKey, MODEL_UPSTREAM_SECRET_KEEP_VALUE);
    const stored = await db.query.modelUpstreams.findFirst({
      where: eq(schema.modelUpstreams.id, created.id),
    });
    const raw = JSON.parse(stored!.configJson) as Record<string, unknown>;
    assert.equal(raw.apiKey, "provider-secret");
    assert.equal(raw.accessToken, "access-secret");
    assert.deepEqual(raw.extraHeaders, {
      Authorization: "Bearer header-secret",
      "x-provider-key": "header-key",
    });
    assert.equal(raw.baseUrl, "https://updated.invalid/v1");
  });

  it("serializes default route transitions and successor promotion", async () => {
    const upstream = await upstreams.create(tenantA, {
      name: "Route Provider",
      protocol: "custom",
      config: { baseUrl: "https://routes.invalid/v1" },
    });
    const [first, second] = await Promise.all([
      routes.create(tenantA, {
        name: "First Default",
        capability: "chat",
        upstreamId: upstream.id,
        model: "first-model",
        isDefault: true,
      }),
      routes.create(tenantA, {
        name: "Second Default",
        capability: "chat",
        upstreamId: upstream.id,
        model: "second-model",
        isDefault: true,
      }),
    ]);
    const defaults = (await routes.list(tenantA, "chat")).filter((route) => route.isDefault);
    assert.equal(defaults.length, 1);
    const current = defaults[0]!;
    const successorId = current.id === first.id ? second.id : first.id;
    await routes.remove(tenantA, current.id);
    assert.equal((await routes.get(tenantA, successorId))?.isDefault, true);
  });

  it("serializes inventory defaults, promotes successors, and counts actual deletes", async () => {
    const upstream = await upstreams.create(tenantA, {
      name: "Inventory Provider",
      protocol: "custom",
      config: { baseUrl: "https://inventory.invalid/v1" },
    });
    const [first, second] = await Promise.all([
      inventory.create(tenantA, {
        upstreamId: upstream.id,
        nativeModel: "inventory-first",
        canonicalModel: "inventory-first",
        capability: "chat",
        isDefault: true,
      }),
      inventory.create(tenantA, {
        upstreamId: upstream.id,
        nativeModel: "inventory-second",
        canonicalModel: "inventory-second",
        capability: "chat",
        isDefault: true,
      }),
    ]);
    const rows = await db.select().from(schema.upstreamModels).where(
      and(
        eq(schema.upstreamModels.tenantId, tenantA),
        eq(schema.upstreamModels.upstreamId, upstream.id),
      ),
    );
    assert.equal(rows.filter((row) => row.isDefault).length, 1);
    const current = rows.find((row) => row.isDefault)!;
    const successorId = current.id === first.id ? second.id : first.id;
    await inventory.remove(tenantA, current.id);
    assert.equal((await inventory.get(tenantA, successorId))?.isDefault, true);
    assert.deepEqual(
      await inventory.removeMany(tenantA, [successorId, "missing", successorId]),
      { deleted: 1 },
    );
  });

  it("reports actual upstream deletes and treats a 404 health probe as unhealthy", async () => {
    const own = await upstreams.create(tenantA, {
      name: "Health Provider",
      protocol: "openai",
      config: { baseUrl: "https://health.invalid/v1", apiKey: "health-key" },
    });
    const foreign = await upstreams.create(tenantB, {
      name: "Foreign Provider",
      protocol: "openai",
      config: { baseUrl: "https://foreign.invalid/v1", apiKey: "foreign-key" },
    });
    globalThis.fetch = (async () => Response.json({ error: "not found" }, { status: 404 })) as typeof fetch;
    const health = await upstreams.healthCheck(tenantA, own.id);
    assert.equal(health.status, "unhealthy");
    assert.match(health.message, /404/);
    assert.deepEqual(
      await upstreams.removeMany(tenantA, [own.id, foreign.id, "missing", own.id]),
      { deleted: 1 },
    );
    assert.ok(await upstreams.get(tenantB, foreign.id));
  });
});
