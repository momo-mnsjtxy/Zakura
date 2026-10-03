import { and, eq, gt, isNull, lt } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import { authTokens, tenantInvites, userRecoveryCodes } from "../../db/schema.js";
import { hashToken, parseJsonObject } from "./util.js";
import type { AuthTokenKind } from "./tokens.js";

/** Atomic one-time credential claims shared by verification, reset, MFA and invites. */
export class CredentialLifecycleService {
  constructor(private readonly db: Db) {}

  async consumeAuth(kind: AuthTokenKind, raw: string, now = new Date()) {
    const rows = await this.db.update(authTokens).set({ consumedAt: now }).where(and(
      eq(authTokens.tokenHash, hashToken(raw)),
      eq(authTokens.kind, kind),
      isNull(authTokens.consumedAt),
      gt(authTokens.expiresAt, now),
    )).returning();
    const row = rows[0];
    return row ? { userId: row.userId, meta: parseJsonObject(row.metaJson) } : null;
  }

  async consumeRecovery(userId: string, raw: string, now = new Date()): Promise<boolean> {
    const normalized = raw.trim().toLowerCase().replace(/[^a-f0-9]/g, "");
    if (normalized.length < 8) return false;
    const rows = await this.db.update(userRecoveryCodes).set({ usedAt: now }).where(and(
      eq(userRecoveryCodes.userId, userId),
      eq(userRecoveryCodes.codeHash, hashToken(normalized)),
      isNull(userRecoveryCodes.usedAt),
    )).returning();
    return rows.length === 1;
  }

  async claimInvite(id: string, now = new Date()): Promise<boolean> {
    const rows = await this.db.update(tenantInvites).set({ acceptedAt: now }).where(and(
      eq(tenantInvites.id, id), isNull(tenantInvites.acceptedAt), gt(tenantInvites.expiresAt, now),
    )).returning();
    return rows.length === 1;
  }

  async purgeExpired(now = new Date()): Promise<number> {
    const rows = await this.db.delete(authTokens).where(lt(authTokens.expiresAt, now)).returning();
    return rows.length;
  }
}
