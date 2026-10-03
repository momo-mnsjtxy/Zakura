import { and, asc, count, desc, eq, gte, lte, sql } from "drizzle-orm";
import type { McpToolResult } from "@zakura/shared";
import type { Db } from "../db/client.js";
import {
  agents,
  apiKeys,
  componentInstances,
  newId,
  toolCallLogs,
  type ToolCallLog,
} from "../db/schema.js";

const MAX_JSON_CHARS = 24_000;
const MAX_PENDING_WRITES = 1_024;
const MAX_WRITE_ATTEMPTS = 3;
const MAX_OFFSET = 1_000_000;

export type ToolCallRecordInput = {
  tenantId: string;
  apiKeyId?: string | null;
  agentId?: string | null;
  qualifiedName: string;
  localName: string;
  providerId: string;
  instanceId?: string | null;
  args: Record<string, unknown>;
  result: McpToolResult;
  durationMs: number;
};

export type ToolCallListFilters = {
  agentId?: string;
  apiKeyId?: string;
  q?: string;
  isError?: boolean;
  since?: Date;
  until?: Date;
  limit?: number;
  offset?: number;
};

export type ToolCallListItem = ToolCallLog & {
  agentName: string | null;
  agentSlug: string | null;
  apiKeyName: string | null;
  apiKeyPrefix: string | null;
};

export type ToolCallStats = {
  total: number;
  errors: number;
  avgDurationMs: number;
  last24h: number;
  byAgent: Array<{ agentId: string | null; agentName: string | null; count: number }>;
  byApiKey: Array<{
    apiKeyId: string | null;
    apiKeyName: string | null;
    keyPrefix: string | null;
    count: number;
  }>;
  byTool: Array<{ qualifiedName: string; count: number; errors: number }>;
};

type StoredRecord = {
  id: string;
  tenantId: string;
  apiKeyId: string | null;
  agentId: string | null;
  qualifiedName: string;
  localName: string;
  providerId: string;
  instanceId: string | null;
  argsJson: string;
  resultJson: string;
  isError: boolean;
  durationMs: number;
};

type QueuedRecord = {
  value: StoredRecord;
  resolve: () => void;
};

function jsonWithStringLimit(value: unknown): string {
  try {
    const raw =
      JSON.stringify(value, (_key, item) => {
        if (typeof item === "bigint") return String(item);
        if (typeof item === "string" && item.length > 2_000) {
          return `${item.slice(0, 200)}…(${item.length} chars)`;
        }
        return item;
      }) ?? "null";
    if (raw.length <= MAX_JSON_CHARS) return raw;

    // Keep the column valid JSON even after truncation. Binary search accounts
    // for quote/backslash expansion in the preview string.
    let low = 0;
    let high = Math.min(raw.length, MAX_JSON_CHARS);
    let best = JSON.stringify({ truncated: true, originalChars: raw.length, preview: "" });
    while (low <= high) {
      const middle = Math.floor((low + high) / 2);
      const candidate = JSON.stringify({
        truncated: true,
        originalChars: raw.length,
        preview: raw.slice(0, middle),
      });
      if (candidate.length <= MAX_JSON_CHARS) {
        best = candidate;
        low = middle + 1;
      } else {
        high = middle - 1;
      }
    }
    return best;
  } catch {
    return '"[unserializable]"';
  }
}

/** Avoid double-stringifying a JSON text result in resultJson. */
function resultPayload(result: McpToolResult): unknown {
  const texts = (result.content ?? [])
    .map((content) => {
      if (content.type === "text") return content.text;
      if (content.type === "resource") return content.text ?? content.uri;
      return "";
    })
    .filter(Boolean);
  const text = texts.join("\n");
  if (!text) return null;
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[") || trimmed.startsWith('"')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      // Invalid JSON-looking text remains text.
    }
  }
  return text;
}

