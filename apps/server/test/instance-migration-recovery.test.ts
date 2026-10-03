import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { InstanceMigrationService } from "../src/services/instance-migration.js";

describe("instance migration recovery", () => {
  let dataDir = "";
  let migrationDir = "";
  let db: import("../src/db/client.js").Db;
  let close: () => Promise<void>;
  let tenantId = "";
  let sourceId = "";
  let targetId = "";
  let foreignTargetId = "";

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "zakura-instance-migration-db-"));
    migrationDir = mkdtempSync(join(tmpdir(), "zakura-instance-migration-files-"));
    const databaseUrl = `pglite:${join(dataDir, "pglite")}`;
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(databaseUrl);
    const { createDb } = await import("../src/db/client.js");
    const opened = await createDb({ databaseUrl, dataDir });
    db = opened.db;
    close = opened.close;
    const { newId, providerCatalog, runtimeNodes, tenants } = await import("../src/db/schema.js");
    tenantId = newId();
    const foreignTenantId = newId();
    sourceId = newId();
    targetId = newId();
    foreignTargetId = newId();
    const now = new Date();
    await db.insert(tenants).values([
      { id: tenantId, slug: `migration-${tenantId}`, name: "Migration", createdAt: now, updatedAt: now },
      { id: foreignTenantId, slug: `foreign-${foreignTenantId}`, name: "Foreign", createdAt: now, updatedAt: now },
    ]);
    await db.insert(providerCatalog).values({ id: "stdio-mcp", name: "stdio MCP" });
    await db.insert(runtimeNodes).values([
      { id: sourceId, tenantId, name: "Source", slug: "source", kind: "server", status: "online", storageRoot: "/source", createdAt: now, updatedAt: now },
      { id: targetId, tenantId, name: "Target", slug: "target", kind: "server", status: "online", storageRoot: "/target", createdAt: now, updatedAt: now },
      { id: foreignTargetId, tenantId: foreignTenantId, name: "Foreign", slug: "foreign", kind: "server", status: "online", storageRoot: "/foreign", createdAt: now, updatedAt: now },
    ]);
  });

  after(async () => {
    await close?.();
    rmSync(dataDir, { recursive: true, force: true });
    rmSync(migrationDir, { recursive: true, force: true });
  });

  async function newInstance(status = "running") {
    const { componentInstances, newId } = await import("../src/db/schema.js");
    const [row] = await db.insert(componentInstances).values({
      id: newId(),
      tenantId,
      providerId: "stdio-mcp",
      name: "Migrating MCP",
      slug: `migrate-${newId()}`,
      status,
      configEnc: "test",
      runtimeNodeId: sourceId,
    }).returning();
    return row!;
  }

  function harness(opts: {
    exportGate?: Promise<void>;
    exportError?: Error;
    failTargetStart?: boolean;
  } = {}) {
    const calls = { stop: 0, start: [] as string[], exports: 0, imports: 0 };
    const sourceClient = {
      exportInstanceMigration: async () => {
        calls.exports += 1;
        if (opts.exportGate) await opts.exportGate;
        if (opts.exportError) throw opts.exportError;
        return { archive: Buffer.from("fake archive") };
      },
    };
    const targetClient = {
      importInstanceMigration: async () => {
        calls.imports += 1;
      },
    };
    const nodes = {
      getAccessible: async (requestedTenant: string, nodeId: string) => {
        if (requestedTenant !== tenantId || nodeId === foreignTargetId) return null;
        if (nodeId !== targetId) return null;
        return { id: targetId, tenantId, kind: "server", status: "online" };
      },
      requireRunnerClient: async (_tenant: string, nodeId: string) => ({
        client: nodeId === sourceId ? sourceClient : targetClient,
      }),
    };
    const orchestrator = {
      stopInstance: async (_tenant: string, instanceId: string) => {
        calls.stop += 1;
        const { componentInstances } = await import("../src/db/schema.js");
        await db.update(componentInstances).set({ status: "stopped", updatedAt: new Date() })
          .where(eq(componentInstances.id, instanceId));
      },
      startInstance: async (_tenant: string, instanceId: string) => {
        const { componentInstances } = await import("../src/db/schema.js");
        const row = await db.query.componentInstances.findFirst({
          where: eq(componentInstances.id, instanceId),
        });
        calls.start.push(row?.runtimeNodeId ?? "none");
        if (opts.failTargetStart && row?.runtimeNodeId === targetId) {
          throw new Error("fake target start failure");
        }
        await db.update(componentInstances).set({ status: "running", updatedAt: new Date() })
          .where(eq(componentInstances.id, instanceId));
        return {};
      },
    };
    const service = new InstanceMigrationService(
      db,
      { migrationDir } as never,
      nodes as never,
      orchestrator as never,
    );
    return { calls, service };
  }

  it("validates tenant target access before stopping the source", async () => {
    const instance = await newInstance();
    const { service, calls } = harness();
    await assert.rejects(
      () => service.migrate(tenantId, instance.id, foreignTargetId),
      /目标 Runner 不存在/,
    );
    assert.equal(calls.stop, 0);
  });

  it("single-flights migration, cleans the archive, and moves a running instance", async () => {
    const instance = await newInstance();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service, calls } = harness({ exportGate: gate });
    const first = service.migrate(tenantId, instance.id, targetId);
    const second = service.migrate(tenantId, instance.id, targetId);
    await new Promise((resolve) => setImmediate(resolve));
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.deepEqual(a, b);
    assert.equal(calls.stop, 1);
    assert.equal(calls.exports, 1);
    assert.equal(calls.imports, 1);
    assert.deepEqual(calls.start, [targetId]);
    const { componentInstances } = await import("../src/db/schema.js");
    const moved = await db.query.componentInstances.findFirst({ where: eq(componentInstances.id, instance.id) });
    assert.equal(moved?.runtimeNodeId, targetId);
    assert.equal(moved?.healthClaimUntil, null);
    assert.deepEqual(readdirSync(join(migrationDir, "instances")), []);
  });

  it("compensates assignment and restarts the source when target start fails", async () => {
    const instance = await newInstance();
    const { service, calls } = harness({ failTargetStart: true });
    await assert.rejects(
      () => service.migrate(tenantId, instance.id, targetId),
      /fake target start failure/,
    );
    const { componentInstances } = await import("../src/db/schema.js");
    const restored = await db.query.componentInstances.findFirst({ where: eq(componentInstances.id, instance.id) });
    assert.equal(restored?.runtimeNodeId, sourceId);
    assert.equal(restored?.status, "running");
    assert.equal(restored?.healthClaimUntil, null);
    assert.deepEqual(calls.start, [targetId, sourceId]);
    assert.deepEqual(readdirSync(join(migrationDir, "instances")), []);
  });

  it("restarts the source after export failure and excludes another service instance", async () => {
    const instance = await newInstance();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstHarness = harness({ exportGate: gate, exportError: new Error("fake export failure") });
    const secondHarness = harness();
    const first = firstHarness.service.migrate(tenantId, instance.id, targetId);
    await new Promise((resolve) => setImmediate(resolve));
    await assert.rejects(
      () => secondHarness.service.migrate(tenantId, instance.id, targetId),
      /正在迁移/,
    );
    release();
    await assert.rejects(() => first, /fake export failure/);
    const { componentInstances } = await import("../src/db/schema.js");
    const restored = await db.query.componentInstances.findFirst({ where: eq(componentInstances.id, instance.id) });
    assert.equal(restored?.runtimeNodeId, sourceId);
    assert.equal(restored?.status, "running");
    assert.equal(restored?.healthClaimUntil, null);
    assert.deepEqual(firstHarness.calls.start, [sourceId]);
  });
});
