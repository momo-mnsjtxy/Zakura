import { and, asc, eq, gte, isNull, lt, lte, or } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  newId,
  tenantContentCleanupJobs,
  tenants,
  type TenantContentCleanupJob,
} from "../db/schema.js";
import { platformEvents, type PlatformEventBus } from "./platform-events.js";

export type TenantCleanupAction =
  | "tenant_deleted"
  | "tenant_suspended"
  | "member_access_revoked";

export type AgentTenantDeleteLease = {
  finish(deleted: boolean): Promise<void> | void;
};

export type AgentTenantLifecycleCallbacks = {
  beginTenantDelete(tenantId: string): Promise<AgentTenantDeleteLease> | AgentTenantDeleteLease;
  suspendTenant(tenantId: string): Promise<void> | void;
  revokeMember(tenantId: string, userId: string): Promise<void> | void;
};

export type TenantContentLifecycleCallbacks = {
  stopChannels(tenantId: string): Promise<void>;
  /** Process-local task caches are cleared only when the whole tenant loses access. */
  cleanupTaskState?: (tenantId: string) => Promise<void> | void;
  /** Stop polling and clear email delivery state for tenant-wide suspension/deletion. */
  cleanupEmailState?: (
    tenantId: string,
    action: "tenant_deleted" | "tenant_suspended",
  ) => Promise<void> | void;
  /** Agent owner supplies this seam without creating a service dependency cycle. */
  agentLifecycle?: AgentTenantLifecycleCallbacks;
  cleanupSkillFiles(tenantId: string): Promise<void>;
  cleanupChannelState?: (tenantId: string) => Promise<void>;
  cleanupConnectorSecrets(tenantId: string): Promise<void>;
  cleanupExternalMemory(tenantId: string): Promise<void>;
  afterTenantDeleted?: (tenantId: string) => Promise<void> | void;
};

export type TenantContentLifecycleOptions = {
  events?: PlatformEventBus;
  instanceId?: string;
  pollIntervalMs?: number;
  now?: () => Date;
};

const RETENTION_MS = 24 * 60 * 60 * 1000;
const STALE_LOCK_MS = 2 * 60 * 1000;

/**
 * Durable, retryable tenant teardown plus live Redis fan-out.
 *
 * The outbox intentionally survives tenant deletion. Redis wakes live replicas;
 * polling completed tombstones covers missed pub/sub and newly-started replicas.
 */
