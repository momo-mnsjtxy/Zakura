import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { CloudAgentQueuedMessage } from "@zakura/shared";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import { newId, runtimeNodes, tenants, users } from "../src/db/schema.js";
import { AgentTenantLifecycleService } from "../src/services/agent-tenant-lifecycle.js";
import { AgentService } from "../src/services/agents.js";
import { CloudAgentSessionStore } from "../src/services/cloud-agent-session.js";

const queued = (messageId: string): CloudAgentQueuedMessage => ({
  messageId,
  content: messageId,
  attachments: [],
  mode: "queue",
  createdAt: new Date().toISOString(),
});

async function eventually(check: () => Promise<boolean>, message: string, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail(message);
}

describe("Agent tenant lifecycle seam", () => {
  let root = "";
  let db: Db;
  let close: () => Promise<void>;
  let agentsService: AgentService;
  let sessions: CloudAgentSessionStore;
  let lifecycle: AgentTenantLifecycleService;
  const remote = new Map<string, Record<string, unknown>>();
  const stops: string[] = [];
  const failedStops = new Set<string>();

  before(async () => {
    process.env.REDIS_URL = "off";
    root = mkdtempSync(join(tmpdir(), "zakura-agent-tenant-lifecycle-"));
    const databaseUrl = `pglite:${join(root, "db")}`;
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(databaseUrl);
    const created = await (await import("../src/db/client.js")).createDb({ databaseUrl, dataDir: root });
    db = created.db;
    close = created.close;
    const config = {
      dataDir: root,
      databaseUrl,
      secret: "agent-tenant-lifecycle",
      publicBaseUrl: "http://localhost",
      internalBaseUrl: "http://localhost",
    } as AppConfig;
    const client = {
      ping: async () => ({ ok: true, docker: { ok: true, version: "fake" } }),
      getWorkspace: async (spaceId: string) => remote.get(spaceId) ?? null,
      startWorkspace: async (input: { spaceId: string; image: string }) => {
        const state = {
          dockerId: `ctr-${input.spaceId}`,
          name: `ws-${input.spaceId}`,
          image: input.image,
          status: "running",
          endpoints: {}, labels: {}, ports: [],
        };
        remote.set(input.spaceId, state);
        return state;
      },
      stopWorkspace: async (spaceId: string) => {
        stops.push(spaceId);
        if (failedStops.has(spaceId)) throw new Error("fake runner stop failed");
        remote.delete(spaceId);
      },
      execWorkspace: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      mkdir: async () => ({}),
    };
    const nodes = {
      requireRunnerClient: async (_tenantId: string, nodeId: string) => ({
        client,
        node: { id: nodeId, status: "online", name: "Fake runner" },
      }),
    };
    agentsService = new AgentService(db, {} as never, config, nodes as never);
    sessions = new CloudAgentSessionStore(db);
    lifecycle = new AgentTenantLifecycleService(db, agentsService.workspace, sessions);
  });

  after(async () => {
    await close?.();
    rmSync(root, { recursive: true, force: true });
  });

  async function createTopology(label: string, spaceCount = 1) {
    const tenantId = newId();
    const ownerId = newId();
    const memberId = newId();
    const nodeId = newId();
    const now = new Date();
    await db.insert(tenants).values({ id: tenantId, name: label, slug: `${label}-${tenantId}` });
    await db.insert(users).values([
      { id: ownerId, email: `${label}-owner-${ownerId}@example.test` },
      { id: memberId, email: `${label}-member-${memberId}@example.test` },
    ]);
    await db.insert(runtimeNodes).values({
      id: nodeId,
      tenantId,
      name: `${label} runner`,
      slug: `${label}-runner`,
      kind: "computer",
      status: "online",
      endpoint: "http://runner.test",
      capabilitiesJson: JSON.stringify({ docker: true }),
      hostInfoJson: "{}",
      storageRoot: "/tmp/fake",
      tokenHash: `hash-${nodeId}`,
      labelsJson: "{}",
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const topology: Array<{ spaceId: string; agentId: string }> = [];
    for (let index = 0; index < spaceCount; index += 1) {
      const space = await agentsService.spaces.create(tenantId, { name: `${label} space ${index}` });
      await agentsService.spaces.update(tenantId, space.id, { runtimeNodeId: nodeId, enableComputer: true });
      const created = await agentsService.create(tenantId, {
        name: `${label} agent ${index}`,
        spaceId: space.id,
        createApiKey: false,
      });
      await agentsService.workspace.ensureStarted(created.agent, { require: "shell" });
      topology.push({ spaceId: space.id, agentId: created.agent.id });
    }
    return { tenantId, ownerId, memberId, nodeId, topology };
  }

  async function finishOnCancel(sessionId: string, runId: string) {
    let resolve!: () => void;
    const finished = new Promise<void>((done) => { resolve = done; });
    const unsubscribe = sessions.onRunCancel(runId, () => {
      void sessions.finishRun(sessionId, runId, "cancelled").then(resolve);
    });
    return { finished, unsubscribe };
  }

  it("drains every Agent, stops every Space and holds an idempotent delete lease", async () => {
    const ctx = await createTopology("delete", 2);
    const primary = ctx.topology[0]!;
    const session = await sessions.createSession({
      tenantId: ctx.tenantId,
      agentId: primary.agentId,
      createdByUserId: ctx.ownerId,
    });
    const run = await sessions.createRun(session.id);
    const cancelled = await finishOnCancel(session.id, run.id);
    await sessions.enqueueQueued(session.id, queued("delete-queued"));

    const lease = await lifecycle.callbacks().beginTenantDelete(ctx.tenantId);
    await cancelled.finished;
    assert.deepEqual(
      new Set(stops.filter((spaceId) => ctx.topology.some((item) => item.spaceId === spaceId))),
      new Set(ctx.topology.map((item) => item.spaceId)),
    );
    assert.ok(ctx.topology.every((item) => !remote.has(item.spaceId)));
    assert.equal((await sessions.getRun(run.id))?.status, "cancelled");
    assert.deepEqual(await sessions.listQueued(session.id), []);
    await assert.rejects(
      sessions.createSession({ tenantId: ctx.tenantId, agentId: primary.agentId }),
      /Agent 正在删除/,
    );

    // Simulate the tenant DB transaction failing: the aggregate remains usable.
    await lease.finish(false);
    await lease.finish(false);
    await assert.doesNotReject(
      sessions.createSession({ tenantId: ctx.tenantId, agentId: primary.agentId }),
    );
    cancelled.unsubscribe();
  });

  it("releases admission automatically when one fake runner cannot stop", async () => {
    const ctx = await createTopology("failure");
    const target = ctx.topology[0]!;
    failedStops.add(target.spaceId);
    await assert.rejects(
      lifecycle.callbacks().beginTenantDelete(ctx.tenantId),
      /fake runner stop failed/,
    );
    await assert.doesNotReject(
      sessions.createSession({ tenantId: ctx.tenantId, agentId: target.agentId }),
    );
    assert.equal(remote.has(target.spaceId), true);
    failedStops.delete(target.spaceId);
  });

  it("allows an idempotent delete lease release to retry after a transient failure", async () => {
    let releases = 0;
    const retrying = new AgentTenantLifecycleService(
      db,
      { removeSpaceWorkspace: async () => {} },
      {
        beginAgentDeletionDrain: async () => async () => {
          releases += 1;
          if (releases === 1) throw new Error("release interrupted");
        },
        beginMemberSessionDrain: async () => async () => {},
      },
    );
    const lease = await retrying.callbacks().beginTenantDelete(newId());
    await assert.rejects(lease.finish(false), /release interrupted/);
    await assert.doesNotReject(lease.finish(false));
    await lease.finish(false);
    assert.equal(releases, 2, "successful release remains idempotent after retry");
  });

  it("suspension drains all tenant sessions and stops workspaces without deleting rows", async () => {
    const ctx = await createTopology("suspend");
    const target = ctx.topology[0]!;
    const session = await sessions.createSession({
      tenantId: ctx.tenantId,
      agentId: target.agentId,
      createdByUserId: ctx.ownerId,
    });
    const run = await sessions.createRun(session.id);
    const cancelled = await finishOnCancel(session.id, run.id);

    await lifecycle.callbacks().suspendTenant(ctx.tenantId);
    await cancelled.finished;
    assert.equal((await sessions.getRun(run.id))?.status, "cancelled");
    assert.equal(remote.has(target.spaceId), false);
    assert.ok(await agentsService.get(ctx.tenantId, target.agentId));
    assert.ok(await sessions.getSession(ctx.tenantId, target.agentId, session.id));
    // The surrounding tenant auth gate owns continued suspension enforcement.
    await assert.doesNotReject(
      sessions.createSession({ tenantId: ctx.tenantId, agentId: target.agentId }),
    );
    cancelled.unsubscribe();
  });

  it("member revocation drains only that creator and leaves the shared computer running", async () => {
    const ctx = await createTopology("member");
    const target = ctx.topology[0]!;
    const revokedSession = await sessions.createSession({
      tenantId: ctx.tenantId,
      agentId: target.agentId,
      createdByUserId: ctx.memberId,
    });
    const ownerSession = await sessions.createSession({
      tenantId: ctx.tenantId,
      agentId: target.agentId,
      createdByUserId: ctx.ownerId,
    });
    const revokedRun = await sessions.createRun(revokedSession.id);
    const ownerRun = await sessions.createRun(ownerSession.id);
    await sessions.enqueueQueued(revokedSession.id, queued("revoked-queued"));
    await sessions.enqueueQueued(ownerSession.id, queued("owner-queued"));

    let allowFinish!: () => void;
    const finishGate = new Promise<void>((resolve) => { allowFinish = resolve; });
    let cancelFinished!: () => void;
    const cancelDone = new Promise<void>((resolve) => { cancelFinished = resolve; });
    const unsubscribe = sessions.onRunCancel(revokedRun.id, () => {
      void (async () => {
        await finishGate;
        await sessions.finishRun(revokedSession.id, revokedRun.id, "cancelled");
        cancelFinished();
      })();
    });

    const draining = lifecycle.callbacks().revokeMember(ctx.tenantId, ctx.memberId);
    await eventually(
      () => sessions.isCancelRequested(revokedRun.id),
      "revoked member's run was not cancelled",
    );
    await assert.rejects(
      sessions.createSession({
        tenantId: ctx.tenantId,
        agentId: target.agentId,
        createdByUserId: ctx.memberId,
      }),
      /成员访问正在撤销/,
    );
    await assert.doesNotReject(
      sessions.createSession({
        tenantId: ctx.tenantId,
        agentId: target.agentId,
        createdByUserId: ctx.ownerId,
      }),
    );
    assert.equal(await sessions.isCancelRequested(ownerRun.id), false);
    assert.equal(remote.has(target.spaceId), true);

    allowFinish();
    await draining;
    await cancelDone;
    assert.equal((await sessions.getRun(revokedRun.id))?.status, "cancelled");
    assert.equal((await sessions.getRun(ownerRun.id))?.status, "queued");
    assert.deepEqual(await sessions.listQueued(revokedSession.id), []);
    assert.deepEqual((await sessions.listQueued(ownerSession.id)).map((item) => item.messageId), ["owner-queued"]);
    assert.equal(remote.has(target.spaceId), true);
    await assert.doesNotReject(
      sessions.createSession({
        tenantId: ctx.tenantId,
        agentId: target.agentId,
        createdByUserId: ctx.memberId,
      }),
    );
    await sessions.finishRun(ownerSession.id, ownerRun.id, "cancelled");
    unsubscribe();
  });
});
