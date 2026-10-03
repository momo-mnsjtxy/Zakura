/* eslint-disable @typescript-eslint/no-explicit-any */
import { and, count, eq, ne, sql } from "drizzle-orm";

export type AdminMembershipRole = "owner" | "admin" | "member";
export type AdminMembershipStatus = "active" | "suspended";

export class SaasAdminError extends Error {
  constructor(
    message: string,
    public readonly status: 400 | 404 | 409,
  ) {
    super(message);
    this.name = "SaasAdminError";
  }
}

function readRole(value: unknown): AdminMembershipRole | undefined {
  return value === "owner" || value === "admin" || value === "member" ? value : undefined;
}

function readStatus(value: unknown): AdminMembershipStatus | undefined {
  return value === "active" || value === "suspended" ? value : undefined;
}

/**
 * Cross-tenant administrator membership lifecycle. The owner rows are locked
 * before checking invariants so concurrent demote/suspend/delete operations
 * cannot leave a tenant without an active owner.
 */
export class AdminMembershipService {
  private readonly memberships: any;

  constructor(
    private readonly db: any,
    schema: { tenantMemberships: unknown },
    private readonly lifecycle?: {
      notifyMemberAccessRevoked?: (tenantId: string, userId: string) => Promise<void>;
    },
  ) {
    this.memberships = schema.tenantMemberships;
  }

  private async lockOwners(tx: any, tenantId: string): Promise<void> {
    await tx.execute(
      sql`select id from ${this.memberships} where tenant_id = ${tenantId} and role = 'owner' for update`,
    );
  }

  private async find(tx: any, tenantId: string, membershipId: string) {
    return tx.query.tenantMemberships.findFirst({
      where: and(
        eq(this.memberships.id, membershipId),
        eq(this.memberships.tenantId, tenantId),
      ),
    });
  }

  private async assertOwnerRemains(
    tx: any,
    current: { id: string; tenantId: string; role: string; status: string },
    nextRole: AdminMembershipRole,
    nextStatus: AdminMembershipStatus,
  ): Promise<void> {
    const wasGoverning = current.role === "owner" && current.status === "active";
    const remainsGoverning = nextRole === "owner" && nextStatus === "active";
    if (!wasGoverning || remainsGoverning) return;
    const [other] = await tx
      .select({ n: count() })
      .from(this.memberships)
      .where(
        and(
          eq(this.memberships.tenantId, current.tenantId),
          eq(this.memberships.role, "owner"),
          eq(this.memberships.status, "active"),
          ne(this.memberships.id, current.id),
        ),
      );
    if (Number(other?.n ?? 0) === 0) {
      throw new SaasAdminError("团队至少保留一个活跃 owner", 400);
    }
  }

  async update(
    tenantId: string,
    membershipId: string,
    input: { role?: unknown; status?: unknown },
  ) {
    const role = input.role === undefined ? undefined : readRole(input.role);
    const status = input.status === undefined ? undefined : readStatus(input.status);
    if (input.role !== undefined && !role) {
      throw new SaasAdminError("role 必须是 owner / admin / member", 400);
    }
    if (input.status !== undefined && !status) {
      throw new SaasAdminError("status 必须是 active / suspended", 400);
    }
    if (!role && !status) throw new SaasAdminError("没有可更新的成员字段", 400);

    const result = await this.db.transaction(async (tx: any) => {
      await this.lockOwners(tx, tenantId);
      const membership = await this.find(tx, tenantId, membershipId);
      if (!membership) throw new SaasAdminError("Not found", 404);
      const nextRole = role ?? readRole(membership.role) ?? "member";
      const nextStatus = status ?? readStatus(membership.status) ?? "suspended";
      await this.assertOwnerRemains(tx, membership, nextRole, nextStatus);
      const [updated] = await tx
        .update(this.memberships)
        .set({
          ...(role ? { role } : {}),
          ...(status ? { status } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(this.memberships.id, membershipId),
            eq(this.memberships.tenantId, tenantId),
          ),
        )
        .returning();
      if (!updated) throw new SaasAdminError("Not found", 404);
      return {
        updated,
        revokedUserId:
          membership.status === "active" && updated.status === "suspended"
            ? String(membership.userId)
            : null,
      };
    });
    if (result.revokedUserId) {
      await this.lifecycle?.notifyMemberAccessRevoked?.(tenantId, result.revokedUserId);
    }
    return result.updated;
  }

  async remove(tenantId: string, membershipId: string): Promise<void> {
    const removedUserId = await this.db.transaction(async (tx: any) => {
      await this.lockOwners(tx, tenantId);
      const membership = await this.find(tx, tenantId, membershipId);
      if (!membership) throw new SaasAdminError("Not found", 404);
      await this.assertOwnerRemains(tx, membership, "member", "suspended");
      const deleted = await tx
        .delete(this.memberships)
        .where(
          and(
            eq(this.memberships.id, membershipId),
            eq(this.memberships.tenantId, tenantId),
          ),
        )
        .returning();
      if (!deleted.length) throw new SaasAdminError("Not found", 404);
      return String(membership.userId);
    });
    await this.lifecycle?.notifyMemberAccessRevoked?.(tenantId, removedUserId);
  }
}