export class TenantContentLifecycleService {
  private readonly events: PlatformEventBus;
  private readonly instanceId: string;
  private readonly pollIntervalMs: number;
  private readonly now: () => Date;
  private readonly observed = new Set<string>();
  private readonly deleteLeases = new Map<string, AgentTenantDeleteLease>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private unsubscribe: (() => void) | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly db: Db,
    private readonly callbacks: TenantContentLifecycleCallbacks,
    options: TenantContentLifecycleOptions = {},
  ) {
    this.events = options.events ?? platformEvents;
    this.instanceId = options.instanceId ?? newId();
    this.pollIntervalMs = Math.max(250, options.pollIntervalMs ?? 5_000);
    this.now = options.now ?? (() => new Date());
  }

  lifecycleHook(): {
    beforeDelete: (tenantId: string) => Promise<void>;
    afterDelete: (tenantId: string) => Promise<void>;
    afterSuspend: (tenantId: string) => Promise<void>;
    afterMemberRemoved: (tenantId: string, userId: string) => Promise<void>;
  } {
    return {
      beforeDelete: (tenantId) => this.beforeDelete(tenantId),
      afterDelete: (tenantId) => this.afterDelete(tenantId),
      afterSuspend: (tenantId) => this.afterSuspend(tenantId),
      afterMemberRemoved: (tenantId, userId) => this.afterMemberRemoved(tenantId, userId),
    };
  }

  start(): void {
    if (this.timer) return;
    this.unsubscribe = this.events.subscribeAll((event) => {
      if (event.type !== "tenant_lifecycle") return;
      void this.handleBroadcast(event.jobId).catch(() => undefined);
    });
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.pollIntervalMs);
    this.timer.unref?.();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    await this.running?.catch(() => undefined);
  }

  private async beforeDelete(tenantId: string): Promise<void> {
    await this.ensureDeleteLease(tenantId);
    try {
      const job = await this.enqueue(
        tenantId,
        "tenant_deleted",
        `tenant-delete:${tenantId}`,
        {},
      );
      this.publish(job);
      // Fail closed: tenant ownership rows remain until every owned resource has
      // been removed or the durable retry worker completes the same idempotent job.
      await this.runJobNow(job.id);
    } catch (error) {
      await this.finishDeleteLease(tenantId, false);
      throw error;
    }
  }

  private async afterDelete(tenantId: string): Promise<void> {
    await this.finalizeDeletedTenant(tenantId);
    const job = await this.findByIdempotency(`tenant-delete:${tenantId}`);
    if (job) this.publish(job);
  }

  private async afterSuspend(tenantId: string): Promise<void> {
    const job = await this.enqueue(
      tenantId,
      "tenant_suspended",
      `tenant-suspend:${tenantId}:${newId()}`,
      {},
    );
    this.publish(job);
    await this.runJobNow(job.id).catch(() => undefined);
  }

  private async afterMemberRemoved(tenantId: string, userId: string): Promise<void> {
    const job = await this.enqueue(
      tenantId,
      "member_access_revoked",
      `member-revoked:${tenantId}:${userId}:${newId()}`,
      { userId },
    );
    this.publish(job);
    await this.runJobNow(job.id).catch(() => undefined);
  }

  private publish(job: TenantContentCleanupJob): void {
    this.events.publishAll({
      type: "tenant_lifecycle",
      tenantId: job.tenantId,
      action: job.action as TenantCleanupAction,
      jobId: job.id,
    });
  }

  private async ensureDeleteLease(tenantId: string): Promise<AgentTenantDeleteLease | null> {
    const existing = this.deleteLeases.get(tenantId);
    if (existing) return existing;
    if (!this.callbacks.agentLifecycle) return null;
    const lease = await this.callbacks.agentLifecycle.beginTenantDelete(tenantId);
    this.deleteLeases.set(tenantId, lease);
    return lease;
  }

  private async finishDeleteLease(tenantId: string, deleted: boolean): Promise<void> {
    const lease = this.deleteLeases.get(tenantId);
    if (!lease) return;
    await lease.finish(deleted);
    if (this.deleteLeases.get(tenantId) === lease) this.deleteLeases.delete(tenantId);
  }

  private async finalizeDeletedTenant(tenantId: string): Promise<void> {
    const failures: string[] = [];
    try {
      await this.finishDeleteLease(tenantId, true);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    try {
      await this.callbacks.afterTenantDeleted?.(tenantId);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
    if (failures.length) throw new Error(`tenant post-delete finalization failed: ${failures.join("; ")}`);
  }

  private parsePayload(job: TenantContentCleanupJob): Record<string, unknown> {
    try {
      const value = JSON.parse(job.payloadJson) as unknown;
      return value && typeof value === "object" && !Array.isArray(value)
        ? value as Record<string, unknown>
        : {};
    } catch {
      return {};
    }
  }

  private async applyRuntimeLifecycle(job: TenantContentCleanupJob): Promise<void> {
    const failures: string[] = [];
    const operations: Array<() => Promise<void> | void> = [
      () => this.callbacks.stopChannels(job.tenantId),
    ];
    if (
      this.callbacks.cleanupTaskState &&
      (job.action === "tenant_deleted" || job.action === "tenant_suspended")
    ) {
      operations.push(() => this.callbacks.cleanupTaskState!(job.tenantId));
    }
    if (
      this.callbacks.cleanupEmailState &&
      (job.action === "tenant_deleted" || job.action === "tenant_suspended")
    ) {
      const emailAction: "tenant_deleted" | "tenant_suspended" = job.action;
      // Block and drain inbound delivery before stopping channels, otherwise a
      // webhook already in flight can create a new run after stopChannels.
      operations.unshift(() =>
        this.callbacks.cleanupEmailState!(job.tenantId, emailAction),
      );
    }
    if (job.action === "tenant_deleted") {
      operations.unshift(() => this.ensureDeleteLease(job.tenantId).then(() => undefined));
    } else if (job.action === "tenant_suspended" && this.callbacks.agentLifecycle) {
      operations.push(() => this.callbacks.agentLifecycle!.suspendTenant(job.tenantId));
    } else if (job.action === "member_access_revoked" && this.callbacks.agentLifecycle) {
      const userId = String(this.parsePayload(job).userId ?? "").trim();
      if (userId) {
        operations.push(() => this.callbacks.agentLifecycle!.revokeMember(job.tenantId, userId));
      }
    }
    for (const operation of operations) {
      try {
        await operation();
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error));
      }
    }
    if (failures.length) throw new Error(`tenant runtime stop failed: ${failures.join("; ")}`);
  }

  private async execute(job: TenantContentCleanupJob): Promise<void> {
    await this.applyRuntimeLifecycle(job);
    if (job.action !== "tenant_deleted") return;
    const failures: string[] = [];
    for (const [name, operation] of [
      ["skills", () => this.callbacks.cleanupSkillFiles(job.tenantId)],
      ...(this.callbacks.cleanupChannelState
        ? [["channel-state", () => this.callbacks.cleanupChannelState!(job.tenantId)] as const]
        : []),
      ["external-memory", () => this.callbacks.cleanupExternalMemory(job.tenantId)],
      ["connector-secrets", () => this.callbacks.cleanupConnectorSecrets(job.tenantId)],
    ] as const) {
      try {
        await operation();
      } catch (error) {
        failures.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (failures.length) throw new Error(failures.join("; "));
  }

  private async enqueue(
    tenantId: string,
    action: TenantCleanupAction,
    idempotencyKey: string,
    payload: Record<string, unknown>,
  ): Promise<TenantContentCleanupJob> {
    const now = this.now();
    const inserted = await this.db
      .insert(tenantContentCleanupJobs)
      .values({
        id: newId(), idempotencyKey, tenantId, action,
        payloadJson: JSON.stringify(payload), status: "pending", attempts: 0,
        maxAttempts: 8, availableAt: now, createdAt: now, updatedAt: now,
      })
      .onConflictDoNothing({ target: tenantContentCleanupJobs.idempotencyKey })
      .returning();
    if (inserted[0]) return inserted[0];
    const existing = await this.findByIdempotency(idempotencyKey);
    if (!existing) throw new Error("tenant cleanup outbox insert lost");
    return existing;
  }

  private findByIdempotency(key: string): Promise<TenantContentCleanupJob | undefined> {
    return this.db.query.tenantContentCleanupJobs.findFirst({
      where: eq(tenantContentCleanupJobs.idempotencyKey, key),
    });
  }

  private async claim(id?: string): Promise<TenantContentCleanupJob | null> {
    const now = this.now();
    const staleAt = new Date(now.getTime() - STALE_LOCK_MS);
    const ready = or(
      and(
        or(
          eq(tenantContentCleanupJobs.status, "pending"),
          eq(tenantContentCleanupJobs.status, "failed"),
        ),
        lte(tenantContentCleanupJobs.availableAt, now),
        lt(tenantContentCleanupJobs.attempts, tenantContentCleanupJobs.maxAttempts),
      ),
      and(
        eq(tenantContentCleanupJobs.status, "running"),
        or(isNull(tenantContentCleanupJobs.lockedAt), lte(tenantContentCleanupJobs.lockedAt, staleAt)),
        lt(tenantContentCleanupJobs.attempts, tenantContentCleanupJobs.maxAttempts),
      ),
    );
    const candidate = await this.db.query.tenantContentCleanupJobs.findFirst({
      where: id ? and(eq(tenantContentCleanupJobs.id, id), ready) : ready,
      orderBy: [asc(tenantContentCleanupJobs.availableAt), asc(tenantContentCleanupJobs.createdAt)],
    });
    if (!candidate) return null;
    const claimed = await this.db
      .update(tenantContentCleanupJobs)
      .set({
        status: "running",
        attempts: candidate.attempts + 1,
        lockedAt: now,
        lockedBy: this.instanceId,
        updatedAt: now,
      })
      .where(and(
        eq(tenantContentCleanupJobs.id, candidate.id),
        eq(tenantContentCleanupJobs.status, candidate.status),
        eq(tenantContentCleanupJobs.updatedAt, candidate.updatedAt),
      ))
      .returning();
    return claimed[0] ?? null;
  }

  private async runJobNow(id: string): Promise<void> {
    let job = await this.claim(id);
    if (!job) {
      const current = await this.db.query.tenantContentCleanupJobs.findFirst({
        where: eq(tenantContentCleanupJobs.id, id),
      });
      if (current?.status === "completed") return;
      if (current?.status === "running") {
        for (let i = 0; i < 100; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          const latest = await this.db.query.tenantContentCleanupJobs.findFirst({
            where: eq(tenantContentCleanupJobs.id, id),
          });
          if (latest?.status === "completed") return;
          if (latest && latest.status !== "running") {
            job = await this.claim(id);
            break;
          }
        }
      }
      if (!job) throw new Error(current?.lastError || "tenant cleanup job is not runnable");
    }
    await this.processClaimed(job, { awaitingDeleteCommit: true });
  }

  private async processClaimed(
    job: TenantContentCleanupJob,
    opts: { awaitingDeleteCommit?: boolean } = {},
  ): Promise<void> {
    try {
      await this.execute(job);
      const now = this.now();
      await this.db
        .update(tenantContentCleanupJobs)
        .set({
          status: "completed", completedAt: now, lockedAt: null, lockedBy: null,
          lastError: null, updatedAt: now,
        })
        .where(and(
          eq(tenantContentCleanupJobs.id, job.id),
          eq(tenantContentCleanupJobs.lockedBy, this.instanceId),
        ));
      if (job.action !== "tenant_deleted") this.observed.add(job.id);
      if (job.action === "tenant_deleted" && !opts.awaitingDeleteCommit) {
        // A retry worker can finish cleanup without owning the tenant-delete
        // transaction. Release its drain as "not deleted"; the eventual delete
        // request acquires a fresh lease and keeps it through commit.
        const tenant = await this.db.query.tenants.findFirst({
          where: eq(tenants.id, job.tenantId),
          columns: { id: true },
        });
        await this.finishDeleteLease(job.tenantId, !tenant).catch(() => undefined);
      }
    } catch (error) {
      const now = this.now();
      const terminal = job.attempts >= job.maxAttempts;
      const delayMs = Math.min(60 * 60 * 1000, 1_000 * 2 ** Math.max(0, job.attempts - 1));
      await this.db
        .update(tenantContentCleanupJobs)
        .set({
          status: terminal ? "terminal" : "failed",
          availableAt: new Date(now.getTime() + delayMs),
          lockedAt: null,
          lockedBy: null,
          lastError: (error instanceof Error ? error.message : String(error)).slice(0, 2_000),
          updatedAt: now,
        })
        .where(and(
          eq(tenantContentCleanupJobs.id, job.id),
          eq(tenantContentCleanupJobs.lockedBy, this.instanceId),
        ));
      if (job.action === "tenant_deleted") {
        await this.finishDeleteLease(job.tenantId, false).catch(() => undefined);
      }
      const failed = await this.db.query.tenantContentCleanupJobs.findFirst({
        where: eq(tenantContentCleanupJobs.id, job.id),
      });
      if (failed) this.publish(failed);
      throw error;
    }
  }

  async tick(): Promise<void> {
    if (this.running) return this.running;
    const task = (async () => {
      await this.observeDurableTombstones();
      for (let i = 0; i < 20; i += 1) {
        const job = await this.claim();
        if (!job) break;
        await this.processClaimed(job).catch(() => undefined);
      }
    })().finally(() => {
      if (this.running === task) this.running = null;
    });
    this.running = task;
    return task;
  }

  private async observeDurableTombstones(): Promise<void> {
    const cutoff = new Date(this.now().getTime() - RETENTION_MS);
    const rows = await this.db
      .select()
      .from(tenantContentCleanupJobs)
      .where(and(
        gte(tenantContentCleanupJobs.createdAt, cutoff),
        or(
          eq(tenantContentCleanupJobs.action, "tenant_deleted"),
          eq(tenantContentCleanupJobs.action, "tenant_suspended"),
        ),
      ));
    for (const row of rows) {
      if (this.observed.has(row.id)) continue;
      const tenant = await this.db.query.tenants.findFirst({
        where: eq(tenants.id, row.tenantId),
        columns: { id: true, suspendedAt: true },
      });
      const stillUnavailable = !tenant || tenant.suspendedAt != null;
      if (stillUnavailable) {
        await this.applyRuntimeLifecycle(row).catch(() => undefined);
        if (!tenant && row.action === "tenant_deleted") {
          try {
            await this.finalizeDeletedTenant(row.tenantId);
            this.observed.add(row.id);
          } catch {
            /* retry on the next poll */
          }
        } else if (row.action === "tenant_suspended") {
          this.observed.add(row.id);
        }
      } else if (row.action === "tenant_suspended") {
        this.observed.add(row.id);
      }
    }
  }

  private async handleBroadcast(jobId: string): Promise<void> {
    const job = await this.db.query.tenantContentCleanupJobs.findFirst({
      where: eq(tenantContentCleanupJobs.id, jobId),
    });
    if (!job) return;
    if (job.action === "tenant_deleted" && (job.status === "failed" || job.status === "terminal")) {
      await this.finishDeleteLease(job.tenantId, false);
      return;
    }
    await this.applyRuntimeLifecycle(job);
    if (job.action === "tenant_deleted") {
      const tenant = await this.db.query.tenants.findFirst({
        where: eq(tenants.id, job.tenantId),
        columns: { id: true },
      });
      if (!tenant && job.status === "completed") {
        await this.finalizeDeletedTenant(job.tenantId);
      }
    }
  }
}
