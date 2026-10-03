export function adminFilterIntent(search) {
  const status = new URLSearchParams(search).get("status");
  return { status: status || "all" };
}

export function unsuspendUserRow(user) {
  return { ...user, suspended: false, suspendedAt: null, suspendedReason: null };
}

export function normalizeRetentionDays(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 365;
  return Math.max(1, Math.min(Math.floor(number), 3650));
}

export function enabledManagedServices(services) {
  return (services ?? []).filter((service) => service.mode !== "disabled");
}

export function auditExportMeta(headers) {
  const read = (name) => headers?.get?.(name);
  const total = Number(read("x-audit-total") ?? 0);
  const exported = Number(read("x-audit-exported") ?? 0);
  const truncated = read("x-audit-truncated") === "true" || (total > 0 && exported < total);
  return { total, exported, truncated };
}
