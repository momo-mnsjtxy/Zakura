import bcrypt from "bcryptjs";
import { and, asc, eq, isNull, or } from "drizzle-orm";
import { createHash, randomBytes } from "node:crypto";
import type { Db } from "../db/client.js";
import {
  newId,
  apiKeys,
  connectorAuthProfiles,
  connectorSettings,
  platformServiceQuotas,
  settings,
  skillSourceTokens,
  tenantInvites,
  tenantMemberships,
  tenants,
  users,
  type Tenant,
  type TenantInvite,
  type TenantMembership,
  type User,
} from "../db/schema.js";
import { CredentialLifecycleService } from "./identity/credential-lifecycle.js";
import { invalidateTenantSuspension } from "./account-status.js";
import { invalidateApiKeyAuthHashes } from "./auth.js";
import {
  inviteRole,
  isTenantRole,
  roleAtLeast,
  strongestRole,
  type MembershipStatus,
  type TenantRole,
} from "./identity/tenant-policy.js";

export { isTenantAdmin } from "./identity/tenant-policy.js";
export type { MembershipStatus, TenantRole } from "./identity/tenant-policy.js";

export type TenantOnboardingSteps = {
  profileNamed?: boolean;
  aiProviderConfigured?: boolean;
  mcpConnected?: boolean;
  connectReady?: boolean;
  agentTried?: boolean;
  /** @deprecated retained for persisted compatibility */
  agentCreated?: boolean;
  /** @deprecated retained for persisted compatibility */
  computerEnabled?: boolean;
  /** @deprecated retained for persisted compatibility */
  memoryConfigured?: boolean;
};

const ONBOARDING_KEYS = [
  "profileNamed",
  "aiProviderConfigured",
  "mcpConnected",
  "connectReady",
  "agentTried",
  "agentCreated",
  "computerEnabled",
  "memoryConfigured",
] as const satisfies readonly (keyof TenantOnboardingSteps)[];

function normalizeOnboardingSteps(input: Record<string, unknown>): TenantOnboardingSteps {
  const result: TenantOnboardingSteps = {};
  for (const key of ONBOARDING_KEYS) {
    if (typeof input[key] === "boolean") result[key] = input[key];
  }
  return result;
}

export function parseOnboardingSteps(raw: string | null | undefined): TenantOnboardingSteps {
  try {
    const value = JSON.parse(raw || "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? normalizeOnboardingSteps(value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function slugifyTenant(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || `tenant-${Date.now().toString(36)}`
  );
}

export type TenantLifecycleHook = {
  /** Stop external/background work before tenant-owned rows are removed. */
  beforeDelete?: (tenantId: string) => Promise<void> | void;
  /** Best-effort cache/runtime notification after the transaction commits. */
  afterDelete?: (tenantId: string) => Promise<void> | void;
  /** Idempotent post-commit notification that all tenant access was suspended. */
  afterSuspend?: (tenantId: string) => Promise<void> | void;
  /**
   * Idempotent post-commit notification that one user's tenant access was
   * revoked. This also fires when a membership is suspended rather than
   * physically removed.
   */
  afterMemberRemoved?: (tenantId: string, userId: string) => Promise<void> | void;
};

export type TenantLifecycleNotifier = {
  notifyTenantSuspended: (tenantId: string) => Promise<void>;
  notifyMemberAccessRevoked: (tenantId: string, userId: string) => Promise<void>;
};

function hashInviteToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function isEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; cause?: unknown };
  if (value.code === "23505") return true;
  return value.cause !== error && isUniqueViolation(value.cause);
}

// drizzle's PGlite/Postgres transaction callback types do not distribute over
// the Db union, although both executors expose the same schema/query contract.
function transactionDb(value: unknown): Db {
  return value as Db;
}

/**
 * Tenant aggregate boundary. Every member/invite mutation is tenant-qualified;
 * multi-row lifecycle transitions use a transaction so tokens cannot be consumed
 * without their resulting membership being durable.
 */
export class TenantService {
  private readonly lifecycleHooks = new Set<TenantLifecycleHook>();

  constructor(private readonly db: Db, hooks: readonly TenantLifecycleHook[] = []) {
    hooks.forEach((hook) => this.lifecycleHooks.add(hook));
  }

  registerLifecycleHook(hook: TenantLifecycleHook): () => void {
    this.lifecycleHooks.add(hook);
    return () => this.lifecycleHooks.delete(hook);
  }

