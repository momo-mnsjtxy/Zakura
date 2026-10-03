import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { LocalWorkspaceFs } from "@zakura/core";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import { agentSchedules, newId, tenants } from "../src/db/schema.js";
import { registerAgentFsRoutes } from "../src/api/agent-fs-routes.js";
import { AgentService } from "../src/services/agents.js";
import { CloudAgentSessionStore } from "../src/services/cloud-agent-session.js";
import { FileShareService } from "../src/services/file-shares.js";
import { getSpaceProject, upsertSpaceProject } from "../src/services/agent-projects.js";

const SCRATCH = process.env.GROK_SCRATCH || tmpdir();

describe("Space project and file-share collaboration routes", () => {
  let root = "";
  let db: Db;
  let close: () => Promise<void>;
  let tenantId = "";
  let agentA = "";
  let agentB = "";
  let spaceId = "";
  let app: Hono<any>;
  let fs: LocalWorkspaceFs;
  let shares: FileShareService;
  let sessions: CloudAgentSessionStore;
  let agentService: AgentService;

  before(async () => {
    process.env.REDIS_URL = "off";
    root = mkdtempSync(join(SCRATCH, "zakura-project-collab-"));
    const databaseUrl = `pglite:${join(root, "db")}`;
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(databaseUrl);
    const created = await (await import("../src/db/client.js")).createDb({ databaseUrl, dataDir: root });
    db = created.db;
    close = created.close;
    tenantId = newId();
    await db.insert(tenants).values({ id: tenantId, name: "Projects", slug: "projects" });
    const config = {
      dataDir: root,
      databaseUrl,
      secret: "project-collab",
      publicBaseUrl: "http://localhost",
      internalBaseUrl: "http://localhost",
    } as AppConfig;
    agentService = new AgentService(db, {} as never, config);
    const space = await agentService.spaces.create(tenantId, { name: "Shared" });
    spaceId = space.id;
    await agentService.spaces.update(tenantId, space.id, { enableComputer: true });
    agentA = (await agentService.create(tenantId, { name: "A", spaceId, createApiKey: false })).agent.id;
    agentB = (await agentService.create(tenantId, { name: "B", spaceId, createApiKey: false })).agent.id;

    const workspaceRoot = join(root, "shared-workspace");
    fs = new LocalWorkspaceFs(workspaceRoot);
    await fs.mkdir("projects");
    await fs.mkdir("projects/old");
    await fs.write("projects/old/a.txt", "a");
    await fs.write("projects/old/b.txt", "b");
    await upsertSpaceProject(db, {
      tenantId,
      spaceId,
      slug: "old",
      name: "Old",
      hasWorkspace: true,
    });

    shares = new FileShareService(db, config);
    await shares.create(tenantId, agentA, fs, { path: "/projects/old/a.txt" });
    await shares.create(tenantId, agentB, fs, { path: "/projects/old/b.txt" });
    sessions = new CloudAgentSessionStore(db);
    await sessions.createSession({ tenantId, agentId: agentA, title: "A", project: "old" });
    await sessions.createSession({ tenantId, agentId: agentB, title: "B", project: "old" });

    app = new Hono();
    app.use("*", async (c, next) => {
      c.set("session", { userId: "user", tenantId, email: "user@example.test", role: "owner" });
      await next();
    });
    const fsProvider = { forAgentBinding: async () => fs };
    registerAgentFsRoutes(app, agentService, fsProvider as never, db, shares);
  });

  after(async () => {
    await close?.();
    rmSync(root, { recursive: true, force: true });
  });

  it("renames shared project references and live share paths for every Space member", async () => {
    const response = await app.request(`/api/agents/${agentA}/projects/old`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "renamed" }),
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(await fs.exists("projects/old"), false);
    assert.equal(await fs.exists("projects/renamed"), true);
    assert.equal(await getSpaceProject(db, spaceId, "old"), null);
    assert.ok(await getSpaceProject(db, spaceId, "renamed"));

    for (const agentId of [agentA, agentB]) {
      const rows = await sessions.listSessions(tenantId, agentId);
      assert.equal(rows[0]?.project, "renamed");
      const live = await shares.listForAgent(tenantId, agentId);
      assert.equal(live[0]?.status, "active");
      assert.match(live[0]?.path ?? "", /^\/projects\/renamed\//);
    }
  });

  it("deletes the project atomically enough to clear all references and revoke links", async () => {
    const response = await app.request(`/api/agents/${agentB}/projects/renamed`, {
      method: "DELETE",
    });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(await fs.exists("projects/renamed"), false);
    assert.equal(await getSpaceProject(db, spaceId, "renamed"), null);
    for (const agentId of [agentA, agentB]) {
      const rows = await sessions.listSessions(tenantId, agentId);
      assert.equal(rows[0]?.project, null);
      assert.equal((await shares.listForAgent(tenantId, agentId))[0]?.status, "revoked");
    }
  });

  it("rolls the workspace back when rename/delete metadata transactions fail", async () => {
    await fs.mkdir("projects/rollback");
    await fs.write("projects/rollback/output.txt", "keep me");
    await upsertSpaceProject(db, {
      tenantId,
      spaceId,
      slug: "rollback",
      name: "Rollback",
      hasWorkspace: true,
    });
    const share = await shares.create(tenantId, agentA, fs, {
      path: "/projects/rollback/output.txt",
    });
    const session = await sessions.createSession({
      tenantId,
      agentId: agentA,
      title: "Rollback",
      project: "rollback",
    });
    const scheduleId = newId();
    await db.insert(agentSchedules).values({
      id: scheduleId,
      tenantId,
      agentId: agentA,
      name: "Rollback",
      pattern: "@daily",
      prompt: "keep project",
      project: "rollback",
    });

    const failingDb = new Proxy(db as Db, {
      get(target, property, receiver) {
        if (property === "transaction") {
          return async () => { throw new Error("injected metadata failure"); };
        }
        const value = Reflect.get(target as object, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const failing = new Hono<any>();
    failing.onError((error, c) => c.json({ error: error.message }, 500));
    failing.use("*", async (c, next) => {
      c.set("session", { userId: "user", tenantId, email: "user@example.test", role: "owner" });
      await next();
    });
    registerAgentFsRoutes(
      failing,
      agentService,
      { forAgentBinding: async () => fs } as never,
      failingDb,
      shares,
    );

    const rename = await failing.request(`/api/agents/${agentA}/projects/rollback`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ slug: "broken" }),
    });
    assert.equal(rename.status, 500);
    assert.equal(await fs.exists("projects/rollback"), true);
    assert.equal(await fs.exists("projects/broken"), false);
    assert.ok(await getSpaceProject(db, spaceId, "rollback"));
    assert.equal(await getSpaceProject(db, spaceId, "broken"), null);

    const remove = await failing.request(`/api/agents/${agentA}/projects/rollback`, {
      method: "DELETE",
    });
    assert.equal(remove.status, 500);
    assert.equal(await fs.exists("projects/rollback/output.txt"), true);
    assert.ok(await getSpaceProject(db, spaceId, "rollback"));
    assert.equal((await sessions.getSession(tenantId, agentA, session.id))?.project, "rollback");
    assert.equal((await db.query.agentSchedules.findFirst({
      where: (row, { eq }) => eq(row.id, scheduleId),
    }))?.project, "rollback");
    assert.equal((await shares.listForAgent(tenantId, agentA)).find((item) => item.id === share.id)?.status, "active");
  });
});
