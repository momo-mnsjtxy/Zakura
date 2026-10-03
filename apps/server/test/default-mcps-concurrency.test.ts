import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { encryptJson } from "@zakura/core";
import { DEFAULT_AGENT_AUTO_INSTALL_MCPS } from "@zakura/shared";
import { ensureTestSpace } from "./helpers/spaces.js";
import {
  bindDefaultMcpsToAgentDetailed,
  ensureDefaultAgentMcps,
} from "../src/services/default-mcps.js";

describe("default MCP reconciliation", () => {
  let dataDir = "";
  let db: import("../src/db/client.js").Db;
  let close: () => Promise<void>;
  let tenantId = "";
  let spaceId = "";
  let agentId = "";
  const secret = "default-mcp-test-secret-32-bytes";

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "zakura-default-mcp-race-"));
    const databaseUrl = `pglite:${join(dataDir, "pglite")}`;
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(databaseUrl);
    const { createDb } = await import("../src/db/client.js");
    const opened = await createDb({ databaseUrl, dataDir });
    db = opened.db;
    close = opened.close;
    const { agents, newId, providerCatalog, tenants } = await import("../src/db/schema.js");
    tenantId = newId();
    agentId = newId();
    const now = new Date();
    await db.insert(tenants).values({
      id: tenantId,
      slug: `defaults-${tenantId}`,
      name: "Defaults",
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(providerCatalog).values({ id: "generic-mcp", name: "Generic MCP" });
    spaceId = await ensureTestSpace(db, tenantId, { enableComputer: false });
    await db.insert(agents).values({
      id: agentId,
      tenantId,
      spaceId,
      name: "Agent",
      slug: `agent-${agentId}`,
      configJson: "{}",
      createdAt: now,
      updatedAt: now,
    });
  });

  after(async () => {
    await close?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("single-flights callers and recovers the durable winner of an insert race", async () => {
    const { componentInstances, newId } = await import("../src/db/schema.js");
    let creates = 0;
    let starts = 0;
    const orchestrator = {
      createInstance: async (input: {
        tenantId: string;
        providerId: string;
        name: string;
        slug: string;
        config: Record<string, unknown>;
      }) => {
        creates += 1;
        await db.insert(componentInstances).values({
          id: newId(),
          tenantId: input.tenantId,
          providerId: input.providerId,
          name: input.name,
          slug: input.slug,
          status: "stopped",
          configEnc: encryptJson(secret, input.config),
          endpointUrl: String(input.config.mcpUrl),
        });
        throw new Error("simulated unique insert race");
      },
      startInstance: async (_tenantId: string, instanceId: string) => {
        starts += 1;
        await db.update(componentInstances).set({ status: "running", updatedAt: new Date() })
          .where(eq(componentInstances.id, instanceId));
      },
    };

    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        ensureDefaultAgentMcps(
          db,
          orchestrator as never,
          { secret } as never,
          tenantId,
        ),
      ),
    );
    assert.equal(creates, 1);
    assert.equal(starts, 1);
    assert.ok(results[0]!.length > 0);
    assert.equal(new Set(results.map((ids) => ids.join(","))).size, 1);
    const rows = await db.select().from(componentInstances).where(eq(componentInstances.tenantId, tenantId));
    assert.equal(rows.length, results[0]!.length);
    assert.ok(rows.every((row) => row.status === "running"));
  });

  it("deduplicates binding inputs and returns an aggregate reconciliation result", async () => {
    const { agentBindings, componentInstances } = await import("../src/db/schema.js");
    const [instance] = await db.select().from(componentInstances).where(eq(componentInstances.tenantId, tenantId));
    assert.ok(instance);
    const result = await bindDefaultMcpsToAgentDetailed(
      db,
      tenantId,
      spaceId,
      [instance.id, instance.id],
      agentId,
    );
    assert.deepEqual(result, { bound: [instance.id], failed: [] });
    const rows = await db.select().from(agentBindings).where(eq(agentBindings.tenantId, tenantId));
    assert.equal(rows.length, 1);
  });

  it("does not adopt a slug-colliding instance with a different endpoint", async () => {
    const { componentInstances, newId, tenants } = await import("../src/db/schema.js");
    const otherTenant = newId();
    const now = new Date();
    await db.insert(tenants).values({
      id: otherTenant,
      slug: `collision-${otherTenant}`,
      name: "Collision",
      createdAt: now,
      updatedAt: now,
    });
    const expected = DEFAULT_AGENT_AUTO_INSTALL_MCPS.find(
      (entry) => entry.kind === "http" && entry.mcpUrl,
    );
    assert.ok(expected);
    const [collision] = await db.insert(componentInstances).values({
      id: newId(),
      tenantId: otherTenant,
      providerId: "generic-mcp",
      name: "Unrelated",
      slug: expected.id,
      status: "running",
      endpointUrl: "https://unrelated.invalid/mcp",
      configEnc: encryptJson(secret, { mcpUrl: "https://unrelated.invalid/mcp" }),
    }).returning();
    let createdSlug = "";
    const orchestrator = {
      createInstance: async (input: {
        tenantId: string;
        providerId: string;
        name: string;
        slug: string;
        config: Record<string, unknown>;
      }) => {
        createdSlug = input.slug;
        const [row] = await db.insert(componentInstances).values({
          id: newId(),
          tenantId: input.tenantId,
          providerId: input.providerId,
          name: input.name,
          slug: input.slug,
          status: "running",
          endpointUrl: String(input.config.mcpUrl),
          configEnc: encryptJson(secret, input.config),
        }).returning();
        return row!;
      },
      startInstance: async () => undefined,
    };
    const ids = await ensureDefaultAgentMcps(
      db,
      orchestrator as never,
      { secret } as never,
      otherTenant,
    );
    assert.equal(ids.includes(collision!.id), false);
    assert.notEqual(createdSlug, expected.id);
    assert.equal(ids.length, 1);
  });
});