function boundedInteger(value: number | undefined, fallback: number, min: number, max: number) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(Math.max(Math.trunc(value!), min), max);
}

function validDate(value: Date | undefined): value is Date {
  return value instanceof Date && Number.isFinite(value.getTime());
}

function literalLikePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Durable, tenant-scoped tool-call audit storage.
 *
 * `record` is safe for fire-and-forget callers: writes are serialized through a
 * bounded queue, use a stable id for retry idempotency, and never reject. Tests
 * and orderly shutdown paths can await `flush()` to observe all accepted writes.
 */
export class ToolCallStore {
  private readonly queue: QueuedRecord[] = [];
  private active = false;
  private readonly drainWaiters = new Set<() => void>();

  constructor(private readonly db: Db) {}

  record(input: ToolCallRecordInput): Promise<void> {
    const durationMs = Number.isFinite(input.durationMs)
      ? Math.max(0, Math.round(input.durationMs))
      : 0;
    const value: StoredRecord = {
      id: newId(),
      tenantId: input.tenantId,
      apiKeyId: input.apiKeyId ?? null,
      agentId: input.agentId ?? null,
      qualifiedName: input.qualifiedName,
      localName: input.localName,
      providerId: input.providerId || "",
      instanceId: input.instanceId ?? null,
      argsJson: jsonWithStringLimit(input.args),
      resultJson: jsonWithStringLimit(resultPayload(input.result)),
      isError: Boolean(input.result.isError),
      durationMs,
    };

    return new Promise((resolve) => {
      if (this.queue.length + (this.active ? 1 : 0) >= MAX_PENDING_WRITES) {
        console.error("[tool-call-store] record queue is full; audit entry was not accepted");
        resolve();
        return;
      }
      this.queue.push({ value, resolve });
      this.pump();
    });
  }

  async flush(): Promise<void> {
    if (!this.active && this.queue.length === 0) return;
    await new Promise<void>((resolve) => this.drainWaiters.add(resolve));
  }

  async list(
    tenantId: string,
    filters: ToolCallListFilters = {},
  ): Promise<{ items: ToolCallListItem[]; total: number }> {
    const limit = boundedInteger(filters.limit, 50, 1, 200);
    const offset = boundedInteger(filters.offset, 0, 0, MAX_OFFSET);
    const where = this.buildWhere(tenantId, filters);

    const [countRow] = await this.db
      .select({ n: count() })
      .from(toolCallLogs)
      .where(where);

    const rows = await this.db
      .select({
        log: toolCallLogs,
        agentName: agents.name,
        agentSlug: agents.slug,
        apiKeyName: apiKeys.name,
        apiKeyPrefix: apiKeys.keyPrefix,
      })
      .from(toolCallLogs)
      .leftJoin(
        agents,
        and(eq(toolCallLogs.agentId, agents.id), eq(toolCallLogs.tenantId, agents.tenantId)),
      )
      .leftJoin(
        apiKeys,
        and(eq(toolCallLogs.apiKeyId, apiKeys.id), eq(toolCallLogs.tenantId, apiKeys.tenantId)),
      )
      .where(where)
      .orderBy(desc(toolCallLogs.createdAt), desc(toolCallLogs.id))
      .limit(limit)
      .offset(offset);

    return {
      total: Number(countRow?.n ?? 0),
      items: rows.map((row) => ({
        ...row.log,
        agentName: row.agentName ?? null,
        agentSlug: row.agentSlug ?? null,
        apiKeyName: row.apiKeyName ?? null,
        apiKeyPrefix: row.apiKeyPrefix ?? null,
      })),
    };
  }

