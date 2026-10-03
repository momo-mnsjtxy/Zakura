export const TENANT_ROLES = ["member", "admin", "owner"] as const;
export const MEMBERSHIP_STATUSES = ["active", "suspended"] as const;

export type TenantRole = (typeof TENANT_ROLES)[number];
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

const ROLE_RANK: Record<TenantRole, number> = {
  member: 0,
  admin: 1,
  owner: 2,
};

export function isTenantRole(value: unknown): value is TenantRole {
  return typeof value === "string" && TENANT_ROLES.includes(value as TenantRole);
}

export function isMembershipStatus(value: unknown): value is MembershipStatus {
  return typeof value === "string" && MEMBERSHIP_STATUSES.includes(value as MembershipStatus);
}

export function isTenantAdmin(role: unknown): boolean {
  return role === "owner" || role === "admin";
}

export function roleAtLeast(actual: unknown, required: TenantRole): boolean {
  return isTenantRole(actual) && ROLE_RANK[actual] >= ROLE_RANK[required];
}

/** Invites and directory sync cannot silently reduce existing authority. */
export function strongestRole(left: unknown, right: unknown): TenantRole {
  const a = isTenantRole(left) ? left : "member";
  const b = isTenantRole(right) ? right : "member";
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

export function inviteRole(value: unknown): "admin" | "member" {
  return value === "admin" ? "admin" : "member";
}
