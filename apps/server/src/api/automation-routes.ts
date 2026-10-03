/**
 * Agent Routine REST API（定时 + 事件）与公开 webhook。
 */
import type { Hono } from "hono";
import {
  inboundFromGithub,
  inboundFromLinear,
  inboundFromPagerDuty,
  inboundFromSentry,
  inboundFromSlack,
  inboundFromTeams,
  parseProjectField,
  type RoutineInboundEvent,
} from "@zakura/shared";
import type { AppVariables } from "./routes.js";
import type { AgentService } from "../services/agents.js";
import type { AgentAutomationService } from "../services/agent-automation.js";
import { CronParseError, RoutineListenerError } from "../services/agent-automation.js";
import { extractBearer } from "../services/auth.js";

export function registerAutomationRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: {
    agentService: AgentService;
    automation: AgentAutomationService;
  },
) {
  const { agentService, automation } = deps;

  async function requireAgent(tenantId: string, agentId: string) {
    return agentService.get(tenantId, agentId);
  }

  function errStatus(err: unknown): 400 | 404 {
    if (err instanceof CronParseError || err instanceof RoutineListenerError) return 400;
    const msg = err instanceof Error ? err.message : String(err);
    if (/not found/i.test(msg)) return 404;
    return 400;
  }

  // ── routines ───────────────────────────────────────────────

  app.get("/api/agents/:id/routines", async (c) => {
    const session = c.get("session")!;
    const agent = await requireAgent(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const schedules = await automation.listSchedules(session.tenantId, agent.id);
    return c.json({ schedules });
  });

  app.post("/api/agents/:id/routines", async (c) => {
    const session = c.get("session")!;
    const agent = await requireAgent(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    type CreateBody = {
      name?: string;
      description?: string;
      triggerKind?: "cron" | "listener";
      pattern?: string;
      listener?: unknown;
      prompt?: string;
      project?: string | null;
      enabled?: boolean;
      maxRuns?: number | null;
      timezone?: string;
    };
    const body = (await c.req.json<CreateBody>().catch(() => ({} as CreateBody))) as CreateBody;
    const projectField = parseProjectField(body.project);
    if (body.project !== undefined && projectField.status === "invalid") {
      return c.json({ error: "无效的项目名" }, 400);
    }
    try {
      const schedule = await automation.createSchedule(session.tenantId, agent.id, {
        name: String(body.name ?? ""),
        description: body.description,
        triggerKind: body.triggerKind,
        pattern: body.pattern,
        listener: body.listener,
        prompt: String(body.prompt ?? ""),
        ...(projectField.status === "ok" ? { project: projectField.slug } : {}),
        enabled: body.enabled,
        maxRuns: body.maxRuns,
        timezone: body.timezone,
      });
      return c.json({ schedule }, 201);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, errStatus(err));
    }
  });

  app.get("/api/agents/:id/routines/:sid", async (c) => {
    const session = c.get("session")!;
    const agent = await requireAgent(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const row = await automation.getSchedule(session.tenantId, agent.id, c.req.param("sid"));
    if (!row) return c.json({ error: "Not found" }, 404);
    const schedules = await automation.listSchedules(session.tenantId, agent.id);
    const schedule = schedules.find((s) => s.id === row.id);
    return c.json({ schedule });
  });

  app.patch("/api/agents/:id/routines/:sid", async (c) => {
    const session = c.get("session")!;
    const agent = await requireAgent(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    type PatchBody = {
      name?: string;
      description?: string;
      triggerKind?: "cron" | "listener";
      pattern?: string;
      listener?: unknown;
      prompt?: string;
      project?: string | null;
      enabled?: boolean;
      maxRuns?: number | null;
      timezone?: string;
    };
    const body = (await c.req.json<PatchBody>().catch(() => ({} as PatchBody))) as PatchBody;
    const projectField = parseProjectField(body.project);
    if (body.project !== undefined && projectField.status === "invalid") {
      return c.json({ error: "无效的项目名" }, 400);
    }
    try {
      const schedule = await automation.updateSchedule(
        session.tenantId,
        agent.id,
        c.req.param("sid"),
        {
          ...body,
          ...(projectField.status === "ok" ? { project: projectField.slug } : {}),
        },
      );
      if (!schedule) return c.json({ error: "Not found" }, 404);
      return c.json({ schedule });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, errStatus(err));
    }
  });

  app.delete("/api/agents/:id/routines/:sid", async (c) => {
    const session = c.get("session")!;
    const agent = await requireAgent(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const ok = await automation.deleteSchedule(
      session.tenantId,
      agent.id,
      c.req.param("sid"),
    );
    if (!ok) return c.json({ error: "Not found" }, 404);
    return c.json({ ok: true });
  });

  app.post("/api/agents/:id/routines/:sid/run", async (c) => {
    const session = c.get("session")!;
    const agent = await requireAgent(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    try {
      const run = await automation.runScheduleNow(
        session.tenantId,
        agent.id,
        c.req.param("sid"),
      );
      return c.json({ run }, 202);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, errStatus(err));
    }
  });

  app.get("/api/agents/:id/routines/:sid/runs", async (c) => {
    const session = c.get("session")!;
    const agent = await requireAgent(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const schedule = await automation.getSchedule(
      session.tenantId,
      agent.id,
      c.req.param("sid"),
    );
    if (!schedule) return c.json({ error: "Not found" }, 404);
    const limitRaw = Number(c.req.query("limit") ?? "30");
    const runs = await automation.listRuns(session.tenantId, agent.id, {
      limit: Number.isFinite(limitRaw) ? limitRaw : 30,
      scheduleId: schedule.id,
    });
    return c.json({ runs });
  });

  // ── audit log ───────────────────────────────────────────────

  app.get("/api/agents/:id/automation/runs", async (c) => {
    const session = c.get("session")!;
    const agent = await requireAgent(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const limitRaw = Number(c.req.query("limit") ?? "30");
    const kindRaw = c.req.query("kind");
    const kind = kindRaw === "schedule" || kindRaw === "heartbeat" ? kindRaw : undefined;
    const runs = await automation.listRuns(session.tenantId, agent.id, {
      limit: Number.isFinite(limitRaw) ? limitRaw : 30,
      ...(kind ? { kind } : {}),
    });
    return c.json({ runs });
  });

  app.get("/api/agents/:id/automation/runs/:rid", async (c) => {
    const session = c.get("session")!;
    const agent = await requireAgent(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const run = await automation.getRun(session.tenantId, agent.id, c.req.param("rid"));
    if (!run) return c.json({ error: "Not found" }, 404);
    return c.json({ run });
  });

  app.post("/api/agents/:id/automation/runs/:rid/cancel", async (c) => {
    const session = c.get("session")!;
    const agent = await requireAgent(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    try {
      const result = await automation.cancelRun(
        session.tenantId,
        agent.id,
        c.req.param("rid"),
      );
      if (!result) return c.json({ error: "Not found" }, 404);
      return c.json(result, result.accepted ? 202 : 200);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, 400);
    }
  });

  // ── heartbeat ───────────────────────────────────────────────

  app.get("/api/agents/:id/heartbeat", async (c) => {
    const session = c.get("session")!;
    const agent = await requireAgent(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const heartbeat = await automation.getHeartbeat(session.tenantId, agent.id);
    return c.json({ heartbeat });
  });

  app.patch("/api/agents/:id/heartbeat", async (c) => {
    const session = c.get("session")!;
    const agent = await requireAgent(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    type HeartbeatPatch = { enabled?: boolean; intervalMinutes?: number; prompt?: string };
    const body = await c.req.json<HeartbeatPatch>().catch(() => ({} as HeartbeatPatch));
    if (
      body.intervalMinutes !== undefined &&
      (!Number.isFinite(body.intervalMinutes) || body.intervalMinutes < 5)
    ) {
      return c.json({ error: "intervalMinutes must be at least 5" }, 400);
    }
    try {
      const heartbeat = await automation.updateHeartbeat(session.tenantId, agent.id, body);
      return c.json({ heartbeat });
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, errStatus(err));
    }
  });

  app.post("/api/agents/:id/heartbeat/run", async (c) => {
    const session = c.get("session")!;
    const agent = await requireAgent(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    try {
      const run = await automation.runHeartbeatNow(session.tenantId, agent.id);
      return c.json({ run }, 202);
    } catch (err) {
      return c.json({ error: err instanceof Error ? err.message : String(err) }, errStatus(err));
    }
  });

  app.get("/api/agents/:id/routines/:sid/webhook-secret", async (c) => {
    const session = c.get("session")!;
    const agent = await requireAgent(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const secret = await automation.revealWebhookSecret(
      session.tenantId,
      agent.id,
      c.req.param("sid"),
    );
    if (secret == null) return c.json({ error: "Not found" }, 404);
    return c.json({ secret });
  });

  app.post("/api/routines/:id/hook", async (c) => {
    const raw = await c.req.text();
    let payload: Record<string, unknown> = {};
    try {
      payload = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    } catch {
      payload = {};
    }
    const secret =
      extractBearer(c.req.header("authorization")) ??
      c.req.header("x-webhook-secret") ??
      c.req.query("token") ??
      null;
    const ghEvent = c.req.header("x-github-event");
    const events: RoutineInboundEvent[] = [];
    if (ghEvent) {
      events.push(...inboundFromGithub(ghEvent, payload));
    } else if (c.req.header("linear-event") || payload.type === "Issue") {
      const ev = inboundFromLinear(payload);
      if (ev) events.push(ev);
    } else if (typeof payload.action === "string" && ("data" in payload || "project" in payload)) {
      const ev = inboundFromSentry(payload);
      if (ev) events.push(ev);
    } else if (payload.event && typeof payload.event === "object") {
      const ev = inboundFromPagerDuty(payload);
      if (ev) events.push(ev);
    } else if (payload.teamId || payload.channelId) {
      events.push(inboundFromTeams(payload));
    } else if (payload.source === "slack") {
      events.push(
        inboundFromSlack({
          channel: typeof payload.channel === "string" ? payload.channel : undefined,
          text: typeof payload.text === "string" ? payload.text : undefined,
          user: typeof payload.user === "string" ? payload.user : undefined,
          mentioned: payload.mentioned === true,
          emoji: typeof payload.emoji === "string" ? payload.emoji : undefined,
        }),
      );
    } else if (typeof payload.source === "string" && typeof payload.type === "string") {
      events.push(payload as RoutineInboundEvent);
    } else {
      events.push({ source: "webhook", type: "post", payload });
    }

    const result = await automation.handleWebhook(c.req.param("id"), {
      secret,
      githubSignature: c.req.header("x-hub-signature-256"),
      rawBody: raw,
      events,
    });
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ ok: true, matched: result.matched });
  });
}