  /**
   * Emit only after the mutation commits. Callers await these notifications so
   * runtime teardown failures are visible; handlers must be safe to retry.
   */
  async notifyTenantSuspended(tenantId: string): Promise<void> {
    await Promise.all(
      [...this.lifecycleHooks].map((hook) =>
        Promise.resolve().then(() => hook.afterSuspend?.(tenantId)),
      ),
    );
  }

  /** Emit after a membership delete or active -> suspended transition commits. */
  async notifyMemberAccessRevoked(tenantId: string, userId: string): Promise<void> {
    await Promise.all(
      [...this.lifecycleHooks].map((hook) =>
        Promise.resolve().then(() => hook.afterMemberRemoved?.(tenantId, userId)),
      ),
    );
  }

  async listForUser(userId: string) {
    const rows = await this.db
      .select({
        membershipId: tenantMemberships.id,
        role: tenantMemberships.role,
        status: tenantMemberships.status,
        tenantId: tenants.id,
        slug: tenants.slug,
        name: tenants.name,
        isDefault: tenants.isDefault,
        onboardingCompleted: tenants.onboardingCompleted,
        onboardingSteps: tenants.onboardingSteps,
      })
      .from(tenantMemberships)
      .innerJoin(tenants, eq(tenants.id, tenantMemberships.tenantId))
      .where(and(eq(tenantMemberships.userId, userId), eq(tenantMemberships.status, "active")))
      .orderBy(asc(tenants.createdAt));

    return rows.map((row) => ({
      membershipId: row.membershipId,
      role: row.role as TenantRole,
      status: row.status as MembershipStatus,
      tenant: {
        id: row.tenantId,
        slug: row.slug,
        name: row.name,
        isDefault: row.isDefault,
        onboardingCompleted: row.onboardingCompleted,
        onboardingSteps: parseOnboardingSteps(row.onboardingSteps),
      },
    }));
  }

  private async findMembership(tenantId: string, userId: string, activeOnly: boolean) {
    return (
      (await this.db.query.tenantMemberships.findFirst({
        where: and(
          eq(tenantMemberships.tenantId, tenantId),
          eq(tenantMemberships.userId, userId),
          ...(activeOnly ? [eq(tenantMemberships.status, "active")] : []),
        ),
      })) ?? null
    );
  }

  async getMembership(tenantId: string, userId: string): Promise<TenantMembership | null> {
    return this.findMembership(tenantId, userId, true);
  }

  async requireMembership(
    tenantId: string,
    userId: string,
    minRole: TenantRole = "member",
  ): Promise<TenantMembership> {
    const membership = await this.getMembership(tenantId, userId);
    if (!membership) throw new TenantAccessError("Not a member of this tenant", 403);
    if (!roleAtLeast(membership.role, minRole)) {
      throw new TenantAccessError(minRole === "owner" ? "Owner only" : "Admin only", 403);
    }
    return membership;
  }

