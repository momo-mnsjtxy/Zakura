import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, describe, it } from "node:test";
import { ensureTestSpace } from "./helpers/spaces.js";

describe("memory store rewrite", () => {
  let dataDir = "";
  let databaseUrl = "";
  let db: import("../src/db/client.js").Db;
  let close: () => Promise<void>;
  let store: import("../src/services/memory-store.js").MemoryStore;
  let tenantA = "";
  let tenantB = "";
  let agentA = "";
  let agentB = "";
  let primaryId = "";

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "zakura-memory-rewrite-"));
    mkdirSync(dataDir, { recursive: true });
    databaseUrl = `pglite:${join(dataDir, "pglite")}`;
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(databaseUrl);
    const { createDb } = await import("../src/db/client.js");
    const created = await createDb({ databaseUrl, dataDir });
    db = created.db;
    close = created.close;

    const { agents, newId, tenants } = await import("../src/db/schema.js");
    tenantA = newId();
    tenantB = newId();
    agentA = newId();
    agentB = newId();
    const now = new Date();
    await db.insert(tenants).values([
      { id: tenantA, slug: `memory-a-${tenantA}`, name: "Memory A", isDefault: true, createdAt: now, updatedAt: now },
      { id: tenantB, slug: `memory-b-${tenantB}`, name: "Memory B", isDefault: false, createdAt: now, updatedAt: now },
    ]);
    const spaceA = await ensureTestSpace(db, tenantA, { enableComputer: false });
    const spaceB = await ensureTestSpace(db, tenantB, { enableComputer: false });
    await db.insert(agents).values([
      {
        id: agentA, spaceId: spaceA, tenantId: tenantA, name: "A", slug: `a-${agentA}`,
        description: "", status: "ready", enableFs: true, enableComputer: false,
        enableMemory: true, runtimeNodeId: null, workspaceStatus: "ready", configJson: "{}",
        createdAt: now, updatedAt: now,
      },
      {
        id: agentB, spaceId: spaceB, tenantId: tenantB, name: "B", slug: `b-${agentB}`,
        description: "", status: "ready", enableFs: true, enableComputer: false,
        enableMemory: true, runtimeNodeId: null, workspaceStatus: "ready", configJson: "{}",
        createdAt: now, updatedAt: now,
      },
    ]);
    const { MemoryStore } = await import("../src/services/memory-store.js");
    store = new MemoryStore(db);
  });

  after(async () => {
    await close?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("normalizes rows and enforces tenant/agent isolation", async () => {
    const primary = await store.add(tenantA, agentA, {
      content: "Project Alpha ships on Friday",
      layer: "project",
      tags: ["Launch", "launch", "  timeline  "],
      importance: 99,
      embedding: [1, 0],
      embeddingModel: "fake-2d",
    });
    primaryId = primary.id;
    assert.deepEqual(primary.tags, ["Launch", "timeline"]);
    assert.equal(primary.importance, 5);
    assert.equal(primary.embeddingDim, 2);

    await store.add(tenantB, agentB, {
      content: "Project Alpha belongs to another tenant",
      layer: "project",
      embedding: [1, 0],
      embeddingModel: "fake-2d",
    });
    const own = await store.search(tenantA, agentA, "Project Alpha", 10);
    assert.equal(own.length, 1);
    assert.equal(own[0]?.id, primaryId);
    assert.equal(await store.get(tenantB, agentB, primaryId), null);
  });

  it("does deterministic vector recall and weighted graph expansion", async () => {
    const unrelated = await store.add(tenantA, agentA, {
      content: "Remember the blue bicycle",
      layer: "fact",
      embedding: [0, 1],
      embeddingModel: "fake-2d",
    });
    const neighbor = await store.add(tenantA, agentA, {
      content: "Friday launch owner is Maya",
      layer: "fact",
    });
    const edge = await store.link(tenantA, agentA, primaryId, neighbor.id, "owner");
    const duplicate = await store.link(tenantA, agentA, primaryId, neighbor.id, " owner ");
    assert.equal(duplicate.id, edge.id);

    const recalled = await store.hybridSearch(tenantA, agentA, "no keyword hit", {
      queryEmbedding: [1, 0],
      limit: 2,
    });
    assert.equal(recalled.retrievalMode, "hybrid");
    assert.equal(recalled.results[0]?.id, primaryId);
    assert.ok(recalled.results.some((item) => item.id === neighbor.id), "graph neighbor included");
    assert.ok(!recalled.results.some((item) => item.id === unrelated.id));
  });

  it("rejects invalid updates/vectors and invalidates stale embeddings", async () => {
    await assert.rejects(
      () => store.update(tenantA, agentA, primaryId, { content: "   " }),
      /content required/,
    );
    await assert.rejects(
      () => store.setEmbedding(tenantA, agentA, primaryId, [Number.NaN, 1], "bad"),
      /non-finite/,
    );
    const updated = await store.update(tenantA, agentA, primaryId, {
      content: "Project Alpha now ships Monday",
    });
    assert.equal(updated.hasEmbedding, false);
    const stats = await store.embeddingStats(tenantA, agentA);
    assert.ok(stats.missing >= 2);
  });

  it("prevents cross-tenant graph links", async () => {
    const foreign = await store.add(tenantB, agentB, { content: "foreign", layer: "fact" });
    await assert.rejects(
      () => store.link(tenantA, agentA, primaryId, foreign.id),
      /Memory not found/,
    );
  });

  it("persists rows across a PGlite close/reopen", async () => {
    await close();
    const { createDb } = await import("../src/db/client.js");
    const reopened = await createDb({ databaseUrl, dataDir });
    db = reopened.db;
    close = reopened.close;
    const { MemoryStore } = await import("../src/services/memory-store.js");
    store = new MemoryStore(db);
    const persisted = await store.get(tenantA, agentA, primaryId);
    assert.equal(persisted?.content, "Project Alpha now ships Monday");
  });
});

