import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const SENSITIVE = /secret|token|password|assertion|samlresponse|authorization|credential/i;

export function hashToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function newSecretToken(prefix: string, bytes = 32): string {
  return `${prefix}_${randomBytes(bytes).toString("hex")}`;
}

export function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function emailDomain(email: string): string | null {
  const at = email.trim().toLowerCase().lastIndexOf("@");
  if (at < 1) return null;
  const domain = email.trim().toLowerCase().slice(at + 1);
  return domain || null;
}

export function normalizeDomain(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");
}

export function parseJsonObject(raw: string | null | undefined): Record<string, unknown> {
  try {
    const value = JSON.parse(raw || "{}") as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** 审计 detail 去掉密钥类字段。 */
export function redactAuditDetail(detail: Record<string, unknown>): Record<string, unknown> {
  const seen = new WeakSet<object>();
  let budget = 500;
  const visit = (value: unknown, depth: number): unknown => {
    if (--budget < 0 || depth > 5) return "[truncated]";
    if (typeof value === "string") {
      return value.length > 500 ? `${value.slice(0, 80)}…` : value;
    }
    if (value === null || typeof value === "number" || typeof value === "boolean") return value;
    if (value instanceof Date) return value.toISOString();
    if (Array.isArray(value)) return value.slice(0, 50).map((entry) => visit(entry, depth + 1));
    if (!value || typeof value !== "object") return String(value ?? "");
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value).slice(0, 100)) {
      if (SENSITIVE.test(key)) continue;
      out[key] = visit(child, depth + 1);
    }
    return out;
  };
  return visit(detail, 0) as Record<string, unknown>;
}

export function rpFromWebUrl(webPublicUrl: string): { rpID: string; origin: string; name: string } {
  const url = new URL(webPublicUrl);
  return { rpID: url.hostname, origin: url.origin, name: "Zakura" };
}

export function clientIpFromHeaders(header: (name: string) => string | undefined): string | null {
  const forwarded = header("x-forwarded-for");
  if (forwarded) {
    const first = forwarded.split(",")[0]?.trim();
    if (first) return first;
  }
  return header("x-real-ip")?.trim() || null;
}