  async createTenant(input: {
    name: string;
    slug?: string;
    ownerUserId: string;
    isDefault?: boolean;
  }): Promise<{ tenant: Tenant; membership: TenantMembership }> {
    const name = input.name.trim();
    if (!name) throw new TenantAccessError("Tenant name required", 400);
    const owner = await this.db.query.users.findFirst({ where: eq(users.id, input.ownerUserId) });
    if (!owner) throw new TenantAccessError("Owner user not found", 404);

    const requestedSlug = slugifyTenant(input.slug?.trim() || name);
    for (let attempt = 0; attempt < 8; attempt++) {
      const slug =
        attempt === 0
          ? requestedSlug
          : `${slugifyTenant(name).slice(0, 43)}-${randomBytes(2).toString("hex")}`;
      try {
        return await this.db.transaction(async (tx) => {
          const database = transactionDb(tx);
          const now = new Date();
          const [tenant] = await database
            .insert(tenants)
            .values({
              id: newId(),
              slug,
              name,
              isDefault: input.isDefault === true,
              onboardingCompleted: false,
              onboardingSteps: "{}",
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          const [membership] = await database
            .insert(tenantMemberships)
            .values({
              id: newId(),
              tenantId: tenant.id,
              userId: input.ownerUserId,
              role: "owner",
              status: "active",
              createdAt: now,
              updatedAt: now,
            })
            .returning();
          return { tenant, membership };
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        if (attempt === 7) throw new TenantAccessError("Tenant slug already exists", 409);
      }
    }
    throw new TenantAccessError("Could not allocate tenant slug", 409);
  }

  async updateTenant(tenantId: string, patch: { name?: string }): Promise<Tenant> {
    const [row] = await this.db
      .update(tenants)
      .set({ ...(patch.name?.trim() ? { name: patch.name.trim() } : {}), updatedAt: new Date() })
      .where(eq(tenants.id, tenantId))
      .returning();
    if (!row) throw new TenantAccessError("Tenant not found", 404);
    return row;
  }

  private async deleteTenantAggregate(tenantId: string) {
    const tenant = await this.db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
    if (!tenant) throw new TenantAccessError("Team not found", 404);
    if (tenant.isDefault) throw new TenantAccessError("The default team cannot be deleted", 400);

    for (const hook of this.lifecycleHooks) await hook.beforeDelete?.(tenantId);
    const keyRows = await this.db
      .select({ keyHash: apiKeys.keyHash })
      .from(apiKeys)
      .where(eq(apiKeys.tenantId, tenantId));
    await this.db.transaction(async (tx) => {
      const database = transactionDb(tx);
      // These ownership columns intentionally support non-tenant platform scopes,
      // so they cannot carry a tenant FK/cascade and must be removed explicitly.
      await database.delete(connectorAuthProfiles).where(eq(connectorAuthProfiles.scopeKey, tenantId));
      await database.delete(connectorSettings).where(eq(connectorSettings.scopeKey, tenantId));
      await database.delete(skillSourceTokens).where(eq(skillSourceTokens.scopeKey, tenantId));
      await database.delete(platformServiceQuotas).where(eq(platformServiceQuotas.scopeKey, tenantId));
      await database
        .delete(settings)
        .where(or(eq(settings.ownerKey, tenantId), eq(settings.ownerKey, `tenant:${tenantId}`)));
      await database.delete(tenants).where(eq(tenants.id, tenantId));
    });
    invalidateTenantSuspension(tenantId);
    await invalidateApiKeyAuthHashes(keyRows.map((row) => row.keyHash));
    for (const hook of this.lifecycleHooks) {
      await Promise.resolve().then(() => hook.afterDelete?.(tenantId)).catch((error) => {
        console.warn("[tenant] afterDelete hook failed", error);
      });
    }
    return { ok: true as const };
  }

  async deleteTenant(tenantId: string, actorUserId: string) {
    await this.requireMembership(tenantId, actorUserId, "owner");
    return this.deleteTenantAggregate(tenantId);
  }

  /** Platform-admin entry point; still uses the complete tenant aggregate cleanup. */
  async deleteTenantAsPlatformAdmin(tenantId: string) {
    return this.deleteTenantAggregate(tenantId);
  }

  async listMembers(tenantId: string) {
    const rows = await this.db
      .select({
        id: tenantMemberships.id,
        role: tenantMemberships.role,
        status: tenantMemberships.status,
        createdAt: tenantMemberships.createdAt,
        userId: users.id,
        email: users.email,
        name: users.name,
      })
      .from(tenantMemberships)
      .innerJoin(users, eq(users.id, tenantMemberships.userId))
      .where(eq(tenantMemberships.tenantId, tenantId))
      .orderBy(asc(tenantMemberships.createdAt));
    return rows.map((row) => ({
      id: row.id,
      role: row.role as TenantRole,
      status: row.status as MembershipStatus,
      createdAt: row.createdAt,
      user: { id: row.userId, email: row.email, name: row.name },
    }));
  }

  async updateMemberRole(
    tenantId: string,
    membershipId: string,
    role: TenantRole,
    actorUserId: string,
  ) {
    if (!isTenantRole(role)) throw new TenantAccessError("Invalid member role", 400);
    if (role === "owner") throw new TenantAccessError("Cannot assign owner via role update", 400);
    await this.requireMembership(tenantId, actorUserId, "admin");
    const target = await this.db.query.tenantMemberships.findFirst({
      where: and(eq(tenantMemberships.id, membershipId), eq(tenantMemberships.tenantId, tenantId)),
    });
    if (!target) throw new TenantAccessError("Member not found", 404);
    if (target.role === "owner") throw new TenantAccessError("Cannot change owner role", 400);
    const [row] = await this.db
      .update(tenantMemberships)
      .set({ role, updatedAt: new Date() })
      .where(and(eq(tenantMemberships.id, membershipId), eq(tenantMemberships.tenantId, tenantId)))
      .returning();
    if (!row) throw new TenantAccessError("Member not found", 404);
    return row;
  }

  async removeMember(tenantId: string, membershipId: string, actorUserId: string) {
    await this.requireMembership(tenantId, actorUserId, "admin");
    const removedUserId = await this.db.transaction(async (tx) => {
      const database = transactionDb(tx);
      const target = await database.query.tenantMemberships.findFirst({
        where: and(
          eq(tenantMemberships.id, membershipId),
          eq(tenantMemberships.tenantId, tenantId),
        ),
      });
      if (!target) throw new TenantAccessError("Member not found", 404);
      if (target.role === "owner") throw new TenantAccessError("Cannot remove owner", 400);
      if (target.userId === actorUserId) {
        throw new TenantAccessError("Cannot remove yourself; leave the tenant instead", 400);
      }
      const deleted = await database
        .delete(tenantMemberships)
        .where(
          and(eq(tenantMemberships.id, membershipId), eq(tenantMemberships.tenantId, tenantId)),
        )
        .returning();
      if (!deleted.length) throw new TenantAccessError("Member not found", 404);
      return target.userId;
    });
    await this.notifyMemberAccessRevoked(tenantId, removedUserId);
    return { ok: true as const };
  }

  async leaveTenant(tenantId: string, userId: string) {
    const membership = await this.getMembership(tenantId, userId);
    if (!membership) throw new TenantAccessError("Not a member", 404);
    if (membership.role === "owner") {
      throw new TenantAccessError("Owner cannot leave; transfer ownership first", 400);
    }
    await this.db
      .delete(tenantMemberships)
      .where(and(eq(tenantMemberships.id, membership.id), eq(tenantMemberships.tenantId, tenantId)));
    await this.notifyMemberAccessRevoked(tenantId, userId);
    return { ok: true as const };
  }

  async createInvite(input: {
    tenantId: string;
    email: string;
    role: "admin" | "member";
    invitedByUserId: string;
    ttlHours?: number;
  }): Promise<{ invite: TenantInvite; token: string }> {
    const email = input.email.trim().toLowerCase();
    if (!isEmail(email)) throw new TenantAccessError("Valid email required", 400);
    const ttlHours = input.ttlHours ?? 72;
    // Non-positive lifetimes are retained for administrative immediate-expiry
    // workflows and compatibility; only unbounded/far-future links are rejected.
    if (!Number.isFinite(ttlHours) || ttlHours > 24 * 30) {
      throw new TenantAccessError("Invite lifetime must not exceed 720 hours", 400);
    }
    await this.requireMembership(input.tenantId, input.invitedByUserId, "admin");
    const existingUser = await this.db.query.users.findFirst({ where: eq(users.email, email) });
    if (existingUser && (await this.findMembership(input.tenantId, existingUser.id, false))) {
      throw new TenantAccessError("User is already a member", 400);
    }

    const token = `inv_${randomBytes(24).toString("base64url")}`;
    return this.db.transaction(async (tx) => {
      const database = transactionDb(tx);
      const now = new Date();
      await database
        .delete(tenantInvites)
        .where(
          and(
            eq(tenantInvites.tenantId, input.tenantId),
            eq(tenantInvites.email, email),
            isNull(tenantInvites.acceptedAt),
          ),
        );
      const [invite] = await database
        .insert(tenantInvites)
        .values({
          id: newId(),
          tenantId: input.tenantId,
          email,
          role: inviteRole(input.role),
          tokenHash: hashInviteToken(token),
          invitedByUserId: input.invitedByUserId,
          expiresAt: new Date(now.getTime() + ttlHours * 3_600_000),
          createdAt: now,
        })
        .returning();
      return { invite, token };
    });
  }

  async listInvites(tenantId: string) {
    return this.db
      .select()
      .from(tenantInvites)
      .where(and(eq(tenantInvites.tenantId, tenantId), isNull(tenantInvites.acceptedAt)))
      .orderBy(asc(tenantInvites.createdAt));
  }

  async getInviteByToken(rawToken: string) {
    const invite = await this.db.query.tenantInvites.findFirst({
      where: eq(tenantInvites.tokenHash, hashInviteToken(rawToken)),
    });
    if (!invite) return null;
    const tenant = await this.db.query.tenants.findFirst({ where: eq(tenants.id, invite.tenantId) });
    return { invite, tenant };
  }

  async acceptInvite(input: {
    token: string;
    userId?: string;
    email?: string;
    password?: string;
    name?: string;
  }): Promise<{ user: User; tenant: Tenant; membership: TenantMembership }> {
    const found = await this.getInviteByToken(input.token);
    if (!found?.invite || !found.tenant) throw new TenantAccessError("Invalid invite", 404);
    const invite = found.invite;
    const invitedTenant = found.tenant;
    if (invite.acceptedAt) throw new TenantAccessError("Invite already used", 400);
    if (invite.expiresAt <= new Date()) throw new TenantAccessError("Invite expired", 400);
    if (invitedTenant.suspendedAt) throw new TenantAccessError("该团队已被封禁", 403);

    let user: User | undefined;
    let passwordHash: string | undefined;
    if (input.userId) {
      user = await this.db.query.users.findFirst({ where: eq(users.id, input.userId) });
      if (!user) throw new TenantAccessError("User not found", 404);
      if (user.email.toLowerCase() !== invite.email.toLowerCase()) {
        throw new TenantAccessError("Invite email does not match signed-in user", 403);
      }
    } else {
      const email = (input.email ?? invite.email).trim().toLowerCase();
      if (email !== invite.email.toLowerCase()) {
        throw new TenantAccessError("Email must match invite", 400);
      }
      user = await this.db.query.users.findFirst({ where: eq(users.email, email) });
      if (!user) {
        if (!input.password || input.password.length < 8) {
          throw new TenantAccessError("Password required (min 8 chars) to create account", 400);
        }
        passwordHash = await bcrypt.hash(input.password, 10);
      } else if (input.password) {
        if (!user.passwordHash || !(await bcrypt.compare(input.password, user.passwordHash))) {
          throw new TenantAccessError("Invalid credentials", 401);
        }
      }
    }
    if (user?.suspendedAt) throw new TenantAccessError("账号已被封禁", 403);

    return this.db.transaction(async (tx) => {
      const database = transactionDb(tx);
      if (!(await new CredentialLifecycleService(database).claimInvite(invite.id))) {
        throw new TenantAccessError("Invite already used", 400);
      }
      const tenant = await database.query.tenants.findFirst({ where: eq(tenants.id, invitedTenant.id) });
      if (!tenant) throw new TenantAccessError("Invalid invite", 404);
      if (tenant.suspendedAt) throw new TenantAccessError("该团队已被封禁", 403);

      const now = new Date();
      let claimedUser = user;
      if (!claimedUser) {
        const [created] = await database
          .insert(users)
          .values({
            id: newId(),
            email: invite.email,
            name: input.name?.trim() || invite.email.split("@")[0],
            passwordHash: passwordHash!,
            isPlatformAdmin: false,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        claimedUser = created;
      }

      const existing = await new TenantService(database).findMembership(tenant.id, claimedUser.id, false);
      let membership: TenantMembership;
      if (existing) {
        const [updated] = await database
          .update(tenantMemberships)
          .set({
            role: strongestRole(existing.role, invite.role),
            status: "active",
            updatedAt: now,
          })
          .where(and(eq(tenantMemberships.id, existing.id), eq(tenantMemberships.tenantId, tenant.id)))
          .returning();
        membership = updated;
      } else {
        const [created] = await database
          .insert(tenantMemberships)
          .values({
            id: newId(),
            tenantId: tenant.id,
            userId: claimedUser.id,
            role: inviteRole(invite.role),
            status: "active",
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        membership = created;
      }
      return { user: claimedUser, tenant, membership };
    });
  }

  async revokeInvite(tenantId: string, inviteId: string, actorUserId: string) {
    await this.requireMembership(tenantId, actorUserId, "admin");
    const deleted = await this.db
      .delete(tenantInvites)
      .where(and(eq(tenantInvites.id, inviteId), eq(tenantInvites.tenantId, tenantId)))
      .returning();
    if (!deleted.length) throw new TenantAccessError("Invite not found", 404);
    return { ok: true as const };
  }

  async getOnboarding(tenantId: string) {
    const tenant = await this.db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
    if (!tenant) throw new TenantAccessError("Tenant not found", 404);
    return {
      completed: tenant.onboardingCompleted,
      steps: parseOnboardingSteps(tenant.onboardingSteps),
    };
  }

  async patchOnboarding(
    tenantId: string,
    patch: { steps?: TenantOnboardingSteps; complete?: boolean },
  ) {
    const tenant = await this.db.query.tenants.findFirst({ where: eq(tenants.id, tenantId) });
    if (!tenant) throw new TenantAccessError("Tenant not found", 404);
    const steps = {
      ...parseOnboardingSteps(tenant.onboardingSteps),
      ...normalizeOnboardingSteps((patch.steps ?? {}) as Record<string, unknown>),
    };
    const completed =
      typeof patch.complete === "boolean" ? patch.complete : tenant.onboardingCompleted;
    const [row] = await this.db
      .update(tenants)
      .set({ onboardingSteps: JSON.stringify(steps), onboardingCompleted: completed, updatedAt: new Date() })
      .where(eq(tenants.id, tenantId))
      .returning();
    return { completed: row.onboardingCompleted, steps: parseOnboardingSteps(row.onboardingSteps) };
  }

  async listAll() {
    return this.db.select().from(tenants).orderBy(asc(tenants.createdAt));
  }
}

export class TenantAccessError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "TenantAccessError";
  }
}
