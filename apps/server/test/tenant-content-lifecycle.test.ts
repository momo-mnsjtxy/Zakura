import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { eq, sql } from "drizzle-orm";
import {
  PlatformEventBus,
  type PlatformEventTransport,
} from "../src/services/platform-events.js";
import { TenantContentLifecycleService } from "../src/services/tenant-content-lifecycle.js";

class LocalTransport implements PlatformEventTransport {
  async subscribe(): Promise<null> { return null; }
  async publish(): Promise<void> {}
  async close(): Promise<void> {}
}

class TransportHub {
  private readonly listeners = new Map<string, Set<(message: string) => void>>();

  create(): PlatformEventTransport {
    return {
      subscribe: async (channel, listener) => {
        const listeners = this.listeners.get(channel) ?? new Set();
        listeners.add(listener);
        this.listeners.set(channel, listeners);
        return async () => { listeners.delete(listener); };
      },
      publish: async (channel, message) => {
        for (const listener of this.listeners.get(channel) ?? []) listener(message);
      },
      close: async () => {},
    };
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("durable tenant content lifecycle", () => {
  let dataDir = "";
  let databaseUrl = "";
  let db: import("../src/db/client.js").Db;
  let close: () => Promise<void>;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "zakura-tenant-content-"));
    databaseUrl = `pglite:${join(dataDir, "db")}`;
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(databaseUrl);
    const opened = await (await import("../src/db/client.js")).createDb({ databaseUrl, dataDir });
    db = opened.db;
    close = opened.close;
  });

  after(async () => {
    await close?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("discovers 0068 after 0067 and keeps the outbox independent of tenant FKs", () => {
    const journal = JSON.parse(
      readFileSync(new URL("../drizzle/meta/_journal.json", import.meta.url), "utf8"),
    ) as { entries: Array<{ idx: number; tag: string }> };
    assert.equal(journal.entries.at(-1)?.idx, 68);
    assert.equal(journal.entries.at(-1)?.tag, "0068_tenant_content_cleanup_outbox");
    const migration = readFileSync(
      new URL("../drizzle/0068_tenant_content_cleanup_outbox.sql", import.meta.url),
      "utf8",
    );
    assert.doesNotMatch(migration, /REFERENCES\s+"?tenants/i);
    assert.match(migration, /idempotency_key/);
    assert.match(migration, /available_at/);
  });

  it("blocks deletion on cleanup failure, retries durably, then deletes idempotently", async () => {
    const { newId, tenantContentCleanupJobs, tenants } = await import("../src/db/schema.js");
    const tenantId = newId();
    await db.insert(tenants).values({
      id: tenantId, slug: `cleanup-${tenantId}`, name: "Cleanup", isDefault: false,
      createdAt: new Date(), updatedAt: new Date(),
    });
    const events = new PlatformEventBus({ transport: new LocalTransport() });
    let now = new Date("2026-10-03T10:00:00Z");
    let skillAttempts = 0;
    let connectorCleanups = 0;
    let memoryCleanups = 0;
    let taskCleanups = 0;
    let deleteLeases = 0;
    const leaseFinishes: boolean[] = [];
    const lifecycle = new TenantContentLifecycleService(db, {
      stopChannels: async () => {},
      cleanupTaskState: async () => { taskCleanups += 1; },
      agentLifecycle: {
        beginTenantDelete: async () => {
          deleteLeases += 1;
          return { finish: async (deleted) => { leaseFinishes.push(deleted); } };
        },
        suspendTenant: async () => {},
        revokeMember: async () => {},
      },
      cleanupSkillFiles: async () => {
        skillAttempts += 1;
        if (skillAttempts === 1) throw new Error("runner offline");
      },
      cleanupConnectorSecrets: async () => { connectorCleanups += 1; },
      cleanupExternalMemory: async () => { memoryCleanups += 1; },
    }, { events, instanceId: "cleanup-a", now: () => now, pollIntervalMs: 60_000 });
    const { TenantService } = await import("../src/services/tenants.js");
    const tenantsService = new TenantService(db, [lifecycle.lifecycleHook()]);

    await assert.rejects(
      () => tenantsService.deleteTenantAsPlatformAdmin(tenantId),
      /runner offline/,
    );
    assert.ok(await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) }));
    let job = await db.query.tenantContentCleanupJobs.findFirst({
      where: eq(tenantContentCleanupJobs.tenantId, tenantId),
    });
    assert.equal(job?.status, "failed");
    assert.equal(job?.attempts, 1);
    assert.equal(connectorCleanups, 1, "independent cleanup should still run");
    assert.equal(memoryCleanups, 1);
    assert.equal(taskCleanups, 1);
    assert.deepEqual(leaseFinishes, [false]);

    now = new Date(now.getTime() + 2_000);
    await lifecycle.tick();
    job = await db.query.tenantContentCleanupJobs.findFirst({
      where: eq(tenantContentCleanupJobs.tenantId, tenantId),
    });
    assert.equal(job?.status, "completed");
    assert.equal(job?.attempts, 2);
    assert.equal(deleteLeases, 2);
    assert.deepEqual(leaseFinishes, [false, false]);
    assert.equal(taskCleanups, 2);

    await tenantsService.deleteTenantAsPlatformAdmin(tenantId);
    assert.equal(await db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) }), undefined);
    assert.ok(
      await db.query.tenantContentCleanupJobs.findFirst({
        where: eq(tenantContentCleanupJobs.tenantId, tenantId),
      }),
      "delete tombstone must survive tenant cascade",
    );
    assert.equal(deleteLeases, 3);
    assert.equal(taskCleanups, 2, "completed delete cleanup must remain idempotent");
    assert.deepEqual(leaseFinishes, [false, false, true]);
    await lifecycle.stop();
    await events.close();
  });

  it("fans suspension teardown to every live replica and reconciles a missed event", async () => {
    const { newId, tenants } = await import("../src/db/schema.js");
    const tenantId = newId();
    await db.insert(tenants).values({
      id: tenantId, slug: `suspend-${tenantId}`, name: "Suspend", isDefault: false,
      suspendedAt: new Date(), createdAt: new Date(), updatedAt: new Date(),
    });
    const hub = new TransportHub();
    const eventsA = new PlatformEventBus({ transport: hub.create(), instanceId: "events-a" });
    const eventsB = new PlatformEventBus({ transport: hub.create(), instanceId: "events-b" });
    const state = {
      a: { stopped: 0, suspended: 0, revoked: 0, tasks: 0 },
      b: { stopped: 0, suspended: 0, revoked: 0, tasks: 0 },
      late: { stopped: 0, suspended: 0, revoked: 0, tasks: 0 },
    };
    const callbacks = (key: keyof typeof state) => ({
      stopChannels: async () => { state[key].stopped += 1; },
      cleanupTaskState: async () => { state[key].tasks += 1; },
      agentLifecycle: {
        beginTenantDelete: async () => ({ finish: async () => {} }),
        suspendTenant: async () => { state[key].suspended += 1; },
        revokeMember: async (_tenantId: string, userId: string) => {
          assert.equal(userId, "removed-user");
          state[key].revoked += 1;
        },
      },
      cleanupSkillFiles: async () => {},
      cleanupConnectorSecrets: async () => {},
      cleanupExternalMemory: async () => {},
    });
    const a = new TenantContentLifecycleService(db, callbacks("a"), {
      events: eventsA, instanceId: "replica-a", pollIntervalMs: 60_000,
    });
    const b = new TenantContentLifecycleService(db, callbacks("b"), {
      events: eventsB, instanceId: "replica-b", pollIntervalMs: 60_000,
    });
    a.start();
    b.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await a.lifecycleHook().afterSuspend(tenantId);
    await waitFor(() => state.a.stopped > 0 && state.b.stopped > 0);
    await waitFor(() => state.a.suspended > 0 && state.b.suspended > 0);
    await waitFor(() => state.a.tasks > 0 && state.b.tasks > 0);
    const taskCountsAfterSuspend = { a: state.a.tasks, b: state.b.tasks };
    await a.lifecycleHook().afterMemberRemoved(tenantId, "removed-user");
    await waitFor(() => state.a.revoked > 0 && state.b.revoked > 0);
    assert.deepEqual(
      { a: state.a.tasks, b: state.b.tasks },
      taskCountsAfterSuspend,
      "member revocation must not clear all tenant task state",
    );

    const eventsLate = new PlatformEventBus({ transport: hub.create(), instanceId: "events-late" });
    const late = new TenantContentLifecycleService(db, callbacks("late"), {
      events: eventsLate, instanceId: "replica-late", pollIntervalMs: 60_000,
    });
    await late.tick();
    assert.ok(state.late.stopped > 0, "late replica did not observe durable suspend tombstone");
    assert.ok(state.late.suspended > 0, "late replica did not reconcile agent suspension");
    assert.ok(state.late.tasks > 0, "late replica did not reconcile tenant task cleanup");
    await Promise.all([a.stop(), b.stop(), late.stop()]);
    await Promise.all([eventsA.close(), eventsB.close(), eventsLate.close()]);
  });

  it("backs off retryable failures and records a terminal cleanup result", async () => {
    const { tenantContentCleanupJobs } = await import("../src/db/schema.js");
    const events = new PlatformEventBus({ transport: new LocalTransport() });
    let now = new Date("2026-10-03T12:00:00Z");
    const lifecycle = new TenantContentLifecycleService(db, {
      stopChannels: async () => { throw new Error("replica unavailable"); },
      cleanupSkillFiles: async () => {},
      cleanupConnectorSecrets: async () => {},
      cleanupExternalMemory: async () => {},
    }, { events, instanceId: "terminal", now: () => now, pollIntervalMs: 60_000 });
    await lifecycle.lifecycleHook().afterSuspend("terminal-tenant");
    for (let attempt = 1; attempt < 8; attempt += 1) {
      now = new Date(now.getTime() + 60 * 60 * 1000 + 1);
      await lifecycle.tick();
    }
    const job = await db.query.tenantContentCleanupJobs.findFirst({
      where: eq(tenantContentCleanupJobs.tenantId, "terminal-tenant"),
    });
    assert.equal(job?.attempts, 8);
    assert.equal(job?.status, "terminal");
    assert.match(job?.lastError ?? "", /replica unavailable/);
    await lifecycle.stop();
    await events.close();
  });

  it("replays 0068 safely on an upgraded database with existing outbox rows", async () => {
    const replayDir = mkdtempSync(join(tmpdir(), "zakura-cleanup-upgrade-"));
    const replayUrl = `pglite:${join(replayDir, "db")}`;
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(replayUrl);
    const { createDb } = await import("../src/db/client.js");
    let opened = await createDb({ databaseUrl: replayUrl, dataDir: replayDir });
    const { newId, tenantContentCleanupJobs } = await import("../src/db/schema.js");
    const id = newId();
    await opened.db.insert(tenantContentCleanupJobs).values({
      id, idempotencyKey: `upgrade:${id}`, tenantId: "deleted-tenant",
      action: "tenant_deleted", status: "completed", payloadJson: "{}",
      attempts: 1, maxAttempts: 8, availableAt: new Date(), completedAt: new Date(),
      createdAt: new Date(), updatedAt: new Date(),
    });
    await opened.db.execute(sql.raw(
      "DELETE FROM drizzle.__drizzle_migrations WHERE id = (SELECT max(id) FROM drizzle.__drizzle_migrations)",
    ));
    await opened.close();
    await runMigrations(replayUrl);
    opened = await createDb({ databaseUrl: replayUrl, dataDir: replayDir });
    assert.ok(
      await opened.db.query.tenantContentCleanupJobs.findFirst({
        where: eq(tenantContentCleanupJobs.id, id),
      }),
    );
    await opened.close();
    rmSync(replayDir, { recursive: true, force: true });
  });
});
