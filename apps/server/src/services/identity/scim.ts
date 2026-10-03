import { and, asc, eq, isNull, ne, sql } from "drizzle-orm";
import type { Db } from "../../db/client.js";
import {
  newId,
  scimUserMappings,
  tenantMemberships,
  tenantScimTokens,
  tenants,
  users,
} from "../../db/schema.js";
import { hashToken, newSecretToken, parseJsonObject } from "./util.js";
import { inviteRole } from "./tenant-policy.js";
import type { TenantLifecycleNotifier } from "../tenants.js";

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

// drizzle's PGlite/Postgres transaction callback types do not distribute over
// the Db union, although both executors expose the same schema/query contract.
function transactionDb(value: unknown): Db {
  return value as Db;
}

export class ScimError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly scimType?: string,
  ) {
    super(message);
    this.name = "ScimError";
  }
}

export function scimErrorBody(err: ScimError) {
  return {
    schemas: [ERROR_SCHEMA],
    status: String(err.status),
    detail: err.message,
    ...(err.scimType ? { scimType: err.scimType } : {}),
  };
}

export async function authenticateScim(db: Db, bearer: string | null) {
  if (!bearer) throw new ScimError("Unauthorized", 401);
  const tokenHash = hashToken(bearer);
  const row = await db.query.tenantScimTokens.findFirst({
    where: and(eq(tenantScimTokens.tokenHash, tokenHash), isNull(tenantScimTokens.revokedAt)),
  });
  if (!row) throw new ScimError("Unauthorized", 401);
  const tenant = await db.query.tenants.findFirst({ where: eq(tenants.id, row.tenantId) });
  if (!tenant || tenant.suspendedAt) throw new ScimError("Tenant unavailable", 403);
  await db.update(tenantScimTokens).set({ lastUsedAt: new Date() }).where(eq(tenantScimTokens.id, row.id));
  return row;
}

export function normalizeGroupRoleMap(input: Record<string, unknown>): Record<string, "admin" | "member"> {
  const normalized: Record<string, "admin" | "member"> = {};
  for (const [rawName, rawRole] of Object.entries(input)) {
    const name = rawName.trim();
    if (!name || name.length > 120) continue;
    normalized[name] = inviteRole(rawRole);
  }
  return normalized;
}

export async function listScimTokens(db: Db, tenantId: string) {
  const rows = await db.query.tenantScimTokens.findMany({
    where: and(eq(tenantScimTokens.tenantId, tenantId), isNull(tenantScimTokens.revokedAt)),
  });
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    tokenPrefix: row.tokenPrefix,
    groupRoleMap: parseJsonObject(row.groupRoleMap),
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function createScimToken(
  db: Db,
  tenantId: string,
  input?: { name?: string; groupRoleMap?: Record<string, string> },
) {
  const raw = newSecretToken("scim");
  const groupRoleMap = normalizeGroupRoleMap(input?.groupRoleMap ?? { Admins: "admin" });
  const [row] = await db
    .insert(tenantScimTokens)
    .values({
      id: newId(),
      tenantId,
      name: input?.name?.trim() || "SCIM",
      tokenHash: hashToken(raw),
      tokenPrefix: raw.slice(0, 12),
      groupRoleMap: JSON.stringify(groupRoleMap),
      createdAt: new Date(),
    })
    .returning();
  return { token: raw, id: row.id, name: row.name, tokenPrefix: row.tokenPrefix };
}

export async function revokeScimToken(db: Db, tenantId: string, tokenId: string) {
  const rows = await db
    .update(tenantScimTokens)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(tenantScimTokens.id, tokenId),
        eq(tenantScimTokens.tenantId, tenantId),
        isNull(tenantScimTokens.revokedAt),
      ),
    )
    .returning();
  if (!rows.length) throw new ScimError("SCIM token not found", 404);
}

export async function patchScimTokenMap(
  db: Db,
  tenantId: string,
  tokenId: string,
  groupRoleMap: Record<string, string>,
) {
  const rows = await db
    .update(tenantScimTokens)
    .set({ groupRoleMap: JSON.stringify(normalizeGroupRoleMap(groupRoleMap)) })
    .where(
      and(
        eq(tenantScimTokens.id, tokenId),
        eq(tenantScimTokens.tenantId, tenantId),
        isNull(tenantScimTokens.revokedAt),
      ),
    )
    .returning();
  if (!rows.length) throw new ScimError("SCIM token not found", 404);
}

type ScimUser = {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  name?: { formatted?: string };
  displayName?: string;
  emails?: Array<{ value: string; primary?: boolean }>;
  active: boolean;
  meta: { resourceType: string };
};