  async get(tenantId: string, id: string): Promise<ToolCallListItem | null> {
    const [row] = await this.db
      .select({
        log: toolCallLogs,
        agentName: agents.name,
        agentSlug: agents.slug,
        apiKeyName: apiKeys.name,
        apiKeyPrefix: apiKeys.keyPrefix,
      })
      .from(toolCallLogs)
      .leftJoin(
        agents,
        and(eq(toolCallLogs.agentId, agents.id), eq(toolCallLogs.tenantId, agents.tenantId)),
      )
      .leftJoin(
        apiKeys,
        and(eq(toolCallLogs.apiKeyId, apiKeys.id), eq(toolCallLogs.tenantId, apiKeys.tenantId)),
      )
      .where(and(eq(toolCallLogs.tenantId, tenantId), eq(toolCallLogs.id, id)))
      .limit(1);
    if (!row) return null;
    return {
      ...row.log,
      agentName: row.agentName ?? null,
      agentSlug: row.agentSlug ?? null,
      apiKeyName: row.apiKeyName ?? null,
      apiKeyPrefix: row.apiKeyPrefix ?? null,
    };
  }

  async stats(tenantId: string, agentId?: string): Promise<ToolCallStats> {
    const base = agentId
      ? and(eq(toolCallLogs.tenantId, tenantId), eq(toolCallLogs.agentId, agentId))
      : eq(toolCallLogs.tenantId, tenantId);
    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1_000);

    const [totals] = await this.db
      .select({
        total: count(),
        errors: sql<number>`coalesce(sum(case when ${toolCallLogs.isError} then 1 else 0 end), 0)`,
        avgDurationMs: sql<number>`coalesce(avg(${toolCallLogs.durationMs}), 0)`,
      })
      .from(toolCallLogs)
      .where(base);

    const [last24] = await this.db
      .select({ n: count() })
      .from(toolCallLogs)
      .where(and(base, gte(toolCallLogs.createdAt, since24h)));

    const byAgentRows = await this.db
      .select({
        agentId: toolCallLogs.agentId,
        agentName: agents.name,
        count: count(),
      })
      .from(toolCallLogs)
      .leftJoin(
        agents,
        and(eq(toolCallLogs.agentId, agents.id), eq(toolCallLogs.tenantId, agents.tenantId)),
      )
      .where(base)
      .groupBy(toolCallLogs.agentId, agents.name)
      .orderBy(desc(count()), asc(toolCallLogs.agentId))
      .limit(20);

    const byKeyRows = await this.db
      .select({
        apiKeyId: toolCallLogs.apiKeyId,
        apiKeyName: apiKeys.name,
        keyPrefix: apiKeys.keyPrefix,
        count: count(),
      })
      .from(toolCallLogs)
      .leftJoin(
        apiKeys,
        and(eq(toolCallLogs.apiKeyId, apiKeys.id), eq(toolCallLogs.tenantId, apiKeys.tenantId)),
      )
      .where(base)
      .groupBy(toolCallLogs.apiKeyId, apiKeys.name, apiKeys.keyPrefix)
      .orderBy(desc(count()), asc(toolCallLogs.apiKeyId))
      .limit(20);

    const byToolRows = await this.db
      .select({
        qualifiedName: toolCallLogs.qualifiedName,
        count: count(),
        errors: sql<number>`coalesce(sum(case when ${toolCallLogs.isError} then 1 else 0 end), 0)`,
      })
      .from(toolCallLogs)
      .where(base)
      .groupBy(toolCallLogs.qualifiedName)
      .orderBy(desc(count()), asc(toolCallLogs.qualifiedName))
      .limit(20);

