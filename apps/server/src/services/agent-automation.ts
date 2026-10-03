/**
 * Agent Routine：定时（cron）与事件（listener）触发云端对话。
 * cron 进程内轮询 due 行；listener 由 webhook / Slack 入站命中。
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { log, recordPlatformFault } from "@zakura/core";
import { and, asc, desc, eq, isNull, lt, lte, or, sql } from "drizzle-orm";
import {
  describeListener,
  matchRoutineListener,
  parseRoutineListener,
  RoutineListenerError,
  shouldAutoStopListener,
  summarizeInbound,
  type RoutineInboundEvent,
  type RoutineListener,
} from "@zakura/shared";
import type { Db } from "../db/client.js";
import {
  agentAutomationRuns,
  agentHeartbeats,
  agentSchedules,
  agents,
  cloudAgentRuns,
  newId,
  type AgentAutomationRun,
  type AgentHeartbeat,
  type AgentSchedule,
} from "../db/schema.js";
import {
  assertValidSchedulePattern,
  CronParseError,
  nextRunAfter,
  splitCronTimezone,
} from "./cron-next.js";

const TICK_MS = 20_000;
const CLAIM_BATCH = 20;
const QUEUED_META_PREFIX = "zakura:automation:v1:";
const DEFAULT_HEARTBEAT_PROMPT =
  "检查当前工作区和任务状态，处理可以自主完成的事项，并简要汇报值得用户关注的变化。";

type QueuedAutomationMeta = {
  title: string;
  scheduleName?: string;
  project?: string | null;
  eventSummary?: string;
};

function encodeQueuedMeta(meta: QueuedAutomationMeta): string {
  return `${QUEUED_META_PREFIX}${JSON.stringify(meta)}`;
}

function parseQueuedMeta(raw: string | null): QueuedAutomationMeta | null {
  if (!raw?.startsWith(QUEUED_META_PREFIX)) return null;
  try {
    const value = JSON.parse(raw.slice(QUEUED_META_PREFIX.length)) as QueuedAutomationMeta;
    return value && typeof value.title === "string" ? value : null;
  } catch {
    return null;
  }
}

function transactionDb(value: unknown): Db {
  return value as Db;
}

export type AutomationTrigger = {
  tenantId: string;
  agentId: string;
  kind: "schedule" | "heartbeat" | "listener";
  scheduleId?: string;
  scheduleName?: string;
  prompt: string;
  title: string;
};

export type AutomationRunner = {
  startAutomationTurn: (input: {
    tenantId: string;
    agentId: string;
    prompt: string;
    title: string;
    kind: "schedule" | "heartbeat" | "listener";
    scheduleId?: string;
    scheduleName?: string;
    project?: string | null;
    eventSummary?: string;
  }) => Promise<{ sessionId: string; runId: string }>;
  cancelAutomationTurn?: (input: {
    tenantId: string;
    agentId: string;
    sessionId: string;
    runId: string;
  }) => Promise<boolean>;
};

function parseListenerJson(raw: string): RoutineListener | null {
  const t = raw.trim();
  if (!t || t === "{}") return null;
  try {
    return parseRoutineListener(JSON.parse(t));
  } catch {
    return null;
  }
}

function newWebhookSecret(): string {
  return randomBytes(24).toString("base64url");
}

function secretsEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  try {
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

function verifyGithubHmac(secret: string, rawBody: string, signature: string): boolean {
  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  return secretsEqual(expected, signature.trim());
}

function scheduleDto(row: AgentSchedule, publicBaseUrl?: string) {
  const listener = parseListenerJson(row.listenerJson);
  const base = (publicBaseUrl ?? "").replace(/\/$/, "");
  return {
    id: row.id,
    agentId: row.agentId,
    name: row.name,
    description: row.description,
    triggerKind: (row.triggerKind === "listener" ? "listener" : "cron") as "cron" | "listener",
    pattern: row.pattern,
    listener,
    listenerSummary: listener ? describeListener(listener) : null,
    webhookUrl:
      row.triggerKind === "listener" && base
        ? `${base}/api/routines/${row.id}/hook`
        : null,
    hasWebhookSecret: Boolean(row.webhookSecret),
    prompt: row.prompt,
    project: row.project,
    enabled: row.enabled,
    maxRuns: row.maxRuns,
    runCount: row.runCount,
    timezone: row.timezone,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function runDto(row: AgentAutomationRun) {
  return {
    id: row.id,
    agentId: row.agentId,
    kind: row.kind,
    scheduleId: row.scheduleId,
    sessionId: row.sessionId,
    cloudRunId: row.cloudRunId,
    status: row.status,
    prompt: row.prompt,
    resultText: parseQueuedMeta(row.resultText) ? null : row.resultText,
    error: row.error,
    startedAt: row.startedAt?.toISOString() ?? null,
    completedAt: row.completedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

function heartbeatDto(row: AgentHeartbeat) {
  return {
    agentId: row.agentId,
    enabled: row.enabled,
    intervalMinutes: row.intervalMinutes,
    prompt: row.prompt,
    nextRunAt: row.nextRunAt?.toISOString() ?? null,
    lastRunAt: row.lastRunAt?.toISOString() ?? null,
    lastStatus: row.lastStatus,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export class AgentAutomationService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private initialTimer: ReturnType<typeof setTimeout> | null = null;
  private ticking = false;
  private runner: AutomationRunner | null = null;
  private readonly now: () => Date;
  private readonly tickMs: number;
  private readonly initialDelayMs: number;
  private readonly orphanGraceMs: number;

  constructor(
    private readonly db: Db,
    private readonly opts?: {
      publicBaseUrl?: string;
      now?: () => Date;
      tickMs?: number;
      initialDelayMs?: number;
      orphanGraceMs?: number;
    },
  ) {
    this.now = opts?.now ?? (() => new Date());
    this.tickMs = Math.max(100, opts?.tickMs ?? TICK_MS);
    this.initialDelayMs = Math.max(0, opts?.initialDelayMs ?? 3_000);
    this.orphanGraceMs = Math.max(0, opts?.orphanGraceMs ?? 30_000);
  }

  private dto(row: AgentSchedule) {
    return scheduleDto(row, this.opts?.publicBaseUrl);
  }

  setRunner(runner: AutomationRunner | null): void {
    this.runner = runner;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.tickMs);
    this.timer.unref?.();
    // boot 后稍等再扫，避免与 migrate 抢
    this.initialTimer = setTimeout(() => {
      this.initialTimer = null;
      void this.recover()
        .then(() => this.tick())
        .catch((error) =>
          recordPlatformFault("automation.recover", error, { subsystem: "automation" }),
        );
    }, this.initialDelayMs);
    this.initialTimer.unref?.();
    log.info("boot.automation_scheduler", { poll_sec: this.tickMs / 1_000 });
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.initialTimer) {
      clearTimeout(this.initialTimer);
      this.initialTimer = null;
    }
  }

  // ── schedules CRUD ────────────────────────────────────────────

  async listSchedules(tenantId: string, agentId: string): Promise<ReturnType<typeof scheduleDto>[]> {
    const rows = await this.db
      .select()
      .from(agentSchedules)
      .where(and(eq(agentSchedules.tenantId, tenantId), eq(agentSchedules.agentId, agentId)))
      .orderBy(desc(agentSchedules.updatedAt));
    return rows.map((row) => this.dto(row));
  }

  async getSchedule(
    tenantId: string,
    agentId: string,
    scheduleId: string,
  ): Promise<AgentSchedule | null> {
    const row = await this.db.query.agentSchedules.findFirst({
      where: and(
        eq(agentSchedules.id, scheduleId),
        eq(agentSchedules.tenantId, tenantId),
        eq(agentSchedules.agentId, agentId),
      ),
    });
    return row ?? null;
  }

  async createSchedule(
    tenantId: string,
    agentId: string,
    input: {
      name: string;
      description?: string;
      triggerKind?: "cron" | "listener";
      pattern?: string;
      listener?: unknown;
      prompt: string;
      project?: string | null;
      enabled?: boolean;
      maxRuns?: number | null;
      timezone?: string;
    },
  ): Promise<ReturnType<typeof scheduleDto>> {
    const name = input.name.trim();
    const prompt = input.prompt.trim();
    if (!name) throw new Error("name is required");
    if (!prompt) throw new Error("prompt is required");

    const agent = await this.db.query.agents.findFirst({
      where: and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)),
    });
    if (!agent) throw new Error("Agent not found");

    const triggerKind: "cron" | "listener" =
      input.triggerKind === "listener" || input.listener ? "listener" : "cron";
    if (triggerKind === "cron" && input.listener) {
      throw new Error("cron 与 listener 不能同时配置");
    }

    let pattern = (input.pattern ?? "").trim();
    let timezone = (input.timezone ?? "UTC").trim() || "UTC";
    let listenerJson = "{}";
    let webhookSecret: string | null = null;
    let nextRunAt: Date | null = null;
    const enabled = input.enabled !== false;
    const now = this.now();

    if (triggerKind === "listener") {
      const listener = parseRoutineListener(input.listener);
      listenerJson = JSON.stringify(listener);
      webhookSecret = newWebhookSecret();
      pattern = "";
    } else {
      if (!pattern) throw new Error("pattern is required");
      const split = splitCronTimezone(pattern);
      if (split.timezone) timezone = split.timezone;
      assertValidSchedulePattern(pattern);
      nextRunAt = enabled ? nextRunAfter(pattern, now, { timezone }) : null;
    }

    const id = newId();
    await this.db.insert(agentSchedules).values({
      id,
      tenantId,
      agentId,
      name,
      description: (input.description ?? "").trim(),
      triggerKind,
      pattern,
      listenerJson,
      webhookSecret,
      prompt,
      project: input.project ?? null,
      enabled,
      maxRuns:
        typeof input.maxRuns === "number" && input.maxRuns > 0
          ? Math.floor(input.maxRuns)
          : null,
      runCount: 0,
      timezone,
      nextRunAt,
      createdAt: now,
      updatedAt: now,
    });
    const row = await this.getSchedule(tenantId, agentId, id);
    if (!row) throw new Error("create schedule failed");
    return this.dto(row);
  }

  async updateSchedule(
    tenantId: string,
    agentId: string,
    scheduleId: string,
    patch: {
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
    },
  ): Promise<ReturnType<typeof scheduleDto> | null> {
    const existing = await this.getSchedule(tenantId, agentId, scheduleId);
    if (!existing) return null;

    const triggerKind: "cron" | "listener" =
      patch.triggerKind ??
      (patch.listener !== undefined
        ? "listener"
        : existing.triggerKind === "listener"
          ? "listener"
          : "cron");
    if (triggerKind === "cron" && patch.listener) {
      throw new Error("cron 与 listener 不能同时配置");
    }

    const enabled = patch.enabled !== undefined ? patch.enabled : existing.enabled;
    const now = this.now();
    let pattern = patch.pattern !== undefined ? patch.pattern.trim() : existing.pattern;
    let timezone =
      patch.timezone !== undefined ? patch.timezone.trim() || "UTC" : existing.timezone;
    let listenerJson = existing.listenerJson;
    let webhookSecret = existing.webhookSecret;
    let nextRunAt = existing.nextRunAt;

    if (triggerKind === "listener") {
      if (patch.listener !== undefined) {
        listenerJson = JSON.stringify(parseRoutineListener(patch.listener));
      } else if (!parseListenerJson(existing.listenerJson)) {
        throw new Error("listener 不能为空");
      }
      pattern = "";
      nextRunAt = null;
      if (!webhookSecret) webhookSecret = newWebhookSecret();
    } else {
      listenerJson = "{}";
      if (!pattern) throw new Error("pattern is required");
      const split = splitCronTimezone(pattern);
      if (split.timezone) timezone = split.timezone;
      if (patch.pattern !== undefined) assertValidSchedulePattern(pattern);
      if (
        patch.pattern !== undefined ||
        patch.enabled !== undefined ||
        patch.timezone !== undefined ||
        existing.triggerKind === "listener"
      ) {
        nextRunAt = enabled
          ? nextRunAfter(pattern, now, { lastRunAt: existing.lastRunAt, timezone })
          : null;
      }
    }

    await this.db
      .update(agentSchedules)
      .set({
        ...(patch.name !== undefined ? { name: patch.name.trim() || existing.name } : {}),
        ...(patch.description !== undefined
          ? { description: patch.description.trim() }
          : {}),
        triggerKind,
        pattern,
        listenerJson,
        webhookSecret,
        ...(patch.prompt !== undefined ? { prompt: patch.prompt.trim() || existing.prompt } : {}),
        ...(patch.project !== undefined ? { project: patch.project } : {}),
        ...(patch.enabled !== undefined ? { enabled } : {}),
        ...(patch.maxRuns !== undefined
          ? {
              maxRuns:
                typeof patch.maxRuns === "number" && patch.maxRuns > 0
                  ? Math.floor(patch.maxRuns)
                  : null,
            }
          : {}),
        timezone,
        nextRunAt,
        updatedAt: now,
      })
      .where(eq(agentSchedules.id, scheduleId));

    const row = await this.getSchedule(tenantId, agentId, scheduleId);
    return row ? this.dto(row) : null;
  }

  async revealWebhookSecret(
    tenantId: string,
    agentId: string,
    scheduleId: string,
  ): Promise<string | null> {
    const row = await this.getSchedule(tenantId, agentId, scheduleId);
    return row?.webhookSecret ?? null;
  }

  async deleteSchedule(tenantId: string, agentId: string, scheduleId: string): Promise<boolean> {
    const existing = await this.getSchedule(tenantId, agentId, scheduleId);
    if (!existing) return false;
    await this.db.transaction(async (tx) => {
      const database = transactionDb(tx);
      await database
        .update(agentAutomationRuns)
        .set({
          status: "skipped",
          error: "routine deleted before start",
          completedAt: this.now(),
        })
        .where(
          and(
            eq(agentAutomationRuns.scheduleId, scheduleId),
            eq(agentAutomationRuns.status, "queued"),
          ),
        );
      await database
        .delete(agentSchedules)
        .where(
          and(
            eq(agentSchedules.id, scheduleId),
            eq(agentSchedules.tenantId, tenantId),
            eq(agentSchedules.agentId, agentId),
          ),
        );
    });
    return true;
  }

  // ── heartbeats ──────────────────────────────────────────────

  async getHeartbeat(tenantId: string, agentId: string) {
    const row = await this.db.query.agentHeartbeats.findFirst({
      where: and(
        eq(agentHeartbeats.tenantId, tenantId),
        eq(agentHeartbeats.agentId, agentId),
      ),
    });
    return row ? heartbeatDto(row) : null;
  }

  async updateHeartbeat(
    tenantId: string,
    agentId: string,
    patch: { enabled?: boolean; intervalMinutes?: number; prompt?: string },
  ) {
    const agent = await this.db.query.agents.findFirst({
      where: and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)),
    });
    if (!agent) throw new Error("Agent not found");
    const existing = await this.db.query.agentHeartbeats.findFirst({
      where: and(
        eq(agentHeartbeats.tenantId, tenantId),
        eq(agentHeartbeats.agentId, agentId),
      ),
    });
    if (
      patch.intervalMinutes !== undefined &&
      (!Number.isFinite(patch.intervalMinutes) ||
        patch.intervalMinutes < 5 ||
        patch.intervalMinutes > 10_080)
    ) {
      throw new Error("intervalMinutes must be between 5 and 10080");
    }
    const intervalMinutes = Math.floor(patch.intervalMinutes ?? existing?.intervalMinutes ?? 60);
    const enabled = patch.enabled ?? existing?.enabled ?? false;
    const prompt = patch.prompt !== undefined ? patch.prompt.trim() : (existing?.prompt ?? "");
    const now = this.now();
    const cadenceChanged =
      patch.intervalMinutes !== undefined || patch.enabled !== undefined || !existing;
    const nextRunAt = enabled
      ? cadenceChanged || !existing?.nextRunAt
        ? new Date(now.getTime() + intervalMinutes * 60_000)
        : existing.nextRunAt
      : null;
    const rows = await this.db
      .insert(agentHeartbeats)
      .values({
        agentId,
        tenantId,
        enabled,
        intervalMinutes,
        prompt,
        nextRunAt,
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: agentHeartbeats.agentId,
        set: { enabled, intervalMinutes, prompt, nextRunAt, updatedAt: now },
      })
      .returning();
    if (!rows[0]) throw new Error("update heartbeat failed");
    return heartbeatDto(rows[0]);
  }

  async runHeartbeatNow(tenantId: string, agentId: string) {
    const row = await this.db.query.agentHeartbeats.findFirst({
      where: and(
        eq(agentHeartbeats.tenantId, tenantId),
        eq(agentHeartbeats.agentId, agentId),
      ),
    });
    if (!row) throw new Error("heartbeat not found");
    const run = await this.admitHeartbeat(row, true);
    if (!run) throw new Error("heartbeat admission failed");
    return this.processAutomationRun(run.id, true);
  }

  // ── runs / manual trigger ─────────────────────────────────────

  async listRuns(
    tenantId: string,
    agentId: string,
    opts?: { limit?: number; kind?: "schedule" | "heartbeat"; scheduleId?: string },
  ) {
    const limit = Math.min(Math.max(opts?.limit ?? 30, 1), 100);
    const rows = await this.db
      .select()
      .from(agentAutomationRuns)
      .where(
        and(
          eq(agentAutomationRuns.tenantId, tenantId),
          eq(agentAutomationRuns.agentId, agentId),
          ...(opts?.kind ? [eq(agentAutomationRuns.kind, opts.kind)] : []),
          ...(opts?.scheduleId ? [eq(agentAutomationRuns.scheduleId, opts.scheduleId)] : []),
        ),
      )
      .orderBy(desc(agentAutomationRuns.createdAt))
      .limit(limit);
    return rows.map(runDto);
  }

  async getRun(tenantId: string, agentId: string, runId: string) {
    const row = await this.db.query.agentAutomationRuns.findFirst({
      where: and(
        eq(agentAutomationRuns.id, runId),
        eq(agentAutomationRuns.tenantId, tenantId),
        eq(agentAutomationRuns.agentId, agentId),
      ),
    });
    return row ? runDto(row) : null;
  }

  /** Manual trigger is an extra occurrence and does not move the saved cadence. */
  async runScheduleNow(tenantId: string, agentId: string, scheduleId: string) {
    const row = await this.getSchedule(tenantId, agentId, scheduleId);
    if (!row) throw new Error("schedule not found");
    const run = await this.admitSchedule(row, { mode: "manual" });
    if (!run) throw new Error("schedule admission failed");
    return this.processAutomationRun(run.id, true);
  }

  async cancelRun(tenantId: string, agentId: string, runId: string) {
    const row = await this.db.query.agentAutomationRuns.findFirst({
      where: and(
        eq(agentAutomationRuns.id, runId),
        eq(agentAutomationRuns.tenantId, tenantId),
        eq(agentAutomationRuns.agentId, agentId),
      ),
    });
    if (!row) return null;
    if (row.status === "queued") {
      const cancelled = await this.db
        .update(agentAutomationRuns)
        .set({
          status: "skipped",
          error: "cancelled before start",
          completedAt: this.now(),
        })
        .where(and(eq(agentAutomationRuns.id, row.id), eq(agentAutomationRuns.status, "queued")))
        .returning();
      const current = cancelled[0] ?? await this.db.query.agentAutomationRuns.findFirst({
        where: eq(agentAutomationRuns.id, row.id),
      });
      if (cancelled[0]) await this.updateSourceStatus(cancelled[0], "skipped", "cancelled");
      return current ? { accepted: Boolean(cancelled[0]), run: runDto(current) } : null;
    }
    if (row.status !== "running") return { accepted: false, run: runDto(row) };
    if (!row.sessionId || !row.cloudRunId) {
      const cancelled = await this.db
        .update(agentAutomationRuns)
        .set({
          status: "skipped",
          error: "cancelled during start",
          completedAt: this.now(),
        })
        .where(
          and(
            eq(agentAutomationRuns.id, row.id),
            eq(agentAutomationRuns.status, "running"),
            isNull(agentAutomationRuns.cloudRunId),
          ),
        )
        .returning();
      const current = cancelled[0] ?? await this.db.query.agentAutomationRuns.findFirst({
        where: eq(agentAutomationRuns.id, row.id),
      });
      if (cancelled[0]) await this.updateSourceStatus(cancelled[0], "skipped", "cancelled");
      return current ? { accepted: Boolean(cancelled[0]), run: runDto(current) } : null;
    }
    if (!this.runner?.cancelAutomationTurn) {
      throw new Error("automation runner cancel not configured");
    }
    const accepted = await this.runner.cancelAutomationTurn({
      tenantId,
      agentId,
      sessionId: row.sessionId,
      runId: row.cloudRunId,
    });
    if (accepted) {
      await this.db
        .update(agentAutomationRuns)
        .set({ error: "cancellation requested" })
        .where(and(eq(agentAutomationRuns.id, row.id), eq(agentAutomationRuns.status, "running")));
    }
    const current = await this.db.query.agentAutomationRuns.findFirst({
      where: eq(agentAutomationRuns.id, row.id),
    });
    return current ? { accepted, run: runDto(current) } : null;
  }

  // ── durable poll / recovery ────────────────────────────────────

  async recover(): Promise<{ queued: number; orphaned: number; reconciled: number }> {
    const reconciled = await this.reconcileTerminalRuns();
    const cutoff = new Date(this.now().getTime() - this.orphanGraceMs);
    const orphaned = await this.db
      .select()
      .from(agentAutomationRuns)
      .where(
        and(
          eq(agentAutomationRuns.status, "running"),
          isNull(agentAutomationRuns.cloudRunId),
          or(
            isNull(agentAutomationRuns.startedAt),
            lte(agentAutomationRuns.startedAt, cutoff),
          ),
        ),
      )
      .limit(CLAIM_BATCH);
    for (const row of orphaned) {
      const transitioned = await this.db
        .update(agentAutomationRuns)
        .set({
          status: "failed",
          error: "automation admission interrupted",
          completedAt: this.now(),
        })
        .where(and(eq(agentAutomationRuns.id, row.id), eq(agentAutomationRuns.status, "running")))
        .returning();
      if (transitioned[0]) {
        await this.updateSourceStatus(
          transitioned[0],
          "failed",
          "automation admission interrupted",
        );
      }
    }
    const queued = this.runner ? await this.processQueuedRuns() : 0;
    return { queued, orphaned: orphaned.length, reconciled };
  }

  async tick(): Promise<{ schedules: number; heartbeats: number; reconciled: number }> {
    if (this.ticking) return { schedules: 0, heartbeats: 0, reconciled: 0 };
    this.ticking = true;
    let schedules = 0;
    let heartbeats = 0;
    let reconciled = 0;
    try {
      reconciled = await this.reconcileTerminalRuns();
      if (!this.runner) return { schedules, heartbeats, reconciled };
      await this.processQueuedRuns();
      schedules = await this.claimDueSchedules();
      heartbeats = await this.claimDueHeartbeats();
      await this.processQueuedRuns();
    } catch (err) {
      recordPlatformFault("automation.tick", err, { subsystem: "automation" });
    } finally {
      this.ticking = false;
    }
    return { schedules, heartbeats, reconciled };
  }

  private async claimDueSchedules(): Promise<number> {
    const now = this.now();
    const due = await this.db
      .select()
      .from(agentSchedules)
      .where(and(eq(agentSchedules.enabled, true), lte(agentSchedules.nextRunAt, now)))
      .orderBy(asc(agentSchedules.nextRunAt))
      .limit(CLAIM_BATCH);
    let admitted = 0;
    for (const row of due) {
      if (row.triggerKind === "listener") continue;
      if (row.maxRuns != null && row.runCount >= row.maxRuns) {
        await this.db
          .update(agentSchedules)
          .set({
            enabled: false,
            nextRunAt: null,
            lastStatus: "completed",
            lastError: "max_runs reached",
            updatedAt: now,
          })
          .where(and(eq(agentSchedules.id, row.id), eq(agentSchedules.runCount, row.runCount)));
        continue;
      }
      let nextRunAt: Date;
      try {
        nextRunAt = nextRunAfter(row.pattern, now, { lastRunAt: now, timezone: row.timezone });
      } catch (error) {
        await this.db
          .update(agentSchedules)
          .set({
            enabled: false,
            nextRunAt: null,
            lastStatus: "failed",
            lastError: (error instanceof Error ? error.message : String(error)).slice(0, 500),
            updatedAt: now,
          })
          .where(and(eq(agentSchedules.id, row.id), eq(agentSchedules.runCount, row.runCount)));
        continue;
      }
      if (await this.admitSchedule(row, { mode: "due", nextRunAt })) admitted += 1;
    }
    return admitted;
  }

  private async claimDueHeartbeats(): Promise<number> {
    const now = this.now();
    const due = await this.db
      .select()
      .from(agentHeartbeats)
      .where(and(eq(agentHeartbeats.enabled, true), lte(agentHeartbeats.nextRunAt, now)))
      .orderBy(asc(agentHeartbeats.nextRunAt))
      .limit(CLAIM_BATCH);
    let admitted = 0;
    for (const row of due) {
      if (await this.admitHeartbeat(row, false)) admitted += 1;
    }
    return admitted;
  }

  private async admitSchedule(
    row: AgentSchedule,
    opts:
      | { mode: "manual" }
      | { mode: "due"; nextRunAt: Date }
      | { mode: "listener"; eventSummary: string; inbound: RoutineInboundEvent },
  ): Promise<AgentAutomationRun | null> {
    const now = this.now();
    const isListener = row.triggerKind === "listener";
    const disable =
      opts.mode === "listener" &&
      ((row.maxRuns != null && row.runCount + 1 >= row.maxRuns) ||
        (() => {
          const listener = parseListenerJson(row.listenerJson);
          return listener ? shouldAutoStopListener(listener, opts.inbound) : false;
        })());
    const meta: QueuedAutomationMeta = {
      title: `${isListener ? "事件" : "定时"}：${row.name}`.slice(0, 80),
      scheduleName: row.name,
      project: row.project,
      ...(opts.mode === "listener" ? { eventSummary: opts.eventSummary } : {}),
    };
    return this.db.transaction(async (tx) => {
      const database = transactionDb(tx);
      let claimed: AgentSchedule | undefined;
      if (opts.mode === "due") {
        const nextCount = row.runCount + 1;
        const maxReached = row.maxRuns != null && nextCount >= row.maxRuns;
        [claimed] = await database
          .update(agentSchedules)
          .set({
            runCount: sql`${agentSchedules.runCount} + 1`,
            lastRunAt: now,
            lastStatus: "queued",
            lastError: null,
            nextRunAt: maxReached ? null : opts.nextRunAt,
            ...(maxReached ? { enabled: false } : {}),
            updatedAt: now,
          })
          .where(
            and(
              eq(agentSchedules.id, row.id),
              eq(agentSchedules.enabled, true),
              eq(agentSchedules.runCount, row.runCount),
              row.nextRunAt
                ? eq(agentSchedules.nextRunAt, row.nextRunAt)
                : isNull(agentSchedules.nextRunAt),
            ),
          )
          .returning();
      } else if (opts.mode === "listener") {
        [claimed] = await database
          .update(agentSchedules)
          .set({
            runCount: sql`${agentSchedules.runCount} + 1`,
            lastRunAt: now,
            lastStatus: "queued",
            lastError: null,
            ...(disable ? { enabled: false, nextRunAt: null } : {}),
            updatedAt: now,
          })
          .where(
            and(
              eq(agentSchedules.id, row.id),
              eq(agentSchedules.enabled, true),
              eq(agentSchedules.runCount, row.runCount),
              ...(row.maxRuns != null ? [lt(agentSchedules.runCount, row.maxRuns)] : []),
            ),
          )
          .returning();
      } else {
        [claimed] = await database
          .update(agentSchedules)
          .set({
            runCount: sql`${agentSchedules.runCount} + 1`,
            lastRunAt: now,
            lastStatus: "queued",
            lastError: null,
            updatedAt: now,
          })
          .where(
            and(
              eq(agentSchedules.id, row.id),
              eq(agentSchedules.tenantId, row.tenantId),
              eq(agentSchedules.agentId, row.agentId),
            ),
          )
          .returning();
      }
      if (!claimed) return null;
      const inserted = await database
        .insert(agentAutomationRuns)
        .values({
          id: newId(),
          tenantId: row.tenantId,
          agentId: row.agentId,
          kind: isListener ? "listener" : "schedule",
          scheduleId: row.id,
          status: "queued",
          prompt: row.prompt,
          resultText: encodeQueuedMeta(meta),
          createdAt: now,
        })
        .returning();
      return inserted[0] ?? null;
    });
  }

  private async admitHeartbeat(
    row: AgentHeartbeat,
    manual: boolean,
  ): Promise<AgentAutomationRun | null> {
    const now = this.now();
    const nextRunAt = new Date(now.getTime() + Math.max(5, row.intervalMinutes) * 60_000);
    return this.db.transaction(async (tx) => {
      const database = transactionDb(tx);
      const claimed = await database
        .update(agentHeartbeats)
        .set({
          lastRunAt: now,
          lastStatus: "queued",
          lastError: null,
          ...(!manual ? { nextRunAt } : {}),
          updatedAt: now,
        })
        .where(
          and(
            eq(agentHeartbeats.agentId, row.agentId),
            eq(agentHeartbeats.tenantId, row.tenantId),
            ...(manual ? [] : [
              eq(agentHeartbeats.enabled, true),
              row.nextRunAt
                ? eq(agentHeartbeats.nextRunAt, row.nextRunAt)
                : isNull(agentHeartbeats.nextRunAt),
            ]),
          ),
        )
        .returning();
      if (!claimed[0]) return null;
      const inserted = await database
        .insert(agentAutomationRuns)
        .values({
          id: newId(),
          tenantId: row.tenantId,
          agentId: row.agentId,
          kind: "heartbeat",
          scheduleId: null,
          status: "queued",
          prompt: row.prompt.trim() || DEFAULT_HEARTBEAT_PROMPT,
          resultText: encodeQueuedMeta({ title: "心跳检查" }),
          createdAt: now,
        })
        .returning();
      return inserted[0] ?? null;
    });
  }

  private async processQueuedRuns(): Promise<number> {
    if (!this.runner) return 0;
    const rows = await this.db
      .select({ id: agentAutomationRuns.id })
      .from(agentAutomationRuns)
      .where(eq(agentAutomationRuns.status, "queued"))
      .orderBy(asc(agentAutomationRuns.createdAt))
      .limit(CLAIM_BATCH);
    let processed = 0;
    for (const row of rows) {
      const result = await this.processAutomationRun(row.id, false);
      if (result) processed += 1;
    }
    return processed;
  }

  private async processAutomationRun(runId: string, rethrow: boolean) {
    if (!this.runner) throw new Error("automation runner not configured");
    const startedAt = this.now();
    const claimed = await this.db
      .update(agentAutomationRuns)
      .set({ status: "running", startedAt })
      .where(and(eq(agentAutomationRuns.id, runId), eq(agentAutomationRuns.status, "queued")))
      .returning();
    if (!claimed[0]) {
      const current = await this.db.query.agentAutomationRuns.findFirst({
        where: eq(agentAutomationRuns.id, runId),
      });
      return current ? runDto(current) : null;
    }
    const row = claimed[0];
    let meta = parseQueuedMeta(row.resultText);
    if (!meta && row.scheduleId) {
      const schedule = await this.db.query.agentSchedules.findFirst({
        where: eq(agentSchedules.id, row.scheduleId),
      });
      if (schedule) {
        meta = {
          title: `${row.kind === "listener" ? "事件" : "定时"}：${schedule.name}`.slice(0, 80),
          scheduleName: schedule.name,
          project: schedule.project,
        };
      }
    }
    meta ??= { title: row.kind === "heartbeat" ? "心跳检查" : "自动任务" };
    try {
      const started = await this.runner.startAutomationTurn({
        tenantId: row.tenantId,
        agentId: row.agentId,
        prompt: row.prompt,
        title: meta.title,
        kind: row.kind as "schedule" | "heartbeat" | "listener",
        ...(row.scheduleId ? { scheduleId: row.scheduleId } : {}),
        ...(meta.scheduleName ? { scheduleName: meta.scheduleName } : {}),
        ...(meta.project !== undefined ? { project: meta.project } : {}),
        ...(meta.eventSummary ? { eventSummary: meta.eventSummary } : {}),
      });
      const updated = await this.db
        .update(agentAutomationRuns)
        .set({
          sessionId: started.sessionId,
          cloudRunId: started.runId,
          resultText: null,
          error: null,
        })
        .where(and(eq(agentAutomationRuns.id, row.id), eq(agentAutomationRuns.status, "running")))
        .returning();
      if (updated[0]) {
        await this.updateSourceStatus(updated[0], "running", null);
        return runDto(updated[0]);
      }
      const current = await this.db.query.agentAutomationRuns.findFirst({
        where: eq(agentAutomationRuns.id, row.id),
      });
      if (current?.status === "skipped") {
        const persisted = await this.db
          .update(agentAutomationRuns)
          .set({ sessionId: started.sessionId, cloudRunId: started.runId, resultText: null })
          .where(eq(agentAutomationRuns.id, row.id))
          .returning();
        await this.runner.cancelAutomationTurn?.({
          tenantId: row.tenantId,
          agentId: row.agentId,
          sessionId: started.sessionId,
          runId: started.runId,
        });
        return runDto(persisted[0] ?? current);
      }
      return current ? runDto(current) : null;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failed = await this.db
        .update(agentAutomationRuns)
        .set({
          status: "failed",
          resultText: null,
          error: message,
          completedAt: this.now(),
        })
        .where(and(eq(agentAutomationRuns.id, row.id), eq(agentAutomationRuns.status, "running")))
        .returning();
      if (failed[0]) await this.updateSourceStatus(failed[0], "failed", message);
      if (rethrow) throw error;
      recordPlatformFault("automation.fire", error, { subsystem: "automation" });
      return failed[0] ? runDto(failed[0]) : null;
    }
  }

  private async reconcileTerminalRuns(): Promise<number> {
    const rows = await this.db
      .select()
      .from(agentAutomationRuns)
      .where(
        and(
          eq(agentAutomationRuns.status, "running"),
          sql`${agentAutomationRuns.cloudRunId} is not null`,
        ),
      )
      .orderBy(asc(agentAutomationRuns.createdAt))
      .limit(CLAIM_BATCH * 5);
    let reconciled = 0;
    for (const row of rows) {
      const cloudRun = row.cloudRunId
        ? await this.db.query.cloudAgentRuns.findFirst({
            where: eq(cloudAgentRuns.id, row.cloudRunId),
          })
        : null;
      if (cloudRun && ["queued", "running", "recovering"].includes(cloudRun.status)) continue;
      const status = cloudRun?.status === "completed"
        ? "completed"
        : cloudRun?.status === "cancelled"
          ? "skipped"
          : "failed";
      const message =
        status === "completed"
          ? null
          : cloudRun?.error || (cloudRun ? `cloud run ${cloudRun.status}` : "cloud run missing");
      const transitioned = await this.db
        .update(agentAutomationRuns)
        .set({
          status,
          completedAt: cloudRun?.completedAt ?? this.now(),
          resultText: status === "completed" && row.sessionId
            ? `completed session ${row.sessionId}`
            : null,
          error: message,
        })
        .where(and(eq(agentAutomationRuns.id, row.id), eq(agentAutomationRuns.status, "running")))
        .returning();
      if (!transitioned[0]) continue;
      await this.updateSourceStatus(
        transitioned[0],
        status === "completed" ? "ok" : status,
        message,
      );
      reconciled += 1;
    }
    return reconciled;
  }

  private async updateSourceStatus(
    run: AgentAutomationRun,
    status: "queued" | "running" | "ok" | "failed" | "skipped",
    error: string | null,
  ): Promise<void> {
    const patch = {
      lastStatus: status,
      lastError: error?.slice(0, 500) ?? null,
      updatedAt: this.now(),
    };
    if (run.scheduleId) {
      await this.db
        .update(agentSchedules)
        .set(patch)
        .where(
          and(
            eq(agentSchedules.id, run.scheduleId),
            eq(agentSchedules.lastRunAt, run.createdAt),
          ),
        );
      return;
    }
    if (run.kind === "heartbeat") {
      await this.db
        .update(agentHeartbeats)
        .set(patch)
        .where(
          and(
            eq(agentHeartbeats.tenantId, run.tenantId),
            eq(agentHeartbeats.agentId, run.agentId),
            eq(agentHeartbeats.lastRunAt, run.createdAt),
          ),
        );
    }
  }

  /** Match inbound events and durably admit at most one run per listener version. */
  async matchInbound(
    tenantId: string,
    agentId: string,
    ev: RoutineInboundEvent,
  ): Promise<number> {
    const rows = await this.db
      .select()
      .from(agentSchedules)
      .where(
        and(
          eq(agentSchedules.tenantId, tenantId),
          eq(agentSchedules.agentId, agentId),
          eq(agentSchedules.enabled, true),
          eq(agentSchedules.triggerKind, "listener"),
        ),
      );
    let admitted = 0;
    for (const row of rows) {
      const listener = parseListenerJson(row.listenerJson);
      if (!listener || !matchRoutineListener(listener, ev)) continue;
      const run = await this.admitSchedule(row, {
        mode: "listener",
        eventSummary: summarizeInbound(ev),
        inbound: ev,
      });
      if (!run) continue;
      admitted += 1;
      await this.processAutomationRun(run.id, false);
    }
    return admitted;
  }

  /** Public webhook: authenticate, atomically reserve maxRuns, then start one job. */
  async handleWebhook(
    scheduleId: string,
    input: {
      secret?: string | null;
      authorized?: boolean;
      githubSignature?: string | null;
      rawBody?: string | null;
      events: RoutineInboundEvent[];
    },
  ): Promise<{ ok: true; matched: number } | { ok: false; error: string; status: 401 | 404 | 400 }> {
    const row = await this.db.query.agentSchedules.findFirst({
      where: eq(agentSchedules.id, scheduleId),
    });
    if (!row || row.triggerKind !== "listener") {
      return { ok: false, error: "not found", status: 404 };
    }
    const authed =
      input.authorized === true ||
      Boolean(row.webhookSecret && input.secret && secretsEqual(row.webhookSecret, input.secret)) ||
      Boolean(
        row.webhookSecret &&
          input.githubSignature &&
          input.rawBody != null &&
          verifyGithubHmac(row.webhookSecret, input.rawBody, input.githubSignature),
      );
    if (!authed) return { ok: false, error: "unauthorized", status: 401 };
    if (!row.enabled) return { ok: true, matched: 0 };
    const listener = parseListenerJson(row.listenerJson);
    if (!listener) return { ok: false, error: "invalid listener", status: 400 };
    const hits = input.events.filter((event) => matchRoutineListener(listener, event));
    const event = hits[0] ?? (listener.source === "webhook"
      ? { source: "webhook" as const, type: "post" }
      : null);
    if (!event) return { ok: true, matched: 0 };
    const run = await this.admitSchedule(row, {
      mode: "listener",
      eventSummary: summarizeInbound(event),
      inbound: event,
    });
    if (!run) return { ok: true, matched: 0 };
    await this.processAutomationRun(run.id, true);
    return { ok: true, matched: 1 };
  }

}

export { CronParseError, RoutineListenerError };
