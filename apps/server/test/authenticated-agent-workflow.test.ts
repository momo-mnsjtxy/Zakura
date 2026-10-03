import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { LocalWorkspaceFs } from "@zakura/core";
import type { ModelChatInvokeOptions, ModelChatMessage } from "@zakura/shared";
import { createApiApp } from "../src/api/routes.js";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import {
  agentSchedules,
  agents,
  cloudAgentSessions,
  fileShares as fileSharesTable,
  managedContainers,
  newId,
  runtimeNodes,
  spaceProjects,
  spaces,
  tenantMemberships,
  tenants,
  users,
} from "../src/db/schema.js";
import { AgentService } from "../src/services/agents.js";
import { signSession } from "../src/services/auth.js";
import { CloudAgentSessionStore } from "../src/services/cloud-agent-session.js";
import { FileShareService } from "../src/services/file-shares.js";
import { OauthService } from "../src/services/oauth.js";

async function eventually(check: () => Promise<boolean>, message: string, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail(message);
}

describe("authenticated Agent/Space/cloud/project lifecycle", () => {
  let root = "";
  let db: Db;
  let close: () => Promise<void>;

  before(async () => {
    process.env.REDIS_URL = "off";
    root = mkdtempSync(join(tmpdir(), "zakura-auth-workflow-"));
    const databaseUrl = `pglite:${join(root, "db")}`;
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(databaseUrl);
    const created = await (await import("../src/db/client.js")).createDb({ databaseUrl, dataDir: root });
    db = created.db;
    close = created.close;
  });

  after(async () => {
    await close?.();
    rmSync(root, { recursive: true, force: true });
  });

  it("authenticates the complete queue/cancel/tool/share/delete workflow", async () => {
    const tenantId = newId();
    const userId = newId();
    const nodeId = newId();
    const now = new Date();
    await db.insert(tenants).values({ id: tenantId, name: "Workflow", slug: "workflow" });
    await db.insert(users).values({ id: userId, email: "workflow@example.test" });
    await db.insert(tenantMemberships).values({ tenantId, userId, role: "owner", status: "active" });
    await db.insert(runtimeNodes).values({
      id: nodeId,
      tenantId,
      name: "Workflow runner",
      slug: "workflow-runner",
      kind: "computer",
      status: "online",
      endpoint: "http://runner.test",
      capabilitiesJson: JSON.stringify({ docker: true }),
      hostInfoJson: "{}",
      storageRoot: "/tmp/workflow",
      tokenHash: "fake-hash",
      labelsJson: "{}",
      lastSeenAt: now,
      createdAt: now,
      updatedAt: now,
    });

    const databaseUrl = `pglite:${join(root, "db")}`;
    const config = {
      dataDir: root,
      databaseUrl,
      secret: "authenticated-workflow",
      publicBaseUrl: "http://localhost",
      internalBaseUrl: "http://localhost",
      multiTenant: true,
    } as AppConfig;
    const remote = new Map<string, Record<string, unknown>>();
    const starts: string[] = [];
    const stops: string[] = [];
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
      stopWorkspace: async (spaceId: string) => {
        stops.push(spaceId);
        remote.delete(spaceId);
      },
      execWorkspace: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
      mkdir: async () => ({}),
    };
    const nodes = {
      requireRunnerClient: async () => ({ client, node: { id: nodeId, status: "online", name: "Workflow runner" } }),
    };
    const agentService = new AgentService(db, {} as never, config, nodes as never);
    const sessions = new CloudAgentSessionStore(db);
    const fileShares = new FileShareService(db, config);
    const workspaceFs = new LocalWorkspaceFs(join(root, "shared-workspace"));
    const workspaceFsProvider = {
      forAgent: async () => workspaceFs,
      forAgentBinding: async () => workspaceFs,
      invalidate: () => undefined,
    };

    let share: Awaited<ReturnType<FileShareService["create"]>> | null = null;
    let providerCalls = 0;
    let releaseSlowTool!: () => void;
    const slowTool = new Promise<void>((resolve) => { releaseSlowTool = resolve; });
    const gateway = {
      setSubagentRunner() {},
      listToolsForAgent: async () => [
        {
          qualifiedName: "re_get_file_url",
          instanceId: null,
          providerId: "zakura-agent",
          localName: "get_file_url",
          description: "Share a workspace file",
          inputSchema: { type: "object", required: ["path"], properties: { path: { type: "string" } } },
        },
        {
          qualifiedName: "re_slow_tool",
          instanceId: null,
          providerId: "zakura-agent",
          localName: "slow_tool",
          description: "A cancellable slow tool",
          inputSchema: { type: "object", properties: {} },
        },
      ],
      callTool: async (calledTenantId: string, name: string, args: Record<string, unknown>, context: { agentId: string }) => {
        assert.equal(calledTenantId, tenantId);
        if (name === "re_slow_tool") {
          await slowTool;
          return { content: [{ type: "text", text: "late result" }] };
        }
        assert.equal(name, "re_get_file_url");
        share = await fileShares.create(tenantId, context.agentId, workspaceFs, {
          path: String(args.path),
          ttlMinutes: 30,
        });
        return { content: [{ type: "text", text: JSON.stringify({ url: share.url, share_id: share.id }) }] };
      },
    };
    const modelRouter = {
      resolveRoute: async () => ({ meta: { contextLimit: 128_000 } }),
      chatStream: async (
        _tenant: string,
        messages: ModelChatMessage[],
        _route: unknown,
        _options: ModelChatInvokeOptions,
        callbacks?: { signal?: AbortSignal },
      ) => {
        providerCalls += 1;
        const lastUserIndex = messages.findLastIndex((message) => message.role === "user");
        const userText = messages[lastUserIndex]?.content ?? "";
        const currentRound = messages.slice(lastUserIndex + 1);
        if (userText.includes("cancel this run")) {
          await new Promise<never>((_resolve, reject) => {
            const aborted = () => reject(Object.assign(new Error("cancelled"), { name: "AbortError" }));
            if (callbacks?.signal?.aborted) aborted();
            else callbacks?.signal?.addEventListener("abort", aborted, { once: true });
          });
        }
        if (!currentRound.some((message) => message.role === "tool")) {
          const slow = userText.includes("delete while running");
          return {
            model: "fake",
            routeSlug: "fake",
            openai: {},
            content: null,
            toolCalls: [{
              id: slow ? "slow-call" : "share-call",
              type: "function" as const,
              function: {
                name: slow ? "re_slow_tool" : "re_get_file_url",
                arguments: slow ? "{}" : JSON.stringify({ path: "/projects/old/output.txt" }),
              },
            }],
          };
        }
        assert.ok(currentRound.some((message) => message.role === "tool" && message.content?.includes("/api/files/shared/")));
        return { model: "fake", routeSlug: "fake", openai: {}, content: "shared" };
      },
    };

    const app = await createApiApp({
      db,
      config,
      agentService,
      orchestrator: {} as never,
      gateway: gateway as never,
      runtime: {} as never,
      memoryStore: {} as never,
      memoryProviders: {} as never,
      modelRouter: modelRouter as never,
      toolCallStore: {} as never,
      oauth: new OauthService(db, config),
      runtimeNodes: nodes as never,
      workspaceFsProvider: workspaceFsProvider as never,
      fileShares,
      cloudSessionStore: sessions,
    });
    const token = signSession(config.secret, {
      userId,
      tenantId,
      email: "workflow@example.test",
      role: "owner",
    });
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const request = (path: string, method = "GET", body?: unknown, authenticated = true) =>
      app.request(path, {
        method,
        headers: authenticated ? headers : undefined,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

    const createdSpaceResponse = await request("/api/spaces", "POST", { name: "Workflow Space" });
    assert.equal(createdSpaceResponse.status, 201, await createdSpaceResponse.clone().text());
    const createdSpace = await createdSpaceResponse.json() as { id: string };
    const patchedSpace = await request(`/api/spaces/${createdSpace.id}`, "PATCH", {
      enableComputer: true,
      runtimeNodeId: nodeId,
    });
    assert.equal(patchedSpace.status, 200, await patchedSpace.clone().text());

    const createdAgentResponse = await request("/api/agents", "POST", {
      name: "Workflow Agent",
      spaceId: createdSpace.id,
      createApiKey: false,
      enableMemory: false,
      config: { cloud: { model: "fake", autoMemory: false, autoTitle: false, autoCompact: false } },
    });
    assert.equal(createdAgentResponse.status, 201, await createdAgentResponse.clone().text());
    const createdAgent = await createdAgentResponse.json() as { id: string };

    const started = await request(`/api/agents/${createdAgent.id}/start`, "POST", { runtimeNodeId: nodeId });
    assert.equal(started.status, 200, await started.clone().text());
    await eventually(async () => remote.has(createdSpace.id), "workspace did not start");
    assert.deepEqual(starts, [createdSpace.id]);

    const project = await request(`/api/agents/${createdAgent.id}/projects`, "POST", {
      name: "old",
      withWorkspace: true,
    });
    assert.equal(project.status, 200, await project.clone().text());
    await workspaceFs.write("projects/old/output.txt", "workflow artifact");
    await db.insert(agentSchedules).values({
      id: newId(),
      tenantId,
      agentId: createdAgent.id,
      name: "Project schedule",
      pattern: "@daily",
      prompt: "continue project",
      project: "old",
    });

    const createdSessionResponse = await request(`/api/agents/${createdAgent.id}/cloud/sessions`, "POST", {
      title: "Workflow",
      project: "old",
    });
    assert.equal(createdSessionResponse.status, 201, await createdSessionResponse.clone().text());
    const createdSession = await createdSessionResponse.json() as { id: string };

    const first = await request(
      `/api/agents/${createdAgent.id}/cloud/sessions/${createdSession.id}/messages`,
      "POST",
      { content: "cancel this run" },
    );
    assert.equal(first.status, 202, await first.clone().text());
    const firstBody = await first.json() as { runId: string };
    assert.deepEqual(Object.keys(firstBody), ["runId"]);

    const queued = await request(
      `/api/agents/${createdAgent.id}/cloud/sessions/${createdSession.id}/messages`,
      "POST",
      { content: "share output", followUp: "queue" },
    );
    assert.equal(queued.status, 202, await queued.clone().text());
    assert.equal((await queued.json() as { queued: boolean }).queued, true);

    const cancelled = await request(
      `/api/agents/${createdAgent.id}/cloud/sessions/${createdSession.id}/cancel`,
      "POST",
      { runId: firstBody.runId },
    );
    assert.equal(cancelled.status, 200, await cancelled.clone().text());
    assert.deepEqual(await cancelled.json(), { ok: true, runId: firstBody.runId });

    await eventually(async () => {
      const row = await sessions.getSession(tenantId, createdAgent.id, createdSession.id);
      const events = await sessions.listEvents(createdSession.id, { limit: 500 });
      const ends = events.filter((event) => event.type === "run_end");
      return row?.activeRunId === null && ends.some((event) => event.payload.status === "cancelled") &&
        ends.some((event) => event.payload.status === "completed") && share !== null;
    }, "cancelled run did not drain into queued tool run");

    const events = await sessions.listEvents(createdSession.id, { limit: 500 });
    assert.equal(events.filter((event) => event.type === "run_end" && event.payload.status === "cancelled").length, 1);
    assert.equal(events.filter((event) => event.type === "run_end" && event.payload.status === "completed").length, 1);
    assert.equal(events.filter((event) => event.type === "tool_call_result").length, 1);
    assert.ok(providerCalls >= 3);
    assert.ok(share);

    const publicDownload = await request(share!.url, "GET", undefined, false);
    assert.equal(publicDownload.status, 200, await publicDownload.clone().text());
    assert.equal(await publicDownload.text(), "workflow artifact");

    const deletedProject = await request(`/api/agents/${createdAgent.id}/projects/old`, "DELETE");
    assert.equal(deletedProject.status, 200, await deletedProject.clone().text());
    assert.equal((await sessions.getSession(tenantId, createdAgent.id, createdSession.id))?.project, null);
    const [schedule] = await db.select().from(agentSchedules).where(eq(agentSchedules.agentId, createdAgent.id));
    assert.equal(schedule?.project, null);
    const [shareRow] = await db.select().from(fileSharesTable).where(eq(fileSharesTable.id, share!.id));
    assert.equal(shareRow?.status, "revoked");
    assert.equal((await request(share!.url, "GET", undefined, false)).status, 404);

    const siblingResponse = await request("/api/agents", "POST", {
      name: "Disposable Agent",
      spaceId: createdSpace.id,
      createApiKey: false,
      enableMemory: false,
      config: { cloud: { model: "fake", autoMemory: false, autoTitle: false, autoCompact: false } },
    });
    assert.equal(siblingResponse.status, 201, await siblingResponse.clone().text());
    const sibling = await siblingResponse.json() as { id: string };
    const siblingSessionResponse = await request(`/api/agents/${sibling.id}/cloud/sessions`, "POST", {});
    assert.equal(siblingSessionResponse.status, 201, await siblingSessionResponse.clone().text());
    const siblingSession = await siblingSessionResponse.json() as { id: string };
    const siblingObserved: Array<{ type: string; runId: string | null; payload: Record<string, unknown> }> = [];
    const unsubscribeSibling = sessions.subscribe(siblingSession.id, (event) => {
      siblingObserved.push({ type: event.type, runId: event.runId, payload: event.payload as Record<string, unknown> });
    });
    const siblingProviderCalls = providerCalls;
    const siblingRunResponse = await request(
      `/api/agents/${sibling.id}/cloud/sessions/${siblingSession.id}/messages`,
      "POST",
      { content: "delete while running agent" },
    );
    assert.equal(siblingRunResponse.status, 202, await siblingRunResponse.clone().text());
    const siblingRunId = (await siblingRunResponse.json() as { runId: string }).runId;
    await eventually(
      async () => siblingObserved.some((event) => event.type === "tool_call_start" && event.runId === siblingRunId),
      "sibling slow tool did not start",
    );
    const siblingQueued = await request(
      `/api/agents/${sibling.id}/cloud/sessions/${siblingSession.id}/messages`,
      "POST",
      { content: "must not survive agent delete", followUp: "queue" },
    );
    assert.equal(siblingQueued.status, 202, await siblingQueued.clone().text());
    const deletedSibling = await request(`/api/agents/${sibling.id}`, "DELETE");
    assert.equal(deletedSibling.status, 200, await deletedSibling.clone().text());
    const siblingRunEvents = siblingObserved.filter((event) => event.runId === siblingRunId);
    const siblingToolResultIndex = siblingRunEvents.findIndex((event) => event.type === "tool_call_result");
    const siblingRunEndIndex = siblingRunEvents.findIndex((event) => event.type === "run_end");
    assert.ok(
      siblingToolResultIndex >= 0 && siblingRunEndIndex > siblingToolResultIndex,
      JSON.stringify(siblingRunEvents),
    );
    assert.equal(siblingRunEvents.filter((event) => event.type === "run_end").length, 1);
    assert.equal(siblingRunEvents.find((event) => event.type === "run_end")?.payload.status, "cancelled");
    assert.equal(providerCalls, siblingProviderCalls + 1, "sibling queue ran after Agent delete");
    assert.equal(remote.has(createdSpace.id), true, "Agent delete stopped its shared Space computer");
    unsubscribeSibling();

    const observed: Array<{ type: string; runId: string | null; payload: Record<string, unknown> }> = [];
    const unsubscribe = sessions.subscribe(createdSession.id, (event) => {
      observed.push({ type: event.type, runId: event.runId, payload: event.payload as Record<string, unknown> });
    });
    const providerCallsBeforeDelete = providerCalls;
    const activeBeforeDelete = await request(
      `/api/agents/${createdAgent.id}/cloud/sessions/${createdSession.id}/messages`,
      "POST",
      { content: "delete while running" },
    );
    assert.equal(activeBeforeDelete.status, 202, await activeBeforeDelete.clone().text());
    const activeRunId = (await activeBeforeDelete.json() as { runId: string }).runId;
    await eventually(
      async () => observed.some((event) => event.type === "tool_call_start" && event.runId === activeRunId),
      "slow tool did not start",
    );
    const queuedBeforeDelete = await request(
      `/api/agents/${createdAgent.id}/cloud/sessions/${createdSession.id}/messages`,
      "POST",
      { content: "must not run after delete", followUp: "queue" },
    );
    assert.equal(queuedBeforeDelete.status, 202, await queuedBeforeDelete.clone().text());

    const deletedSpace = await request(`/api/spaces/${createdSpace.id}`, "DELETE");
    assert.equal(deletedSpace.status, 200, await deletedSpace.clone().text());
    const activeEvents = observed.filter((event) => event.runId === activeRunId);
    const toolResultIndex = activeEvents.findIndex((event) => event.type === "tool_call_result");
    const runEndIndex = activeEvents.findIndex((event) => event.type === "run_end");
    assert.ok(toolResultIndex >= 0 && runEndIndex > toolResultIndex, JSON.stringify(activeEvents));
    assert.equal(activeEvents.filter((event) => event.type === "run_end").length, 1);
    assert.equal(activeEvents[runEndIndex]?.payload.status, "cancelled");
    assert.equal(providerCalls, providerCallsBeforeDelete + 1, "queued message started during deletion");
    releaseSlowTool();
    unsubscribe();
    assert.deepEqual(stops, [createdSpace.id]);
    assert.equal(remote.has(createdSpace.id), false);
    assert.equal((await db.select().from(spaces).where(eq(spaces.id, createdSpace.id))).length, 0);
    assert.equal((await db.select().from(agents).where(eq(agents.id, createdAgent.id))).length, 0);
    assert.equal((await db.select().from(cloudAgentSessions).where(eq(cloudAgentSessions.id, createdSession.id))).length, 0);
    assert.equal((await db.select().from(fileSharesTable).where(eq(fileSharesTable.id, share!.id))).length, 0);
    assert.equal((await db.select().from(agentSchedules).where(eq(agentSchedules.agentId, createdAgent.id))).length, 0);
    assert.equal((await db.select().from(spaceProjects).where(eq(spaceProjects.spaceId, createdSpace.id))).length, 0);
    assert.equal((await db.select().from(managedContainers).where(eq(managedContainers.spaceId, createdSpace.id))).length, 0);
  });
});
