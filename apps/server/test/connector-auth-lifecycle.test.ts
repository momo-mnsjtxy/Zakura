import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { ensureTestSpace } from "./helpers/spaces.js";

describe("connector auth persistence lifecycle", () => {
  let dataDir = "";
  let db: import("../src/db/client.js").Db;
  let close: () => Promise<void>;
  let auth: import("../src/services/connector-auth.js").ConnectorAuthService;
  let tenantA = "";
  let tenantB = "";
  let agentA = "";
  let agentB = "";
  let spaceA = "";

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "zakura-connector-auth-"));
    const databaseUrl = `pglite:${join(dataDir, "pglite")}`;
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(databaseUrl);
    const { createDb } = await import("../src/db/client.js");
    const opened = await createDb({ databaseUrl, dataDir });
    db = opened.db;
    close = opened.close;
    const { agents, newId, tenants } = await import("../src/db/schema.js");
    tenantA = newId();
    tenantB = newId();
    agentA = newId();
    agentB = newId();
    const now = new Date();
    await db.insert(tenants).values([
      { id: tenantA, slug: `connector-a-${tenantA}`, name: "Connector A", isDefault: true, createdAt: now, updatedAt: now },
      { id: tenantB, slug: `connector-b-${tenantB}`, name: "Connector B", isDefault: false, createdAt: now, updatedAt: now },
    ]);
    spaceA = await ensureTestSpace(db, tenantA, { enableComputer: false });
    const spaceB = await ensureTestSpace(db, tenantB, { enableComputer: false });
    await db.insert(agents).values([
      {
        id: agentA, spaceId: spaceA, tenantId: tenantA, name: "A", slug: `connector-a-${agentA}`,
        description: "", status: "ready", enableFs: true, enableComputer: false,
        enableMemory: false, runtimeNodeId: null, workspaceStatus: "ready", configJson: "{}",
        createdAt: now, updatedAt: now,
      },
      {
        id: agentB, spaceId: spaceB, tenantId: tenantB, name: "B", slug: `connector-b-${agentB}`,
        description: "", status: "ready", enableFs: true, enableComputer: false,
        enableMemory: false, runtimeNodeId: null, workspaceStatus: "ready", configJson: "{}",
        createdAt: now, updatedAt: now,
      },
    ]);
    const { ConnectorAuthService } = await import("../src/services/connector-auth.js");
    auth = new ConnectorAuthService(db, {
      secret: "01234567890123456789012345678901",
    } as never);
  });

  after(async () => {
    await close?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("atomically coalesces repeated installation creation", async () => {
    await Promise.all(
      Array.from({ length: 10 }, () => auth.ensureInstallations(tenantA, "github", [agentA, agentA])),
    );
    const rows = await auth.listInstallations(tenantA, { connectorRef: "github" });
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.agentId, agentA);
    assert.equal(rows[0]?.enabled, true);
  });

  it("rejects a foreign agent before creating a cross-tenant row", async () => {
    await assert.rejects(
      () => auth.ensureInstallations(tenantA, "github", [agentB]),
      /不属于当前租户/,
    );
    assert.equal((await auth.listInstallations(tenantA)).length, 1);
    assert.equal((await auth.listInstallations(tenantB)).length, 0);
  });

  it("serializes profile/settings merges so concurrent fields are not lost", async () => {
    const { ConnectorAuthService } = await import("../src/services/connector-auth.js");
    const secondInstance = new ConnectorAuthService(db, {
      secret: "01234567890123456789012345678901",
    } as never);
    await auth.saveProfile(tenantA, "custom-profile", {
      kind: "custom",
      enabled: true,
      values: { base: "kept" },
    });
    await Promise.all([
      auth.mergeProfileValues(tenantA, "custom-profile", { generatedSecret: "one" }),
      secondInstance.mergeProfileValues(tenantA, "custom-profile", { callbackState: "two" }),
      auth.mergeProfileValues(tenantA, "custom-profile", { installationId: "three" }),
    ]);
    const profile = await auth.getProfile(tenantA, "custom-profile");
    assert.deepEqual(profile?.values, {
      base: "kept",
      generatedSecret: "one",
      callbackState: "two",
      installationId: "three",
    });

    const fields = [
      { key: "region", label: "Region", type: "text" as const },
      { key: "workspace", label: "Workspace", type: "text" as const },
    ];
    await Promise.all([
      auth.saveSettings(tenantA, "github", { region: "eu" }, fields),
      secondInstance.saveSettings(tenantA, "github", { workspace: "core" }, fields),
    ]);
    assert.deepEqual(await auth.getSettings(tenantA, "github"), {
      region: "eu",
      workspace: "core",
    });
  });

  it("never silently overwrites an undecryptable credential blob", async () => {
    const { connectorAuthProfiles } = await import("../src/db/schema.js");
    const row = await db.query.connectorAuthProfiles.findFirst({
      where: eq(connectorAuthProfiles.profileKey, "custom-profile"),
    });
    assert.ok(row);
    await db.update(connectorAuthProfiles)
      .set({ configEnc: "corrupted-ciphertext" })
      .where(eq(connectorAuthProfiles.id, row.id));
    await assert.rejects(
      () => auth.mergeProfileValues(tenantA, "custom-profile", { wouldLoseData: "x" }),
      /拒绝覆盖/,
    );
    const afterRow = await db.query.connectorAuthProfiles.findFirst({
      where: eq(connectorAuthProfiles.id, row.id),
    });
    assert.equal(afterRow?.configEnc, "corrupted-ciphertext");
  });

  it("stores OAuth authorization encrypted and reports authorized state", async () => {
    await auth.saveInstallationAuthorization(tenantA, agentA, "github", {
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresAt: 4_102_444_800,
    });
    const { agentConnectorInstallations } = await import("../src/db/schema.js");
    const rows = await db.select().from(agentConnectorInstallations);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.configEnc.includes("access-secret"), false);
    const view = await auth.listInstallations(tenantA, { agentId: agentA });
    assert.equal(view[0]?.authorized, true);
  });

  it("purges only the deleting tenant's workspace-owned connector secrets", async () => {
    const {
      agentChannelBindings,
      agentConnectorInstallations,
      connectorAuthProfiles,
      connectorSettings,
      emailConnectorInstances,
      newId,
    } = await import("../src/db/schema.js");
    const now = new Date();
    await auth.saveProfile(tenantB, "keep-profile", {
      kind: "custom", enabled: true, values: { token: "keep" },
    });
    await db.insert(emailConnectorInstances).values({
      id: newId(), tenantId: tenantA, name: "mail", product: "resendapi",
      enabled: true, configEnc: "encrypted-email", createdAt: now, updatedAt: now,
    });
    await db.insert(agentChannelBindings).values({
      id: newId(), tenantId: tenantA, spaceId: spaceA, agentId: agentA,
      platform: "slack", profileKey: "remote-slack", label: "slack", enabled: true,
      settingsJson: "{}", configEnc: "encrypted-channel", createdAt: now, updatedAt: now,
    });

    await auth.cleanupTenantSecrets(tenantA);
    assert.equal(
      (await db.select().from(agentConnectorInstallations)
        .where(eq(agentConnectorInstallations.tenantId, tenantA))).length,
      0,
    );
    assert.equal(
      (await db.select().from(agentChannelBindings)
        .where(eq(agentChannelBindings.tenantId, tenantA))).length,
      0,
    );
    assert.equal(
      (await db.select().from(emailConnectorInstances)
        .where(eq(emailConnectorInstances.tenantId, tenantA))).length,
      0,
    );
    assert.equal(
      (await db.select().from(connectorAuthProfiles)
        .where(eq(connectorAuthProfiles.scopeKey, tenantA))).length,
      0,
    );
    assert.equal(
      (await db.select().from(connectorSettings)
        .where(eq(connectorSettings.scopeKey, tenantA))).length,
      0,
    );
    assert.ok(
      await db.query.connectorAuthProfiles.findFirst({
        where: eq(connectorAuthProfiles.scopeKey, tenantB),
      }),
    );
  });
});
