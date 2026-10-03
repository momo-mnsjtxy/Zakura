import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppVariables } from "../src/api/routes.js";
import { registerAutomationRoutes } from "../src/api/automation-routes.js";
import type { Db } from "../src/db/client.js";
import {
  agentAutomationRuns,
  agentHeartbeats,
  agentSchedules,
  agents,
  newId,
  tenants,
} from "../src/db/schema.js";
import {
  AgentAutomationService,
  type AutomationRunner,
} from "../src/services/agent-automation.js";
import { CloudAgentSessionStore } from "../src/services/cloud-agent-session.js";
import {
  CONFIGURE_HEARTBEAT_TOOL,
  GET_HEARTBEAT_TOOL,
  RUN_HEARTBEAT_TOOL,
  callAutomationTool,
  listAutomationToolDefinitions,
} from "../src/services/cloud-agent/automation-tools.js";
import { ensureTestSpace } from "./helpers/spaces.js";

describe("durable Agent automation and heartbeat lifecycle", () => {
  let dataDir = "";
  let db: Db;
  let close: () => Promise<void>;
  let store: CloudAgentSessionStore;
  let now = new Date("2026-10-03T12:00:00.000Z");

  before(async () => {
    process.env.REDIS_URL = "off";
    dataDir = mkdtempSync(join(tmpdir(), "zakura-automation-lifecycle-"));
    const databaseUrl = `pglite:${join(dataDir, "db")}`;
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(databaseUrl);
    const opened = await (await import("../src/db/client.js")).createDb({ databaseUrl, dataDir });
    db = opened.db;
    close = opened.close;
    store = new CloudAgentSessionStore(db);
  });

  after(async () => {
    await close?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function createAgent(label: string) {
    const tenantId = newId();
    const agentId = newId();
    await db.insert(tenants).values({ id: tenantId, slug: `${label}-${tenantId}`, name: label });
    const spaceId = await ensureTestSpace(db, tenantId);
    await db.insert(agents).values({
      id: agentId,
      tenantId,
      spaceId,
      name: `${label} Agent`,
      slug: `${label}-agent`,
      description: "",
      enableMemory: false,
      configJson: "{}",
    });
    return { tenantId, agentId };
  }

  function worker(calls: Array<{ kind: string; agentId: string }>, fail?: () => Error | null) {
    const runner: AutomationRunner = {
      startAutomationTurn: async (input) => {
        const error = fail?.();
        if (error) throw error;
        calls.push({ kind: input.kind, agentId: input.agentId });
        const session = await store.createSession({
          tenantId: input.tenantId,
          agentId: input.agentId,
          title: input.title,
          kind: "system",
        });
        const run = await store.createRun(session.id);
        await store.markRunStarted(run.id);
        return { sessionId: session.id, runId: run.id };
      },
      cancelAutomationTurn: ({ sessionId, runId }) => store.requestCancel(sessionId, runId),
    };
    return runner;
  }

  function service(runner: AutomationRunner, orphanGraceMs = 0) {
    const automation = new AgentAutomationService(db, {
      publicBaseUrl: "http://local",
      now: () => now,
      orphanGraceMs,
    });
    automation.setRunner(runner);
    return automation;
  }

  function routeApp(tenantId: string, agentId: string, automation: AgentAutomationService) {
    const app = new Hono<{ Variables: AppVariables }>();
    app.use("*", async (context, next) => {
      context.set("session", {
        userId: "automation-owner",
        tenantId,
        email: "owner@example.test",
        role: "owner",
      });
      await next();
    });
    registerAutomationRoutes(app, {
      agentService: {
        get: async (requestedTenant: string, requestedAgent: string) =>
          requestedTenant === tenantId && requestedAgent === agentId
            ? ({ id: agentId, tenantId } as never)
            : null,
      } as never,
      automation,
    });
    return app;
  }

  it("runs a heartbeat repeatedly through real routes and projects cloud terminal state", async () => {
    const ctx = await createAgent("heartbeat");
    const calls: Array<{ kind: string; agentId: string }> = [];
    const automation = service(worker(calls));
    const replica = service(worker(calls));
    const app = routeApp(ctx.tenantId, ctx.agentId, automation);

    const absent = await app.request(`/api/agents/${ctx.agentId}/heartbeat`);
    assert.equal(absent.status, 200);
    assert.deepEqual(await absent.json(), { heartbeat: null });
    const invalid = await app.request(`/api/agents/${ctx.agentId}/heartbeat`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, intervalMinutes: 4 }),
    });
    assert.equal(invalid.status, 400);
    const configured = await app.request(`/api/agents/${ctx.agentId}/heartbeat`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, intervalMinutes: 5, prompt: "check work" }),
    });
    assert.equal(configured.status, 200, await configured.clone().text());
    const heartbeat = (await configured.json() as { heartbeat: { nextRunAt: string } }).heartbeat;
    assert.equal(heartbeat.nextRunAt, "2026-10-03T12:05:00.000Z");

    now = new Date("2026-10-03T12:05:00.000Z");
    const ticks = await Promise.all([automation.tick(), replica.tick()]);
    assert.equal(ticks.reduce((sum, tick) => sum + tick.heartbeats, 0), 1);
    assert.deepEqual(calls, [{ kind: "heartbeat", agentId: ctx.agentId }]);
    let [automationRun] = await db
      .select()
      .from(agentAutomationRuns)
      .where(eq(agentAutomationRuns.agentId, ctx.agentId));
    assert.equal(automationRun?.status, "running");
    assert.ok(automationRun?.cloudRunId);
    await store.finishRun(automationRun!.sessionId!, automationRun!.cloudRunId!, "completed");
    await automation.tick();
    automationRun = (await db.query.agentAutomationRuns.findFirst({
      where: eq(agentAutomationRuns.id, automationRun!.id),
    }))!;
    assert.equal(automationRun.status, "completed");
    assert.equal((await automation.getHeartbeat(ctx.tenantId, ctx.agentId))?.lastStatus, "ok");

    now = new Date("2026-10-03T12:10:00.000Z");
    await automation.tick();
    assert.equal(calls.length, 2, "heartbeat cadence did not admit its next occurrence");
  });

  it("claims one due schedule across replicas and enforces listener maxRuns atomically", async () => {
    const ctx = await createAgent("claims");
    const calls: Array<{ kind: string; agentId: string }> = [];
    const baseWorker = worker(calls);
    let releaseWorker!: () => void;
    const workerGate = new Promise<void>((resolve) => { releaseWorker = resolve; });
    let enteredWorker!: () => void;
    const workerEntered = new Promise<void>((resolve) => { enteredWorker = resolve; });
    let admissions = 0;
    const delayedWorker: AutomationRunner = {
      ...baseWorker,
      startAutomationTurn: async (input) => {
        admissions += 1;
        enteredWorker();
        await workerGate;
        return baseWorker.startAutomationTurn(input);
      },
    };
    const first = service(delayedWorker);
    const second = service(delayedWorker);
    const schedule = await first.createSchedule(ctx.tenantId, ctx.agentId, {
      name: "due",
      prompt: "do it",
      pattern: "@every 5m",
    });
    await db
      .update(agentSchedules)
      .set({ nextRunAt: now })
      .where(eq(agentSchedules.id, schedule.id));
    const ticking = Promise.all([first.tick(), second.tick()]);
    await workerEntered;
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(admissions, 1, "a second worker entered while the first held the job claim");
    releaseWorker();
    const ticks = await ticking;
    assert.equal(ticks.reduce((sum, tick) => sum + tick.schedules, 0), 1);
    assert.equal(calls.filter((call) => call.kind === "schedule").length, 1);

    const listener = await first.createSchedule(ctx.tenantId, ctx.agentId, {
      name: "one event",
      prompt: "inspect",
      triggerKind: "listener",
      listener: { source: "webhook" },
      maxRuns: 1,
    });
    const event = { source: "webhook" as const, type: "post" };
    const admitted = await Promise.all([
      first.matchInbound(ctx.tenantId, ctx.agentId, event),
      second.matchInbound(ctx.tenantId, ctx.agentId, event),
    ]);
    assert.equal(admitted[0] + admitted[1], 1);
    const listenerRow = await db.query.agentSchedules.findFirst({
      where: eq(agentSchedules.id, listener.id),
    });
    assert.equal(listenerRow?.runCount, 1);
    assert.equal(listenerRow?.enabled, false);
    assert.equal(calls.filter((call) => call.kind === "listener").length, 1);
  });

  it("cancels a running automation through the route and reconciles it once", async () => {
    const ctx = await createAgent("cancel");
    const calls: Array<{ kind: string; agentId: string }> = [];
    const automation = service(worker(calls));
    const app = routeApp(ctx.tenantId, ctx.agentId, automation);
    const schedule = await automation.createSchedule(ctx.tenantId, ctx.agentId, {
      name: "cancel me",
      prompt: "wait",
      pattern: "@hourly",
    });
    const started = await app.request(
      `/api/agents/${ctx.agentId}/routines/${schedule.id}/run`,
      { method: "POST" },
    );
    assert.equal(started.status, 202, await started.clone().text());
    const run = (await started.json() as {
      run: { id: string; sessionId: string; cloudRunId: string; status: string };
    }).run;
    assert.equal(run.status, "running");
    const cancelled = await app.request(
      `/api/agents/${ctx.agentId}/automation/runs/${run.id}/cancel`,
      { method: "POST" },
    );
    assert.equal(cancelled.status, 202, await cancelled.clone().text());
    assert.equal((await cancelled.json() as { accepted: boolean }).accepted, true);
    assert.equal(await store.isCancelRequested(run.cloudRunId), true);
    await store.finishRun(run.sessionId, run.cloudRunId, "cancelled");
    await automation.tick();
    const status = await app.request(
      `/api/agents/${ctx.agentId}/automation/runs/${run.id}`,
    );
    assert.equal(status.status, 200);
    assert.equal((await status.json() as { run: { status: string } }).run.status, "skipped");
    const repeated = await app.request(
      `/api/agents/${ctx.agentId}/automation/runs/${run.id}/cancel`,
      { method: "POST" },
    );
    assert.equal(repeated.status, 200);
    assert.equal((await repeated.json() as { accepted: boolean }).accepted, false);
  });

  it("persists cancel during delayed admission and aborts the cloud run once it exists", async () => {
    const ctx = await createAgent("cancel-admission");
    const calls: Array<{ kind: string; agentId: string }> = [];
    const baseWorker = worker(calls);
    let releaseWorker!: () => void;
    const gate = new Promise<void>((resolve) => { releaseWorker = resolve; });
    let enteredWorker!: () => void;
    const entered = new Promise<void>((resolve) => { enteredWorker = resolve; });
    const delayed: AutomationRunner = {
      ...baseWorker,
      startAutomationTurn: async (input) => {
        enteredWorker();
        await gate;
        return baseWorker.startAutomationTurn(input);
      },
    };
    const automation = service(delayed);
    const app = routeApp(ctx.tenantId, ctx.agentId, automation);
    const schedule = await automation.createSchedule(ctx.tenantId, ctx.agentId, {
      name: "cancel admission",
      prompt: "wait before allocation",
      pattern: "@hourly",
    });
    const starting = app.request(
      `/api/agents/${ctx.agentId}/routines/${schedule.id}/run`,
      { method: "POST" },
    );
    await entered;
    const [admitting] = await automation.listRuns(ctx.tenantId, ctx.agentId, {
      scheduleId: schedule.id,
    });
    assert.equal(admitting?.status, "running");
    assert.equal(admitting?.cloudRunId, null);
    const cancelled = await app.request(
      `/api/agents/${ctx.agentId}/automation/runs/${admitting!.id}/cancel`,
      { method: "POST" },
    );
    assert.equal(cancelled.status, 202, await cancelled.clone().text());
    assert.equal((await cancelled.json() as { run: { status: string } }).run.status, "skipped");
    releaseWorker();
    const started = await starting;
    assert.equal(started.status, 202, await started.clone().text());
    const run = (await started.json() as {
      run: { status: string; sessionId: string; cloudRunId: string };
    }).run;
    assert.equal(run.status, "skipped");
    assert.equal(await store.isCancelRequested(run.cloudRunId), true);
    await store.finishRun(run.sessionId, run.cloudRunId, "cancelled");
  });

  it("recovers queued work, fails orphan admission, and records suspended runner failure", async () => {
    const ctx = await createAgent("recovery");
    const calls: Array<{ kind: string; agentId: string }> = [];
    const automation = service(worker(calls));
    const queuedId = newId();
    const orphanId = newId();
    await db.insert(agentAutomationRuns).values([
      {
        id: queuedId,
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        kind: "heartbeat",
        status: "queued",
        prompt: "recover me",
        createdAt: new Date(now.getTime() - 2_000),
      },
      {
        id: orphanId,
        tenantId: ctx.tenantId,
        agentId: ctx.agentId,
        kind: "heartbeat",
        status: "running",
        prompt: "lost",
        startedAt: new Date(now.getTime() - 1_000),
        createdAt: new Date(now.getTime() - 1_000),
      },
    ]);
    const recovered = await automation.recover();
    assert.equal(recovered.queued, 1);
    assert.equal(recovered.orphaned, 1);
    assert.equal((await db.query.agentAutomationRuns.findFirst({
      where: eq(agentAutomationRuns.id, queuedId),
    }))?.status, "running");
    assert.equal((await db.query.agentAutomationRuns.findFirst({
      where: eq(agentAutomationRuns.id, orphanId),
    }))?.status, "failed");

    let suspended = true;
    const failing = service(worker([], () => suspended ? new Error("account_suspended") : null));
    const schedule = await failing.createSchedule(ctx.tenantId, ctx.agentId, {
      name: "suspended",
      prompt: "must fail",
      pattern: "@hourly",
    });
    await assert.rejects(
      failing.runScheduleNow(ctx.tenantId, ctx.agentId, schedule.id),
      /account_suspended/,
    );
    suspended = false;
    const failed = await failing.listRuns(ctx.tenantId, ctx.agentId, {
      scheduleId: schedule.id,
    });
    assert.equal(failed[0]?.status, "failed");
    assert.match(failed[0]?.error ?? "", /account_suspended/);
  });

  it("exposes real heartbeat configuration and execution through Agent automation tools", async () => {
    const ctx = await createAgent("heartbeat-tools");
    const calls: Array<{ kind: string; agentId: string }> = [];
    const automation = service(worker(calls));
    const agent = (await db.query.agents.findFirst({ where: eq(agents.id, ctx.agentId) }))!;
    const names = new Set(listAutomationToolDefinitions().map((tool) => tool.function.name));
    assert.equal(names.has(GET_HEARTBEAT_TOOL), true);
    assert.equal(names.has(CONFIGURE_HEARTBEAT_TOOL), true);
    assert.equal(names.has(RUN_HEARTBEAT_TOOL), true);

    const configured = await callAutomationTool(
      automation,
      agent,
      CONFIGURE_HEARTBEAT_TOOL,
      { enabled: true, interval_minutes: 15, prompt: "check tools" },
    );
    assert.notEqual(configured.isError, true, configured.text);
    assert.match(configured.text, /"intervalMinutes": 15/);
    const started = await callAutomationTool(automation, agent, RUN_HEARTBEAT_TOOL, {});
    assert.notEqual(started.isError, true, started.text);
    assert.equal(calls.at(-1)?.kind, "heartbeat");
  });
});