function toScimUser(input: {
  mappingId: string;
  externalId: string;
  email: string;
  name: string | null;
  active: boolean;
}): ScimUser {
  return {
    schemas: [USER_SCHEMA],
    id: input.mappingId,
    externalId: input.externalId,
    userName: input.email,
    name: { formatted: input.name ?? input.email },
    displayName: input.name ?? input.email,
    emails: [{ value: input.email, primary: true }],
    active: input.active,
    meta: { resourceType: "User" },
  };
}

export function parseScimFilter(filter: string | undefined): { email?: string } {
  if (!filter) return {};
  const match = /(?:userName|emails\.value)\s+eq\s+"([^"]+)"/i.exec(filter);
  return match?.[1] ? { email: match[1].toLowerCase() } : {};
}

async function loadMappedUser(db: Db, tenantId: string, mappingId: string) {
  const mapping = await db.query.scimUserMappings.findFirst({
    where: and(eq(scimUserMappings.id, mappingId), eq(scimUserMappings.tenantId, tenantId)),
  });
  if (!mapping) throw new ScimError("User not found", 404);
  const user = await db.query.users.findFirst({ where: eq(users.id, mapping.userId) });
  if (!user) throw new ScimError("User not found", 404);
  const membership = await db.query.tenantMemberships.findFirst({
    where: and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.userId, user.id)),
  });
  return { mapping, user, membership };
}

async function assertGlobalProfileMutable(
  db: Db,
  tenantId: string,
  user: { id: string; email: string; name: string | null },
  next: { email: string; name: string | null },
): Promise<void> {
  if (user.email === next.email && user.name === next.name) return;
  const otherMembership = await db.query.tenantMemberships.findFirst({
    where: and(
      eq(tenantMemberships.userId, user.id),
      ne(tenantMemberships.tenantId, tenantId),
    ),
  });
  if (otherMembership) {
    throw new ScimError(
      "SCIM cannot change the global profile of a user shared with another tenant",
      409,
      "mutability",
    );
  }
}

export async function scimGetUser(db: Db, tenantId: string, id: string) {
  const { mapping, user, membership } = await loadMappedUser(db, tenantId, id);
  return toScimUser({
    mappingId: mapping.id,
    externalId: mapping.externalId,
    email: user.email,
    name: user.name,
    active: membership?.status === "active" && !user.suspendedAt,
  });
}