    return {
      total: Number(totals?.total ?? 0),
      errors: Number(totals?.errors ?? 0),
      avgDurationMs: Math.round(Number(totals?.avgDurationMs ?? 0)),
      last24h: Number(last24?.n ?? 0),
      byAgent: byAgentRows.map((row) => ({
        agentId: row.agentId,
        agentName: row.agentName,
        count: Number(row.count),
      })),
      byApiKey: byKeyRows.map((row) => ({
        apiKeyId: row.apiKeyId,
        apiKeyName: row.apiKeyName,
        keyPrefix: row.keyPrefix,
        count: Number(row.count),
      })),
      byTool: byToolRows.map((row) => ({
        qualifiedName: row.qualifiedName,
        count: Number(row.count),
        errors: Number(row.errors),
      })),
    };
  }

  private pump(): void {
    if (this.active) return;
    const queued = this.queue.shift();
    if (!queued) {
      this.resolveDrainWaiters();
      return;
    }
    this.active = true;
    void this.persist(queued.value).finally(() => {
      this.active = false;
      queued.resolve();
      this.pump();
    });
  }

  private async persist(value: StoredRecord): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= MAX_WRITE_ATTEMPTS; attempt += 1) {
      try {
        const [agentId, apiKeyId, instanceId] = await Promise.all([
          this.ownedAgentId(value.tenantId, value.agentId),
          this.ownedApiKeyId(value.tenantId, value.apiKeyId),
          this.ownedInstanceId(value.tenantId, value.instanceId),
        ]);
        await this.db
          .insert(toolCallLogs)
          .values({ ...value, agentId, apiKeyId, instanceId })
          .onConflictDoNothing({ target: toolCallLogs.id });
        return;
      } catch (error) {
        lastError = error;
        if (attempt < MAX_WRITE_ATTEMPTS) await wait(10 * 2 ** (attempt - 1));
      }
    }
    console.error("[tool-call-store] record failed:", lastError);
  }

  private async ownedAgentId(tenantId: string, agentId: string | null): Promise<string | null> {
    if (!agentId) return null;
    const [row] = await this.db
      .select({ id: agents.id })
      .from(agents)
      .where(and(eq(agents.id, agentId), eq(agents.tenantId, tenantId)))
      .limit(1);
    return row?.id ?? null;
  }

  private async ownedApiKeyId(tenantId: string, apiKeyId: string | null): Promise<string | null> {
    if (!apiKeyId) return null;
    const [row] = await this.db
      .select({ id: apiKeys.id })
      .from(apiKeys)
      .where(and(eq(apiKeys.id, apiKeyId), eq(apiKeys.tenantId, tenantId)))
      .limit(1);
    return row?.id ?? null;
  }

  private async ownedInstanceId(
    tenantId: string,
    instanceId: string | null,
  ): Promise<string | null> {
    if (!instanceId) return null;
    const [row] = await this.db
      .select({ id: componentInstances.id })
      .from(componentInstances)
      .where(and(eq(componentInstances.id, instanceId), eq(componentInstances.tenantId, tenantId)))
      .limit(1);
    return row?.id ?? null;
  }

  private resolveDrainWaiters(): void {
    if (this.active || this.queue.length > 0) return;
    for (const resolve of this.drainWaiters) resolve();
    this.drainWaiters.clear();
  }

  private buildWhere(tenantId: string, filters: ToolCallListFilters) {
    const parts = [eq(toolCallLogs.tenantId, tenantId)];
    if (filters.agentId) parts.push(eq(toolCallLogs.agentId, filters.agentId));
    if (filters.apiKeyId) parts.push(eq(toolCallLogs.apiKeyId, filters.apiKeyId));
    if (filters.isError === true) parts.push(eq(toolCallLogs.isError, true));
    if (filters.isError === false) parts.push(eq(toolCallLogs.isError, false));
    if (validDate(filters.since)) parts.push(gte(toolCallLogs.createdAt, filters.since));
    if (validDate(filters.until)) parts.push(lte(toolCallLogs.createdAt, filters.until));
    if (filters.q?.trim()) {
      const pattern = literalLikePattern(filters.q.trim());
      const escape = "\\";
      parts.push(sql`(
        ${toolCallLogs.qualifiedName} ilike ${pattern} escape ${escape}
        or ${toolCallLogs.localName} ilike ${pattern} escape ${escape}
        or ${toolCallLogs.providerId} ilike ${pattern} escape ${escape}
      )`);
    }
    return and(...parts)!;
  }
}
