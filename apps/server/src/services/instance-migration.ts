/**
 * MCP/component 实例跨 Runner 迁移：stop → export 数据卷 → import → 更新 runtime_node_id → start
 */
import { and, eq, isNull, lte, or } from "drizzle-orm";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOCAL_RUNTIME_NODE_ID } from "@zakura/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { componentInstances } from "../db/schema.js";
import type { Orchestrator } from "./orchestrator.js";
import type { RuntimeNodeService } from "./runtime-nodes.js";

function isLocalNodeId(id: string | null | undefined): boolean {
  return !id || id === LOCAL_RUNTIME_NODE_ID || id === "local";
}

export class InstanceMigrationService {
  private readonly inFlight = new Map<
    string,
    Promise<{ ok: true; runtimeNodeId: string | null }>
  >();

  constructor(
    private readonly db: Db,
    private readonly config: AppConfig,
    private readonly nodes: RuntimeNodeService,
    private readonly orchestrator: Orchestrator,
  ) {
    mkdirSync(this.stagingDir(), { recursive: true });
  }

  private stagingDir(): string {
    return join(this.config.migrationDir, "instances");
  }

  async migrate(
    tenantId: string,
    instanceId: string,
    targetNodeId: string,
  ): Promise<{ ok: true; runtimeNodeId: string | null }> {
    const key = `${tenantId}:${instanceId}`;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const run = this.migrateOnce(tenantId, instanceId, targetNodeId);
    this.inFlight.set(key, run);
    try {
      return await run;
    } finally {
      if (this.inFlight.get(key) === run) this.inFlight.delete(key);
    }
  }

  private async migrateOnce(
    tenantId: string,
    instanceId: string,
    targetNodeId: string,
  ): Promise<{ ok: true; runtimeNodeId: string | null }> {
    const instance = await this.db.query.componentInstances.findFirst({
      where: and(
        eq(componentInstances.id, instanceId),
        eq(componentInstances.tenantId, tenantId),
      ),
    });
    if (!instance) throw new Error("实例不存在");
    if (instance.providerId !== "stdio-mcp") {
      throw new Error("仅容器 MCP（stdio）支持 Runner 迁移");
    }

    if (!instance.runtimeNodeId) {
      throw new Error("该实例未绑定运行节点，请先选择一台在线的 zakura-agent");
    }
    if (targetNodeId === "local" || !targetNodeId) {
      throw new Error("目标必须是在线的电脑或服务器，不再支持隐式本机节点");
    }
    const sourceId = instance.runtimeNodeId;
    const targetId = targetNodeId;
    if (sourceId === targetId) {
      return { ok: true, runtimeNodeId: instance.runtimeNodeId };
    }

    // Resolve through tenant access policy before stopping the source. A raw id
    // lookup here previously allowed a cross-tenant target to disrupt service.
    const target = await this.nodes.getAccessible(tenantId, targetId);
    if (!target) throw new Error("目标 Runner 不存在");
    if (target.status !== "online") throw new Error("目标 Runner 不在线");
    if (target.kind === "local" || isLocalNodeId(target.id)) {
      throw new Error("目标必须是在线的电脑或服务器，不再支持隐式本机节点");
    }

    if (isLocalNodeId(sourceId)) {
      throw new Error("旧本机节点已停用。请在两端都安装 zakura-agent 后再迁移。");
    }

    // Validate both control-plane clients before changing instance state.
    const { client: src } = await this.nodes.requireRunnerClient(tenantId, sourceId);
    const { client: dst } = await this.nodes.requireRunnerClient(tenantId, targetId);

    // Reuse the existing health lease column as a short-lived exclusive
    // instance-operation lease. Health probing already honors this column.
    const claimedAt = new Date();
    const leaseUntil = new Date(claimedAt.getTime() + 5 * 60_000);
    const claimed = await this.db
      .update(componentInstances)
      .set({ healthClaimUntil: leaseUntil, updatedAt: claimedAt })
      .where(
        and(
          eq(componentInstances.id, instanceId),
          eq(componentInstances.tenantId, tenantId),
          eq(componentInstances.runtimeNodeId, sourceId),
          or(
            isNull(componentInstances.healthClaimUntil),
            lte(componentInstances.healthClaimUntil, claimedAt),
          ),
        ),
      )
      .returning();
    if (!claimed.length) throw new Error("实例正在迁移或状态已变化，请稍后重试");

    const wasRunning = instance.status === "running" || instance.status === "starting";
    const safeId = instanceId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64) || "instance";
    let tempDir: string | null = null;
    let assignedTarget = false;
    try {
      tempDir = mkdtempSync(join(this.stagingDir(), `${safeId}-`));
      const archivePath = join(tempDir, "payload.tar.gz");
      if (wasRunning) await this.orchestrator.stopInstance(tenantId, instanceId);

      const { archive } = await src.exportInstanceMigration(instanceId, {
        sourceNodeId: sourceId,
      });
      writeFileSync(archivePath, archive, { mode: 0o600 });
      await dst.importInstanceMigration(instanceId, archive);

      const updated = await this.db
        .update(componentInstances)
        .set({ runtimeNodeId: target.id, updatedAt: new Date() })
        .where(
          and(
            eq(componentInstances.id, instanceId),
            eq(componentInstances.tenantId, tenantId),
            eq(componentInstances.runtimeNodeId, sourceId),
            eq(componentInstances.healthClaimUntil, leaseUntil),
          ),
        )
        .returning();
      if (!updated.length) throw new Error("实例状态在迁移期间发生变化，已拒绝覆盖");
      assignedTarget = true;

      if (wasRunning) await this.orchestrator.startInstance(tenantId, instanceId);
      return { ok: true, runtimeNodeId: target.id };
    } catch (err) {
      const failures: string[] = [err instanceof Error ? err.message : String(err)];
      let sourceAssignmentReady = !assignedTarget;
      if (assignedTarget) {
        try {
          const rolledBack = await this.db
            .update(componentInstances)
            .set({ runtimeNodeId: sourceId, updatedAt: new Date() })
            .where(
              and(
                eq(componentInstances.id, instanceId),
                eq(componentInstances.tenantId, tenantId),
                eq(componentInstances.runtimeNodeId, target.id),
                eq(componentInstances.healthClaimUntil, leaseUntil),
              ),
            )
            .returning();
          if (!rolledBack.length) {
            throw new Error("instance assignment changed before rollback");
          }
          sourceAssignmentReady = true;
        } catch (rollbackError) {
          failures.push(
            `assignment rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
          );
        }
      }
      if (wasRunning && sourceAssignmentReady) {
        try {
          await this.orchestrator.startInstance(tenantId, instanceId);
        } catch (restartError) {
          failures.push(
            `source restart failed: ${restartError instanceof Error ? restartError.message : String(restartError)}`,
          );
        }
      } else if (wasRunning) {
        failures.push("source restart skipped because assignment rollback was not confirmed");
      }
      throw new Error(`实例迁移失败：${failures.join("; ")}`);
    } finally {
      if (tempDir) rmSync(tempDir, { recursive: true, force: true });
      await this.db
        .update(componentInstances)
        .set({ healthClaimUntil: null, updatedAt: new Date() })
        .where(
          and(
            eq(componentInstances.id, instanceId),
            eq(componentInstances.tenantId, tenantId),
            eq(componentInstances.healthClaimUntil, leaseUntil),
          ),
        );
    }
  }
}