export async function scimListUsers(
  db: Db,
  tenantId: string,
  query: { filter?: string; startIndex?: number; count?: number },
) {
  const parsed = parseScimFilter(query.filter);
  const requestedStart = Number(query.startIndex ?? 1);
  const requestedCount = Number(query.count ?? 100);
  const startIndex = Number.isFinite(requestedStart) ? Math.max(Math.floor(requestedStart), 1) : 1;
  const count = Number.isFinite(requestedCount)
    ? Math.min(Math.max(Math.floor(requestedCount), 1), 200)
    : 100;
  const where = and(
    eq(scimUserMappings.tenantId, tenantId),
    ...(parsed.email ? [eq(users.email, parsed.email)] : []),
  );
  const [[total], rows] = await Promise.all([
    db
      .select({ count: sql<number>`count(*)::int` })
      .from(scimUserMappings)
      .innerJoin(users, eq(users.id, scimUserMappings.userId))
      .where(where),
    db
      .select({
        mappingId: scimUserMappings.id,
        externalId: scimUserMappings.externalId,
        email: users.email,
        name: users.name,
        userSuspendedAt: users.suspendedAt,
        membershipStatus: tenantMemberships.status,
      })
      .from(scimUserMappings)
      .innerJoin(users, eq(users.id, scimUserMappings.userId))
      .leftJoin(
        tenantMemberships,
        and(
          eq(tenantMemberships.tenantId, tenantId),
          eq(tenantMemberships.userId, users.id),
        ),
      )
      .where(where)
      .orderBy(asc(scimUserMappings.createdAt), asc(scimUserMappings.id))
      .limit(count)
      .offset(startIndex - 1),
  ]);
  const resources = rows.map((row) =>
    toScimUser({
      mappingId: row.mappingId,
      externalId: row.externalId,
      email: row.email,
      name: row.name,
      active: row.membershipStatus === "active" && !row.userSuspendedAt,
    }),
  );
  return {
    schemas: [LIST_SCHEMA],
    totalResults: Number(total?.count ?? 0),
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

export function membershipStatusFromScimActive(active: boolean): "active" | "suspended" {
  return active ? "active" : "suspended";
}

export function readScimUserPayload(body: Record<string, unknown>) {
  const userName = String(body.userName ?? "").trim().toLowerCase();
  const emails = body.emails as Array<{ value?: string }> | undefined;
  const email = (emails?.[0]?.value || userName).trim().toLowerCase();
  if (!email || !email.includes("@")) throw new ScimError("userName/email required", 400);
  const nameObj = body.name as { formatted?: string; givenName?: string; familyName?: string } | undefined;
  const name =
    (typeof body.displayName === "string" && body.displayName) ||
    nameObj?.formatted ||
    [nameObj?.givenName, nameObj?.familyName].filter(Boolean).join(" ") ||
    email.split("@")[0];
  const active = body.active !== false;
  const externalId = String(body.externalId ?? email);
  return { email, name, active, externalId };
}

export async function scimCreateUser(
  db: Db,
  tenantId: string,
  body: Record<string, unknown>,
  defaultRole = "member",
  lifecycle?: TenantLifecycleNotifier,
) {
  const payload = readScimUserPayload(body);
  try {
    const result = await db.transaction(async (tx) => {
      const database = transactionDb(tx);
      const existingMap = await database.query.scimUserMappings.findFirst({
        where: and(
          eq(scimUserMappings.tenantId, tenantId),
          eq(scimUserMappings.externalId, payload.externalId),
        ),
      });
      if (existingMap) throw new ScimError("User already exists", 409, "uniqueness");

      const now = new Date();
      let user = await database.query.users.findFirst({ where: eq(users.email, payload.email) });
      if (!user) {
        const [created] = await database
          .insert(users)
          .values({
            id: newId(),
            email: payload.email,
            name: payload.name,
            // Provisioned identities have no password until an explicit reset flow.
            passwordHash: null,
            emailVerifiedAt: now,
            createdAt: now,
            updatedAt: now,
          })
          .returning();
        user = created;
      }

      const existingUserMap = await database.query.scimUserMappings.findFirst({
        where: and(
          eq(scimUserMappings.tenantId, tenantId),
          eq(scimUserMappings.userId, user.id),
        ),
      });
      if (existingUserMap) {
        throw new ScimError("User already provisioned with another externalId", 409, "uniqueness");
      }

      let membership = await database.query.tenantMemberships.findFirst({
        where: and(eq(tenantMemberships.tenantId, tenantId), eq(tenantMemberships.userId, user.id)),
      });
      const membershipWasActive = membership?.status === "active";
      if (membership?.role === "owner" && !payload.active) {
        throw new ScimError("SCIM cannot deactivate a tenant owner", 409, "mutability");
      }
      if (!membership) {
        [membership] = await database
          .insert(tenantMemberships)
          .values({
            id: newId(),
            tenantId,
            userId: user.id,
            role: inviteRole(defaultRole),
            status: membershipStatusFromScimActive(payload.active),
            createdAt: now,
            updatedAt: now,
          })
          .returning();
      } else if (membership.status !== membershipStatusFromScimActive(payload.active)) {
        [membership] = await database
          .update(tenantMemberships)
          .set({ status: membershipStatusFromScimActive(payload.active), updatedAt: now })
          .where(
            and(
              eq(tenantMemberships.id, membership.id),
              eq(tenantMemberships.tenantId, tenantId),
            ),
          )
          .returning();
      }

      const [mapping] = await database
        .insert(scimUserMappings)
        .values({
          id: newId(),
          tenantId,
          userId: user.id,
          externalId: payload.externalId,
          createdAt: now,
        })
        .returning();
      return {
        user: toScimUser({
          mappingId: mapping.id,
          externalId: mapping.externalId,
          email: user.email,
          name: user.name,
          active: membership.status === "active" && !user.suspendedAt,
        }),
        revokedUserId:
          membershipWasActive && membership.status === "suspended" ? user.id : null,
      };
    });
    if (result.revokedUserId) {
      await lifecycle?.notifyMemberAccessRevoked(tenantId, result.revokedUserId);
    }
    return result.user;
  } catch (error) {
    if (error instanceof ScimError) throw error;
    if (isUniqueViolation(error)) {
      throw new ScimError("User already exists", 409, "uniqueness");
    }
    throw error;
  }
}

export async function scimReplaceUser(
  db: Db,
  tenantId: string,
  id: string,
  body: Record<string, unknown>,
  lifecycle?: TenantLifecycleNotifier,
) {
  const payload = readScimUserPayload(body);
  const result = await db.transaction(async (tx) => {
    const database = transactionDb(tx);
    const { mapping, user, membership } = await loadMappedUser(database, tenantId, id);
    if (membership?.role === "owner" && !payload.active) {
      throw new ScimError("SCIM cannot deactivate a tenant owner", 409, "mutability");
    }
    await assertGlobalProfileMutable(database, tenantId, user, {
      email: payload.email,
      name: payload.name,
    });
    await database
      .update(users)
      .set({ name: payload.name, email: payload.email, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    if (membership) {
      await database
        .update(tenantMemberships)
        .set({ status: membershipStatusFromScimActive(payload.active), updatedAt: new Date() })
        .where(
          and(eq(tenantMemberships.id, membership.id), eq(tenantMemberships.tenantId, tenantId)),
        );
    }
    if (payload.externalId !== mapping.externalId) {
      await database
        .update(scimUserMappings)
        .set({ externalId: payload.externalId })
        .where(
          and(eq(scimUserMappings.id, mapping.id), eq(scimUserMappings.tenantId, tenantId)),
        );
    }
    return {
      user: toScimUser({
        mappingId: mapping.id,
        externalId: payload.externalId,
        email: payload.email,
        name: payload.name,
        active: payload.active,
      }),
      revokedUserId: membership?.status === "active" && !payload.active ? user.id : null,
    };
  });
  if (result.revokedUserId) {
    await lifecycle?.notifyMemberAccessRevoked(tenantId, result.revokedUserId);
  }
  return result.user;
}

export async function scimPatchUser(
  db: Db,
  tenantId: string,
  id: string,
  body: Record<string, unknown>,
  lifecycle?: TenantLifecycleNotifier,
) {
  const ops = (body.Operations ?? body.operations) as Array<{ op?: string; path?: string; value?: unknown }> | undefined;
  if (!Array.isArray(ops)) return scimReplaceUser(db, tenantId, id, body, lifecycle);
  const result = await db.transaction(async (tx) => {
    const database = transactionDb(tx);
    const { mapping, user, membership } = await loadMappedUser(database, tenantId, id);
    let active = membership?.status === "active";
    let name = user.name;
    let email = user.email;
    for (const op of ops) {
      const operation = (op.op ?? "replace").toLowerCase();
      const path = (op.path ?? "").toLowerCase();
      if ((operation === "replace" || operation === "add") && (path === "active" || !path)) {
        if (path === "active") active = Boolean(op.value);
        else if (op.value && typeof op.value === "object") {
          const value = op.value as Record<string, unknown>;
          if ("active" in value) active = Boolean(value.active);
          if (typeof value.displayName === "string") name = value.displayName;
          if (typeof value.userName === "string") email = value.userName.toLowerCase();
        }
      } else if ((operation === "replace" || operation === "add") && path === "displayname") {
        name = typeof op.value === "string" ? op.value : name;
      } else if ((operation === "replace" || operation === "add") && path === "username") {
        email = typeof op.value === "string" ? op.value.trim().toLowerCase() : email;
      }
    }
    if (!email.includes("@")) throw new ScimError("Valid userName required", 400, "invalidValue");
    if (membership?.role === "owner" && !active) {
      throw new ScimError("SCIM cannot deactivate a tenant owner", 409, "mutability");
    }
    await assertGlobalProfileMutable(database, tenantId, user, { email, name });
    await database
      .update(users)
      .set({ name, email, updatedAt: new Date() })
      .where(eq(users.id, user.id));
    if (membership) {
      await database
        .update(tenantMemberships)
        .set({ status: membershipStatusFromScimActive(active), updatedAt: new Date() })
        .where(
          and(eq(tenantMemberships.id, membership.id), eq(tenantMemberships.tenantId, tenantId)),
        );
    }
    return {
      user: toScimUser({
        mappingId: mapping.id,
        externalId: mapping.externalId,
        email,
        name,
        active,
      }),
      revokedUserId: membership?.status === "active" && !active ? user.id : null,
    };
  });
  if (result.revokedUserId) {
    await lifecycle?.notifyMemberAccessRevoked(tenantId, result.revokedUserId);
  }
  return result.user;
}

export async function scimDeleteUser(
  db: Db,
  tenantId: string,
  id: string,
  lifecycle?: TenantLifecycleNotifier,
) {
  const revokedUserId = await db.transaction(async (tx) => {
    const database = transactionDb(tx);
    const { user, membership } = await loadMappedUser(database, tenantId, id);
    if (!membership) return null;
    if (membership.role === "owner") {
      throw new ScimError("SCIM cannot deactivate a tenant owner", 409, "mutability");
    }
    if (membership.status !== "active") return null;
    await database
      .update(tenantMemberships)
      .set({ status: membershipStatusFromScimActive(false), updatedAt: new Date() })
      .where(and(eq(tenantMemberships.id, membership.id), eq(tenantMemberships.tenantId, tenantId)));
    return user.id;
  });
  if (revokedUserId) {
    await lifecycle?.notifyMemberAccessRevoked(tenantId, revokedUserId);
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; cause?: unknown };
  if (value.code === "23505") return true;
  return value.cause !== error && isUniqueViolation(value.cause);
}

function groupId(name: string): string {
  return hashToken(`group:${name}`).slice(0, 24);
}

export function listScimGroups(groupRoleMap: Record<string, unknown>) {
  const resources = Object.keys(normalizeGroupRoleMap(groupRoleMap)).map((displayName) => ({
    schemas: [GROUP_SCHEMA],
    id: groupId(displayName),
    displayName,
    meta: { resourceType: "Group" },
  }));
  return {
    schemas: [LIST_SCHEMA],
    totalResults: resources.length,
    startIndex: 1,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

export async function scimPatchGroup(
  db: Db,
  tenantId: string,
  id: string,
  groupRoleMap: Record<string, unknown>,
  body: Record<string, unknown>,
) {
  const normalizedMap = normalizeGroupRoleMap(groupRoleMap);
  const entry = Object.entries(normalizedMap).find(([name]) => groupId(name) === id);
  if (!entry) throw new ScimError("Group not found", 404);
  const role = entry[1];
  const ops = (body.Operations ?? body.operations) as Array<{ op?: string; path?: string; value?: unknown }> | undefined;
  if (!Array.isArray(ops)) throw new ScimError("Operations required", 400, "invalidSyntax");

  const mappingIds = new Set<string>();
  for (const op of ops) {
    const operation = (op.op ?? "replace").toLowerCase();
    const path = (op.path ?? "").toLowerCase();
    const values = Array.isArray(op.value)
      ? (op.value as Array<{ value?: string }>).map((value) => value.value).filter(Boolean) as string[]
      : [];
    const pathValue = /members\s*\[\s*value\s+eq\s+"([^"]+)"\s*\]/i.exec(path)?.[1];
    if (pathValue) values.push(pathValue);
    if (path !== "members" && !pathValue) continue;

    if (operation === "replace" && role === "admin") {
      const mappedUsers = await db
        .select({ userId: scimUserMappings.userId, mappingId: scimUserMappings.id })
        .from(scimUserMappings)
        .where(eq(scimUserMappings.tenantId, tenantId));
      const retained = new Set(values);
      const demoteUserIds = mappedUsers
        .filter((mapping) => !retained.has(mapping.mappingId))
        .map((mapping) => mapping.userId);
      for (const userId of demoteUserIds) {
        await db
          .update(tenantMemberships)
          .set({ role: "member", updatedAt: new Date() })
          .where(
            and(
              eq(tenantMemberships.tenantId, tenantId),
              eq(tenantMemberships.userId, userId),
              eq(tenantMemberships.role, "admin"),
            ),
          );
      }
    }

    if (operation === "remove") {
      if (role === "admin") {
        for (const mappingId of values) {
          const mapping = await db.query.scimUserMappings.findFirst({
            where: and(
              eq(scimUserMappings.tenantId, tenantId),
              eq(scimUserMappings.id, mappingId),
            ),
          });
          if (mapping) {
            await db
              .update(tenantMemberships)
              .set({ role: "member", updatedAt: new Date() })
              .where(
                and(
                  eq(tenantMemberships.tenantId, tenantId),
                  eq(tenantMemberships.userId, mapping.userId),
                  eq(tenantMemberships.role, "admin"),
                ),
              );
          }
        }
      }
      continue;
    }
    values.forEach((value) => mappingIds.add(value));
  }

  for (const mappingId of mappingIds) {
    const mapping = await db.query.scimUserMappings.findFirst({
      where: and(eq(scimUserMappings.tenantId, tenantId), eq(scimUserMappings.id, mappingId)),
    });
    if (!mapping) continue;
    await db
      .update(tenantMemberships)
      .set({ role, updatedAt: new Date() })
      .where(
        and(
          eq(tenantMemberships.tenantId, tenantId),
          eq(tenantMemberships.userId, mapping.userId),
          // Directory group sync never changes the protected owner role.
          sql`${tenantMemberships.role} <> 'owner'`,
        ),
      );
  }
  return { schemas: [GROUP_SCHEMA], id, displayName: entry[0], meta: { resourceType: "Group" } };
}
