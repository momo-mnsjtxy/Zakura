import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import {
  migrateAgentSettingsToSpaces,
  migrateAgentWorkspacesToSpaces,
} from "../src/services/space-settings-migration.js";
import { spaceWorkspaceHostPath } from "../src/services/spaces.js";

describe("Agent-to-Space upgrade migrations", () => {
  let root: string;
  let db: Db;
  let close: () => Promise<void>;
  let config: AppConfig;
  let tenantId: string;
  let settingsSpaceId: string;
  let settingsOldAgentId: string;
  let settingsNewAgentId: string;
  let rollbackSpaceId: string;
  let rollbackOldAgentId: string;
  let rollbackNewAgentId: string;
  let failedWorkspaceSpaceId: string;
  let failedWorkspaceOldAgentId: string;
  let failedWorkspaceNewAgentId: string;
  let occupiedSpaceId: string;
  let occupiedAgentId: string;

  before(async () => {
    process.env.REDIS_URL = "off";
    root = mkdtempSync(join(tmpdir(), "zakura-space-settings-migration-"));
    const databaseUrl = `pglite:${join(root, "db")}`;
    await (await import("../src/db/migrate.js")).runMigrations(databaseUrl);
    const opened = await (
      await import("../src/db/client.js")
    ).createDb({
      databaseUrl,
      dataDir: root,
    });
    db = opened.db;
    close = opened.close;
    config = {
      dataDir: root,
      databaseUrl,
      secret: "space-migration-secret",
      publicBaseUrl: "http://localhost",
      internalBaseUrl: "http://localhost",
    } as AppConfig;

    const { agents, newId, spaces, tenants } =
      await import("../src/db/schema.js");
    tenantId = newId();
    settingsSpaceId = newId();
    settingsOldAgentId = newId();
    settingsNewAgentId = newId();
    rollbackSpaceId = newId();
    rollbackOldAgentId = newId();
    rollbackNewAgentId = newId();
    failedWorkspaceSpaceId = newId();
    failedWorkspaceOldAgentId = newId();
    failedWorkspaceNewAgentId = newId();
    occupiedSpaceId = newId();
    occupiedAgentId = newId();
    await db
      .insert(tenants)
      .values({ id: tenantId, name: "Migration", slug: "migration" });

    const oldTime = new Date("2025-01-01T00:00:00.000Z");
    const newTime = new Date("2025-02-01T00:00:00.000Z");
    await db.insert(spaces).values([
      {
        id: settingsSpaceId,
        tenantId,
        name: "Settings",
        slug: "settings",
        configJson: JSON.stringify({ custom: "keep" }),
      },
      {
        id: failedWorkspaceSpaceId,
        tenantId,
        name: "Failed workspace",
        slug: "failed-workspace",
        configJson: JSON.stringify({ acp: {}, mcp: {} }),
      },
      {
        id: occupiedSpaceId,
        tenantId,
        name: "Occupied workspace",
        slug: "occupied-workspace",
        configJson: JSON.stringify({ acp: {}, mcp: {} }),
      },
    ]);
    await db.insert(agents).values([
      {
        id: settingsOldAgentId,
        tenantId,
        spaceId: settingsSpaceId,
        name: "Settings old",
        slug: "settings-old",
        configJson: JSON.stringify({
          acp: { runner: "old" },
          providers: {
            mcp: { mode: "all", instanceIds: [] },
            other: "old-provider",
          },
          private: "old",
        }),
        createdAt: oldTime,
        updatedAt: oldTime,
      },
      {
        id: settingsNewAgentId,
        tenantId,
        spaceId: settingsSpaceId,
        name: "Settings new",
        slug: "settings-new",
        configJson: JSON.stringify({
          acp: { runner: "new" },
          providers: {
            mcp: { mode: "selected", instanceIds: ["instance-new"] },
            other: "new-provider",
          },
          private: "new",
        }),
        createdAt: newTime,
        updatedAt: newTime,
      },
      {
        id: failedWorkspaceOldAgentId,
        tenantId,
        spaceId: failedWorkspaceSpaceId,
        name: "Workspace old",
        slug: "workspace-old",
        createdAt: oldTime,
        updatedAt: oldTime,
      },
      {
        id: failedWorkspaceNewAgentId,
        tenantId,
        spaceId: failedWorkspaceSpaceId,
        name: "Workspace new",
        slug: "workspace-new",
        createdAt: newTime,
        updatedAt: newTime,
      },
      {
        id: occupiedAgentId,
        tenantId,
        spaceId: occupiedSpaceId,
        name: "Occupied",
        slug: "occupied",
      },
    ]);
  });

  after(async () => {
    await close?.();
    rmSync(root, { recursive: true, force: true });
  });

  function legacyWorkspace(agentId: string): string {
    return join(root, "agents", agentId, "workspace");
  }

  function writeWorkspaceFile(
    agentId: string,
    relativePath: string,
    contents: string,
  ): void {
    const path = join(legacyWorkspace(agentId), relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, contents);
  }

  it("moves settings transactionally with deterministic precedence and concurrent idempotency", async () => {
    const messages: string[] = [];
    await Promise.all([
      migrateAgentSettingsToSpaces(db, (message) => messages.push(message)),
      migrateAgentSettingsToSpaces(db, (message) => messages.push(message)),
    ]);

    const { agents, spaces } = await import("../src/db/schema.js");
    const [space] = await db
      .select()
      .from(spaces)
      .where(eq(spaces.id, settingsSpaceId));
    assert.deepEqual(JSON.parse(space!.configJson), {
      custom: "keep",
      acp: { runner: "new" },
      mcp: { mode: "selected", instanceIds: ["instance-new"] },
    });
    const rows = await db
      .select()
      .from(agents)
      .where(eq(agents.spaceId, settingsSpaceId));
    const byId = new Map(rows.map((row) => [row.id, row]));
    assert.deepEqual(JSON.parse(byId.get(settingsOldAgentId)!.configJson), {
      providers: { other: "old-provider" },
      private: "old",
    });
    assert.deepEqual(JSON.parse(byId.get(settingsNewAgentId)!.configJson), {
      providers: { other: "new-provider" },
      private: "new",
    });
    assert.equal(
      messages.filter((message) => message === "acp → space settings").length,
      1,
    );

    const timestamps = [
      space!.updatedAt.getTime(),
      byId.get(settingsOldAgentId)!.updatedAt.getTime(),
      byId.get(settingsNewAgentId)!.updatedAt.getTime(),
    ];
    await migrateAgentSettingsToSpaces(db, () =>
      assert.fail("idempotent run must not log"),
    );
    const [again] = await db
      .select()
      .from(spaces)
      .where(eq(spaces.id, settingsSpaceId));
    const againRows = await db
      .select()
      .from(agents)
      .where(eq(agents.spaceId, settingsSpaceId));
    const againById = new Map(againRows.map((row) => [row.id, row]));
    assert.deepEqual(
      [
        again!.updatedAt.getTime(),
        againById.get(settingsOldAgentId)!.updatedAt.getTime(),
        againById.get(settingsNewAgentId)!.updatedAt.getTime(),
      ],
      timestamps,
    );
  });

  it("rolls back Space and Agent rows together when an Agent write fails", async () => {
    const { agents, spaces } = await import("../src/db/schema.js");
    const oldTime = new Date("2025-01-01T00:00:00.000Z");
    const newTime = new Date("2025-02-01T00:00:00.000Z");
    await db.insert(spaces).values({
      id: rollbackSpaceId,
      tenantId,
      name: "Rollback",
      slug: "rollback",
      configJson: JSON.stringify({ custom: "rollback" }),
    });
    await db.insert(agents).values([
      {
        id: rollbackOldAgentId,
        tenantId,
        spaceId: rollbackSpaceId,
        name: "Rollback old",
        slug: "rollback-old",
        configJson: JSON.stringify({ acp: { runner: "old" }, private: "old" }),
        createdAt: oldTime,
        updatedAt: oldTime,
      },
      {
        id: rollbackNewAgentId,
        tenantId,
        spaceId: rollbackSpaceId,
        name: "Rollback new",
        slug: "rollback-new",
        configJson: JSON.stringify({
          acp: { runner: "new" },
          providers: { mcp: { mode: "selected", instanceIds: ["rollback"] } },
          private: "new",
        }),
        createdAt: newTime,
        updatedAt: newTime,
      },
    ]);
    const [beforeSpace] = await db
      .select()
      .from(spaces)
      .where(eq(spaces.id, rollbackSpaceId));
    const beforeAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.spaceId, rollbackSpaceId));
    let writes = 0;
    await assert.rejects(
      migrateAgentSettingsToSpaces(db, () => undefined, {
        beforeAgentWrite: () => {
          writes += 1;
          if (writes === 2) throw new Error("injected Agent write failure");
        },
      }),
      /injected Agent write failure/,
    );

    const [failedSpace] = await db
      .select()
      .from(spaces)
      .where(eq(spaces.id, rollbackSpaceId));
    const failedAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.spaceId, rollbackSpaceId));
    assert.equal(failedSpace!.configJson, beforeSpace!.configJson);
    assert.deepEqual(
      failedAgents.map((row) => [row.id, row.configJson]).sort(),
      beforeAgents.map((row) => [row.id, row.configJson]).sort(),
    );

    await migrateAgentSettingsToSpaces(db, () => undefined);
    const [recovered] = await db
      .select()
      .from(spaces)
      .where(eq(spaces.id, rollbackSpaceId));
    const recoveredAgents = await db
      .select()
      .from(agents)
      .where(eq(agents.spaceId, rollbackSpaceId));
    assert.equal("acp" in JSON.parse(recovered!.configJson), true);
    assert.ok(
      recoveredAgents.every((row) => !("acp" in JSON.parse(row.configJson))),
    );
  });

  it("atomically merges newest-first and preserves both legacy sources on repeated starts", async () => {
    writeWorkspaceFile(settingsOldAgentId, "conflict.txt", "old");
    writeWorkspaceFile(settingsOldAgentId, "old-only.txt", "old-only");
    writeWorkspaceFile(settingsNewAgentId, "conflict.txt", "new");
    writeWorkspaceFile(settingsNewAgentId, "nested/new-only.txt", "new-only");
    const messages: string[] = [];
    await Promise.all([
      migrateAgentWorkspacesToSpaces(db, config, (message) =>
        messages.push(message),
      ),
      migrateAgentWorkspacesToSpaces(db, config, (message) =>
        messages.push(message),
      ),
    ]);

    const target = spaceWorkspaceHostPath(config, settingsSpaceId);
    assert.equal(readFileSync(join(target, "conflict.txt"), "utf8"), "new");
    assert.equal(
      readFileSync(join(target, "old-only.txt"), "utf8"),
      "old-only",
    );
    assert.equal(
      readFileSync(join(target, "nested/new-only.txt"), "utf8"),
      "new-only",
    );
    assert.equal(
      messages.filter((message) =>
        message.includes("workspace → space settings"),
      ).length,
      1,
    );
    assert.equal(
      existsSync(join(legacyWorkspace(settingsOldAgentId), "old-only.txt")),
      true,
    );
    assert.equal(
      existsSync(join(legacyWorkspace(settingsNewAgentId), "conflict.txt")),
      true,
    );

    writeWorkspaceFile(settingsNewAgentId, "conflict.txt", "changed legacy");
    await migrateAgentWorkspacesToSpaces(db, config, () =>
      assert.fail("occupied target must skip"),
    );
    assert.equal(readFileSync(join(target, "conflict.txt"), "utf8"), "new");
  });

  it("cleans a failed staging copy, retries cleanly, and never overwrites an occupied target", async () => {
    writeWorkspaceFile(failedWorkspaceOldAgentId, "old.txt", "old");
    writeWorkspaceFile(failedWorkspaceNewAgentId, "new.txt", "new");
    let copies = 0;
    const failures: string[] = [];
    await migrateAgentWorkspacesToSpaces(
      db,
      config,
      (message) => failures.push(message),
      {
        copyDirectory: (source, target) => {
          copies += 1;
          if (copies === 2) throw new Error("injected copy failure");
          cpSync(source, target, {
            recursive: true,
            force: false,
            errorOnExist: false,
          });
        },
      },
    );
    const failedTarget = spaceWorkspaceHostPath(config, failedWorkspaceSpaceId);
    assert.equal(existsSync(failedTarget), false);
    assert.equal(
      failures.some((message) => message.includes("injected copy failure")),
      true,
    );
    const failedParent = dirname(failedTarget);
    assert.equal(
      readdirSync(failedParent).some((name) =>
        name.startsWith(`.workspace-migration-${failedWorkspaceSpaceId}-`),
      ),
      false,
    );

    await migrateAgentWorkspacesToSpaces(db, config, () => undefined);
    assert.equal(readFileSync(join(failedTarget, "new.txt"), "utf8"), "new");
    assert.equal(readFileSync(join(failedTarget, "old.txt"), "utf8"), "old");

    writeWorkspaceFile(occupiedAgentId, "legacy.txt", "legacy");
    const occupiedTarget = spaceWorkspaceHostPath(config, occupiedSpaceId);
    mkdirSync(occupiedTarget, { recursive: true });
    writeFileSync(join(occupiedTarget, "existing.txt"), "existing");
    await migrateAgentWorkspacesToSpaces(db, config, () =>
      assert.fail("occupied target must skip"),
    );
    assert.equal(
      readFileSync(join(occupiedTarget, "existing.txt"), "utf8"),
      "existing",
    );
    assert.equal(existsSync(join(occupiedTarget, "legacy.txt")), false);
    assert.equal(
      existsSync(join(legacyWorkspace(occupiedAgentId), "legacy.txt")),
      true,
    );
  });
});
