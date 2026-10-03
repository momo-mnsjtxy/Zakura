import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { ensureTestSpace } from "./helpers/spaces.js";

describe("network exposure lifecycle", () => {
  let dataDir = "";
  let db: import("../src/db/client.js").Db;
  let close: () => Promise<void>;
  let tenantId = "";
  let agentId = "";

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "zakura-network-ops-"));
    const databaseUrl = `pglite:${join(dataDir, "pglite")}`;
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
      id: tenantId,
      slug: `network-${tenantId}`,
      name: "Network Ops",
      isDefault: false,
      createdAt: now,
      updatedAt: now,
    });
    const spaceId = await ensureTestSpace(db, tenantId, { enableComputer: false });
    await db.insert(agents).values({
      id: agentId,
      tenantId,
      spaceId,
      name: "Network Agent",
      slug: `network-${agentId}`,
      description: "",
      status: "ready",
      enableFs: true,
      enableComputer: false,
      enableMemory: false,
      runtimeNodeId: null,
      workspaceStatus: "ready",
      configJson: "{}",
      createdAt: now,
      updatedAt: now,
    });
  });

  after(async () => {
    await close?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("keeps failed tunnel teardown retryable and clears the error after retry", async () => {
    const { ExposureService } = await import("../src/services/port-exposures.js");
    const { SecurityPolicyService } = await import("../src/services/network-security.js");
    const { portExposures } = await import("../src/db/schema.js");
    const policy = new SecurityPolicyService(db);
    let relayCloses = 0;
    let stopCalls = 0;
    const auditActions: string[] = [];
    const service = new ExposureService(
      db,
      {} as never,
      {
        openTcpTunnel: async () => ({
          host: "127.0.0.1",
          port: 31999,
          url: "tcp://127.0.0.1:31999",
          close: () => {
            relayCloses += 1;
          },
        }),
      } as never,
      {
        getWorkspaceContainer: async () => ({ dockerId: "workspace-1", status: "running" }),
      } as never,
      {
        ensureTenantDefaults: async () => undefined,
        getDefaultProviderId: async () => "cloudflare-quick",
        getProvider: async () => ({ enabled: true }),
      } as never,
      policy,
      {
        append: async (_tenantId: string, action: string) => {
          auditActions.push(action);
        },
      } as never,
      {
        startCloudflareQuickTunnel: async () => ({
          publicUrl: "https://fake-tunnel.example.test",
          metricsPort: 32000,
          stop: async () => {
            stopCalls += 1;
            if (stopCalls === 1) throw new Error("fake control-plane unavailable");
          },
        }),
        startTailscaleServe: async () => {
          throw new Error("unexpected tailscale call");
        },
        probeTailscaleBackend: async () => ({ ok: true, message: "fake" }),
      } as never,
    );

    const created = await service.create(
      tenantId,
      agentId,
      { port: 3000, provider: "cloudflare-quick", ttlMinutes: 30 },
      { type: "user", id: "user-1" },
    );
    assert.equal(created.status, "active");
    assert.equal(created.publicUrl, "https://fake-tunnel.example.test");

    await assert.rejects(
      () => service.stop(tenantId, created.id, { type: "user", id: "user-1" }),
      /fake control-plane unavailable/,
    );
    const failed = await db.query.portExposures.findFirst({
      where: eq(portExposures.id, created.id),
    });
    assert.equal(failed?.status, "error");
    assert.match(failed?.lastError ?? "", /Failed to stop exposure/);

    const stopped = await service.stop(tenantId, created.id, { type: "user", id: "user-1" });
    assert.equal(stopped?.status, "stopped");
    assert.equal(stopped?.lastError, null);
    assert.equal(stopCalls, 2);
    assert.equal(relayCloses, 2);
    assert.deepEqual(auditActions, ["exposure.create", "exposure.stop_error", "exposure.stop"]);
  });

  it("marks restart-orphaned local tunnels as durable errors", async () => {
    const { reconcileOrphanExposures } = await import("../src/services/port-exposures.js");
    const { portExposures } = await import("../src/db/schema.js");
    const now = new Date();
    await db
      .update(portExposures)
      .set({ status: "active", stoppedAt: null, lastError: null, updatedAt: now })
      .where(eq(portExposures.tenantId, tenantId));

    assert.equal(await reconcileOrphanExposures(db), 1);
    const [row] = await db.select().from(portExposures).where(eq(portExposures.tenantId, tenantId));
    assert.equal(row?.status, "error");
    assert.match(row?.lastError ?? "", /tunnel process lost/);
  });

  it("does not claim a failed local teardown succeeded after its owner restarts", async () => {
    const { ExposureService } = await import("../src/services/port-exposures.js");
    const { SecurityPolicyService } = await import("../src/services/network-security.js");
    const { portExposures } = await import("../src/db/schema.js");
    const [existing] = await db
      .select()
      .from(portExposures)
      .where(eq(portExposures.tenantId, tenantId));
    assert.ok(existing);
    await db
      .update(portExposures)
      .set({
        status: "error",
        stoppedAt: null,
        lastError: "Failed to stop exposure: tunnel: owner exited",
        updatedAt: new Date(),
      })
      .where(eq(portExposures.id, existing.id));

    const service = new ExposureService(
      db,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      new SecurityPolicyService(db),
      { append: async () => undefined } as never,
      {} as never,
    );
    await assert.rejects(
      () => service.stop(tenantId, existing.id, { type: "user", id: "user-1" }),
      /runtime owner unavailable/,
    );
    const after = await db.query.portExposures.findFirst({
      where: eq(portExposures.id, existing.id),
    });
    assert.equal(after?.status, "error");
    assert.match(after?.lastError ?? "", /runtime owner unavailable/);
    assert.equal(after?.stoppedAt, null);
  });
});
