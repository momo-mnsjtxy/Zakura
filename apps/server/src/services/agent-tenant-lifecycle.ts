import { eq } from "drizzle-orm";
import type { Db } from "../db/client.js";
import { agents, spaces, type Space } from "../db/schema.js";
import type { AgentWorkspaceService } from "./agent-workspace.js";
import type { CloudAgentSessionStore } from "./cloud-agent-session.js";

export type AgentTenantDeleteLease = {
  /**
   * Release admission barriers after the tenant transaction settles. Pass true
   * only after its ownership rows committed their delete.
   */
  finish(deleted: boolean): Promise<void>;
};

/** Agent-owned seam consumed by the durable tenant content lifecycle. */
export type AgentTenantLifecycleCallbacks = {
  beginTenantDelete(tenantId: string): Promise<AgentTenantDeleteLease>;
  suspendTenant(tenantId: string): Promise<void>;
  revokeMember(tenantId: string, userId: string): Promise<void>;
};

type SessionDrainer = Pick<
  CloudAgentSessionStore,
  "beginAgentDeletionDrain" | "beginMemberSessionDrain"
>;

type WorkspaceTeardown = Pick<AgentWorkspaceService, "removeSpaceWorkspace">;

/**
 * Cohesive Agent/Space runtime teardown for tenant lifecycle transitions.
 * Database deletion stays owned by TenantService; this service quiesces and
 * removes runtime state while the aggregate rows are still available.
 */
export class AgentTenantLifecycleService {
  constructor(
    private readonly db: Db,
    private readonly workspace: WorkspaceTeardown,
    private readonly sessions: SessionDrainer,
  ) {}

  callbacks(): AgentTenantLifecycleCallbacks {
    return {
      beginTenantDelete: (tenantId) => this.beginTenantDelete(tenantId),
      suspendTenant: (tenantId) => this.suspendTenant(tenantId),
      revokeMember: (tenantId, userId) => this.revokeMember(tenantId, userId),
    };
  }

  private async topology(tenantId: string): Promise<{ spaces: Space[]; agentIds: string[] }> {
    const [tenantSpaces, tenantAgents] = await Promise.all([
      this.db.select().from(spaces).where(eq(spaces.tenantId, tenantId)),
      this.db.select({ id: agents.id }).from(agents).where(eq(agents.tenantId, tenantId)),
    ]);
    return { spaces: tenantSpaces, agentIds: tenantAgents.map((agent) => agent.id) };
  }

  private async removeWorkspaces(tenantSpaces: Space[]): Promise<void> {
    const results = await Promise.allSettled(
      tenantSpaces.map((space) => this.workspace.removeSpaceWorkspace(space)),
    );
    const failures = results.flatMap((result, index) =>
      result.status === "rejected"
        ? [{ spaceId: tenantSpaces[index]!.id, error: result.reason }]
        : [],
    );
    if (failures.length === 0) return;
    throw new Error(
      `tenant workspace teardown failed: ${failures.map(({ spaceId, error }) =>
        `${spaceId}: ${error instanceof Error ? error.message : String(error)}`
      ).join("; ")}`,
    );
  }

  async beginTenantDelete(tenantId: string): Promise<AgentTenantDeleteLease> {
    const topology = await this.topology(tenantId);
    const release = await this.sessions.beginAgentDeletionDrain(tenantId, topology.agentIds);
    try {
      await this.removeWorkspaces(topology.spaces);
    } catch (error) {
      await release(false);
      throw error;
    }

    let finished = false;
    let finishing: Promise<void> | null = null;
    return {
      finish: async (deleted) => {
        if (finished) return;
        if (finishing) return finishing;
        const attempt = release(deleted)
          .then(() => {
            finished = true;
          })
          .finally(() => {
            if (!finished) finishing = null;
          });
        finishing = attempt;
        return attempt;
      },
    };
  }

  async suspendTenant(tenantId: string): Promise<void> {
    const lease = await this.beginTenantDelete(tenantId);
    await lease.finish(false);
  }

  async revokeMember(tenantId: string, userId: string): Promise<void> {
    const release = await this.sessions.beginMemberSessionDrain(tenantId, userId);
    await release(false);
  }
}
