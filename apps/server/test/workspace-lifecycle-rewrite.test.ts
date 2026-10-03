import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, ne } from "drizzle-orm";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import {
  agents,
  managedContainers,
  newId,
  runtimeNodes,
  tenants,
} from "../src/db/schema.js";
import { AgentService } from "../src/services/agents.js";

const SCRATCH = process.env.GROK_SCRATCH || tmpdir();

describe("Space-owned workspace lifecycle rewrite", () => {
  let root = "";
  let db: Db;
  let close: () => Promise<void>;
  let config: AppConfig;
  let service: AgentService;
  let tenantId = "";
  let nodeId = "";
  let nodes: { requireRunnerClient: () => Promise<{ client: any; node: any }> };
  const remote = new Map<string, Record<string, any>>();
  const starts: string[] = [];
  const stops: string[] = [];
  const failStops = new Set<string>();

  before(async () => {
    process.env.REDIS_URL = "off";
    root = mkdtempSync(join(SCRATCH, "zakura-workspace-lifecycle-"));
    const databaseUrl = `pglite:${join(root, "db")}`;
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(databaseUrl);
    const created = await (await import("../src/db/client.js")).createDb({ databaseUrl, dataDir: root });
    db = created.db;
    close = created.close;
    config = {
      dataDir: root,
      databaseUrl,
      secret: "workspace-lifecycle",
      publicBaseUrl: "http://localhost",
      internalBaseUrl: "http://localhost",
    } as AppConfig;

    tenantId = newId();
    nodeId = newId();
    const now = new Date();
    await db.insert(tenants).values({ id: tenantId, name: "Lifecycle", slug: "lifecycle" });
    await db.insert(runtimeNodes).values({
      id: nodeId,
      tenantId,
      name: "Fake runner",
      slug: "fake-runner",
      kind: "computer",
      status: "online",
      endpoint: "http://runner.test",
      capabilitiesJson: JSON.stringify({ docker: true, host: true }),
      hostInfoJson: "{}",
      storageRoot: "/tmp/fake",
      tokenHash: "fake-hash",
      labelsJson: "{}",
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const client = {
      ping: async () => ({ ok: true, docker: { ok: true, version: "fake" } }),
      getWorkspace: async (spaceId: string) => remote.get(spaceId) ?? null,
      startWorkspace: async (input: { spaceId: string; image: string }) => {
        starts.push(input.spaceId);
        const state = {
          dockerId: `ctr-${input.spaceId}`,
          name: `ws-${input.spaceId}`,
          image: input.image,
          status: "running",
          endpoints: {},
          labels: { "zakura.space": input.spaceId },
          ports: [],
        };
        remote.set(input.spaceId, state);
        return state;
      },
      stopWorkspace: async (spaceId: string) => {
        stops.push(spaceId);
        if (failStops.has(spaceId)) throw new Error("runner stop interrupted");
        remote.delete(spaceId);
      },
      execWorkspace: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      mkdir: async () => ({}),
    };
    nodes = {
      requireRunnerClient: async () => ({ client, node: { id: nodeId, status: "online", name: "Fake" } }),
    };
    service = new AgentService(db, {} as never, config, nodes as never);
  });

  after(async () => {
    await close?.();
    rmSync(root, { recursive: true, force: true });
  });

  it("reuses a Space computer across sibling agents and isolates other Spaces", async () => {
    const firstSpace = await service.spaces.create(tenantId, { name: "First" });
    const secondSpace = await service.spaces.create(tenantId, { name: "Second" });
    await service.spaces.update(tenantId, firstSpace.id, { runtimeNodeId: nodeId, enableComputer: true });
    await service.spaces.update(tenantId, secondSpace.id, { runtimeNodeId: nodeId, enableComputer: true });
    const a = (await service.create(tenantId, { name: "A", spaceId: firstSpace.id, createApiKey: false })).agent;
    const sibling = (await service.create(tenantId, { name: "Sibling", spaceId: firstSpace.id, createApiKey: false })).agent;
    const other = (await service.create(tenantId, { name: "Other", spaceId: secondSpace.id, createApiKey: false })).agent;

    await service.workspace.ensureStarted(a, { require: "shell" });
    await service.workspace.ensureStarted(sibling, { require: "shell" });
    await service.workspace.ensureStarted(other, { require: "shell" });
    assert.deepEqual(starts, [firstSpace.id, secondSpace.id]);

    const active = await db.select().from(managedContainers).where(
      and(eq(managedContainers.purpose, "workspace"), ne(managedContainers.status, "removed")),
    );
    assert.equal(active.length, 2);
    assert.deepEqual(new Set(active.map((row) => row.spaceId)), new Set([firstSpace.id, secondSpace.id]));

    await service.remove(tenantId, a.id);
    assert.equal(stops.length, 0, "deleting one agent must not stop its sibling's Space computer");
    assert.equal(remote.get(firstSpace.id)?.status, "running");
    assert.ok(await service.get(tenantId, sibling.id));
  });

  it("preserves recoverable state on interrupted stop and deletes only after cleanup succeeds", async () => {
    const targetSpace = (await service.spaces.list(tenantId)).find((row) => row.slug === "first")!;
    const sibling = (await service.list(tenantId, { spaceId: targetSpace.id }))[0]!;
    failStops.add(targetSpace.id);
    await assert.rejects(service.stop(tenantId, sibling.id), /runner stop interrupted/);
    assert.equal((await service.workspace.getWorkspaceContainer(targetSpace.id))?.status, "running");
    assert.match((await service.spaces.get(tenantId, targetSpace.id))?.lastError ?? "", /interrupted/);

    await assert.rejects(service.spaces.delete(tenantId, targetSpace.id), /runner stop interrupted/);
    assert.ok(await service.spaces.get(tenantId, targetSpace.id), "failed cleanup keeps the Space retryable");
    assert.ok(await service.get(tenantId, sibling.id), "failed cleanup does not cascade agents");

    failStops.delete(targetSpace.id);
    assert.equal(await service.spaces.delete(tenantId, targetSpace.id), true);
    assert.equal(await service.spaces.get(tenantId, targetSpace.id), null);
    assert.equal(await db.query.agents.findFirst({ where: eq(agents.id, sibling.id) }), undefined);
    assert.equal(remote.has(targetSpace.id), false);
  });

  it("excludes the current Space allocation from repeated-start shared-runner quota", async () => {
    const { assertSharedRunnerQuota } = await import("../src/services/runner-access.js");
    const remaining = (await service.spaces.list(tenantId)).find((row) => row.slug === "second")!;
    await assert.rejects(
      assertSharedRunnerQuota(db, { nodeId, tenantId }),
      /每租户同时最多/,
    );
    await assert.doesNotReject(
      assertSharedRunnerQuota(db, {
        nodeId,
        tenantId,
        excludeAllocationId: remaining.id,
      }),
    );
  });

});
