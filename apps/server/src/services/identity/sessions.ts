import { and, desc, eq, isNull, lt, ne } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { tenantMemberships, tenants, userSessions, users } from "../../db/schema.js";
import type { SessionPayload } from "../auth.js";

export function sessionInvalidatedByPassword(iat: number | undefined, passwordUpdatedAt: Date | null | undefined): boolean {
  if (!passwordUpdatedAt) return false;
  const cutoff = Math.floor(passwordUpdatedAt.getTime() / 1000);
  return iat == null || iat < cutoff;
}

export type SessionLookup =
  | { status: "active"; session: SessionPayload }
  | { status: "invalid"; reason: "user" | "password" | "session" | "tenant" | "membership" }
  | { status: "suspended"; scope: "user" | "tenant"; reason: string | null; suspendedAt: Date };

/** Durable identity-session boundary shared by password and OAuth-created sessions. */
export class IdentitySessionService {
  constructor(private readonly db: Db) {}

  async lookup(payload: SessionPayload): Promise<SessionLookup> {
    if (payload.userId === "api-key") return { status: "active", session: payload };
    const [user, tenant, membership] = await Promise.all([
      this.db.query.users.findFirst({ where: eq(users.id, payload.userId) }),
      this.db.query.tenants.findFirst({ where: eq(tenants.id, payload.tenantId) }),
      this.db.query.tenantMemberships.findFirst({
        where: and(
          eq(tenantMemberships.userId, payload.userId),
          eq(tenantMemberships.tenantId, payload.tenantId),
        ),
      }),
    ]);
    if (!user) return { status: "invalid", reason: "user" };
    if (sessionInvalidatedByPassword(payload.iat, user.passwordUpdatedAt)) return { status: "invalid", reason: "password" };
    if (!tenant) return { status: "invalid", reason: "tenant" };
    if (!membership || membership.status !== "active") return { status: "invalid", reason: "membership" };
    if (user.suspendedAt) return { status: "suspended", scope: "user", reason: user.suspendedReason, suspendedAt: user.suspendedAt };
    if (tenant.suspendedAt) return { status: "suspended", scope: "tenant", reason: tenant.suspendedReason, suspendedAt: tenant.suspendedAt };

    if (payload.sid) {
      const row = await this.db.query.userSessions.findFirst({ where: eq(userSessions.id, payload.sid) });
      if (!row || row.userId !== payload.userId || row.tenantId !== payload.tenantId || row.revokedAt || row.expiresAt.getTime() <= Date.now()) {
        return { status: "invalid", reason: "session" };
      }
    }
    return { status: "active", session: { ...payload, role: membership.role, email: user.email, isPlatformAdmin: user.isPlatformAdmin } };
  }

  async list(userId: string, currentSid?: string) {
    const rows = await this.db.select().from(userSessions)
      .where(and(eq(userSessions.userId, userId), isNull(userSessions.revokedAt)))
      .orderBy(desc(userSessions.createdAt)).limit(50);
    return rows.map((row) => ({ id: row.id, tenantId: row.tenantId, userAgent: row.userAgent, ip: row.ip, createdAt: row.createdAt.toISOString(), expiresAt: row.expiresAt.toISOString(), current: currentSid === row.id }));
  }

  async revoke(userId: string, sid: string): Promise<boolean> {
    const rows = await this.db.update(userSessions).set({ revokedAt: new Date() })
      .where(and(eq(userSessions.id, sid), eq(userSessions.userId, userId), isNull(userSessions.revokedAt))).returning();
    return rows.length > 0;
  }

  async revokeOthers(userId: string, exceptSid?: string): Promise<number> {
    const filters = [eq(userSessions.userId, userId), isNull(userSessions.revokedAt)];
    if (exceptSid) filters.push(ne(userSessions.id, exceptSid));
    const rows = await this.db.update(userSessions).set({ revokedAt: new Date() }).where(and(...filters)).returning({ id: userSessions.id });
    return rows.length;
  }

  async purgeExpired(now = new Date()): Promise<number> {
    const rows = await this.db.delete(userSessions).where(lt(userSessions.expiresAt, now)).returning({ id: userSessions.id });
    return rows.length;
  }
}

export async function assertSessionAlive(db: Db, payload: SessionPayload): Promise<SessionPayload | null> {
  const result = await new IdentitySessionService(db).lookup(payload);
  // Middleware preserves its established 403 suspension response via account-status.
  return result.status === "active" ? result.session : result.status === "suspended" ? payload : null;
}
export const listUserSessions = (db: Db, userId: string, currentSid?: string) => new IdentitySessionService(db).list(userId, currentSid);
export const revokeUserSession = (db: Db, userId: string, sid: string) => new IdentitySessionService(db).revoke(userId, sid);
export const revokeAllUserSessions = (db: Db, userId: string, exceptSid?: string) => new IdentitySessionService(db).revokeOthers(userId, exceptSid);
export async function touchLastLogin(db: Db, userId: string): Promise<void> { const now = new Date(); await db.update(users).set({ lastLoginAt: now, updatedAt: now }).where(eq(users.id, userId)); }
export async function purgeExpiredUserSessions(db: Db): Promise<void> { await new IdentitySessionService(db).purgeExpired(); }
