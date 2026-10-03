import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import { newId, runtimeNodes, tenantMemberships, tenants, users } from "../src/db/schema.js";
import { createApiApp } from "../src/api/routes.js";
import { AgentService } from "../src/services/agents.js";
import { signSession } from "../src/services/auth.js";
import { OauthService } from "../src/services/oauth.js";
import { CloudAgentSessionStore } from "../src/services/cloud-agent-session.js";

describe("authenticated Space lifecycle API", () => {
  let root = "";
  let db: Db;
  let close: () => Promise<void>;
  let app: Awaited<ReturnType<typeof createApiApp>>;
  let headers: Record<string, string>;
  let nodeId = "";
  const remote = new Map<string, Record<string, any>>();
  const starts: string[] = [];

  before(async () => {
    process.env.REDIS_URL = "off";
    root = mkdtempSync(join(tmpdir(), "zakura-space-api-lifecycle-"));
    const databaseUrl = `pglite:${join(root, "db")}`;
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(databaseUrl);
    const created = await (await import("../src/db/client.js")).createDb({ databaseUrl, dataDir: root });
    db = created.db;
    close = created.close;
    const tenantId = newId();
    const userId = newId();
    nodeId = newId();
    const now = new Date();
    await db.insert(tenants).values({ id: tenantId, name: "API", slug: "api-lifecycle" });
    await db.insert(users).values({ id: userId, email: "api-lifecycle@example.test" });
    await db.insert(tenantMemberships).values({ tenantId, userId, role: "owner", status: "active" });
    await db.insert(runtimeNodes).values({
      id: nodeId,
      tenantId,
      name: "API runner",
      slug: "api-runner",
      kind: "computer",
      status: "online",
      endpoint: "http://runner.test",
      capabilitiesJson: JSON.stringify({ docker: true }),
      hostInfoJson: "{}",
      storageRoot: "/tmp/fake",
      tokenHash: "fake-hash",
      labelsJson: "{}",
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });
    const config = {
      dataDir: root,
      databaseUrl,
      secret: "api-lifecycle-secret",
      publicBaseUrl: "http://localhost",
      internalBaseUrl: "http://localhost",
      multiTenant: true,
    } as AppConfig;
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
          labels: {},
          ports: [],
        };
        remote.set(input.spaceId, state);
        return state;
      },
      stopWorkspace: async (spaceId: string) => { remote.delete(spaceId); },
      execWorkspace: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      mkdir: async () => ({}),
    };
    const nodes = {
      requireRunnerClient: async () => ({ client, node: { id: nodeId, status: "online", name: "API runner" } }),
    };
    const agents = new AgentService(db, {} as never, config, nodes as never);
    app = await createApiApp({
      db,
      config,
      agentService: agents,
      orchestrator: {} as never,
      gateway: {} as never,
      runtime: {} as never,
      memoryStore: {} as never,
      memoryProviders: {} as never,
      toolCallStore: {} as never,
      oauth: new OauthService(db, config),
      runtimeNodes: nodes as never,
      cloudSessionStore: new CloudAgentSessionStore(db),
    });
    const token = signSession(config.secret, {
      userId,
      tenantId,
      email: "api-lifecycle@example.test",
      role: "owner",
    });
    headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
  });

  after(async () => {
    await close?.();
    rmSync(root, { recursive: true, force: true });
  });

  it("creates, starts repeatedly, reports the Space container, and cleans up on delete", async () => {
    const createdSpace = await app.request("/api/spaces", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "HTTP Lifecycle" }),
    });
    assert.equal(createdSpace.status, 201, await createdSpace.clone().text());
    const space = await createdSpace.json() as { id: string };
    const createdAgent = await app.request("/api/agents", {
      method: "POST",
      headers,
      body: JSON.stringify({ name: "HTTP Agent", spaceId: space.id, createApiKey: false }),
    });
    assert.equal(createdAgent.status, 201, await createdAgent.clone().text());
    const agent = await createdAgent.json() as { id: string };

    for (let i = 0; i < 2; i++) {
      const started = await app.request(`/api/agents/${agent.id}/start`, {
        method: "POST",
        headers,
        body: JSON.stringify({ runtimeNodeId: nodeId }),
      });
      assert.equal(started.status, 200, await started.clone().text());
      const body = await started.json() as { workspace?: { dockerId?: string } };
      assert.equal(body.workspace?.dockerId, `ctr-${space.id}`);
    }
    assert.deepEqual(starts, [space.id]);

    const progress = await app.request(`/api/agents/${agent.id}/progress`, { headers });
    assert.equal(progress.status, 200);
    assert.equal(((await progress.json()) as any).workspace.dockerId, `ctr-${space.id}`);

    const removed = await app.request(`/api/spaces/${space.id}`, { method: "DELETE", headers });
    assert.equal(removed.status, 200, await removed.clone().text());
    assert.equal(remote.has(space.id), false);
  });
});
