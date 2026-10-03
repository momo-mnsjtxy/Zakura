import { createPublicKey, createVerify, type JsonWebKey } from "node:crypto";

type Jwk = JsonWebKey & { kid?: string; kty?: string; alg?: string; use?: string };

const JWKS_TTL_MS = 10 * 60 * 1000;
const JWKS_TIMEOUT_MS = 10_000;
const JWKS_MAX_BYTES = 1024 * 1024;
const JWT_MAX_BYTES = 128 * 1024;

const jwksCache = new Map<string, { expiresAt: number; fetchedAt: number; keys: Jwk[] }>();
const jwksInflight = new Map<string, Promise<Jwk[]>>();

export function clearJwksCache(): void {
  jwksCache.clear();
  jwksInflight.clear();
}

function jsonObject(segment: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function decodeJwt(token: string): { header: Record<string, unknown>; payload: Record<string, unknown> } | null {
  if (!token || Buffer.byteLength(token, "utf8") > JWT_MAX_BYTES) return null;
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) return null;
  const header = jsonObject(parts[0]);
  const payload = jsonObject(parts[1]);
  return header && payload ? { header, payload } : null;
}

function validatedJwksUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("JWKS URL 无效");
  }
  if ((url.protocol !== "https:" && url.protocol !== "http:") || url.username || url.password || url.hash) {
    throw new Error("JWKS URL 无效");
  }
  return url.toString();
}

export async function fetchJwks(jwksUrl: string, forceRefresh = false): Promise<Jwk[]> {
  const key = validatedJwksUrl(jwksUrl);
  const cached = jwksCache.get(key);
  if (!forceRefresh && cached && cached.expiresAt > Date.now()) return cached.keys;
  const pending = jwksInflight.get(key);
  if (pending) return pending;

  const request = (async () => {
    const res = await fetch(key, { signal: AbortSignal.timeout(JWKS_TIMEOUT_MS) });
    if (!res.ok) throw new Error("无法读取 IdP JWKS");
    const declared = Number(res.headers.get("content-length") ?? 0);
    if (Number.isFinite(declared) && declared > JWKS_MAX_BYTES) {
      throw new Error("IdP JWKS 响应过大");
    }
    const raw = await res.text();
    if (Buffer.byteLength(raw, "utf8") > JWKS_MAX_BYTES) {
      throw new Error("IdP JWKS 响应过大");
    }
    let body: { keys?: unknown };
    try {
      body = JSON.parse(raw) as { keys?: unknown };
    } catch {
      throw new Error("IdP JWKS 响应无效");
    }
    const keys = Array.isArray(body.keys)
      ? body.keys.filter((item): item is Jwk => !!item && typeof item === "object").slice(0, 100)
      : [];
    if (!keys.length) throw new Error("JWKS 中没有可用密钥");
    const now = Date.now();
    jwksCache.set(key, { keys, fetchedAt: now, expiresAt: now + JWKS_TTL_MS });
    return keys;
  })();
  jwksInflight.set(key, request);
  try {
    return await request;
  } finally {
    if (jwksInflight.get(key) === request) jwksInflight.delete(key);
  }
}

function signingKeys(keys: Jwk[]): Jwk[] {
  return keys.filter(
    (key) =>
      key.kty === "RSA" &&
      (key.use === undefined || key.use === "sig") &&
      (key.alg === undefined || key.alg === "RS256"),
  );
}

function selectKey(keys: Jwk[], kid: string | null): Jwk | null {
  const eligible = signingKeys(keys);
  if (kid) return eligible.find((key) => key.kid === kid) ?? null;
  if (eligible.length !== 1) return null;
  return eligible[0] ?? null;
}

export async function verifyRs256Jwt(
  token: string,
  jwksUrl: string,
  expected: { issuer: string; audience: string; nonce?: string },
): Promise<Record<string, unknown>> {
  const decoded = decodeJwt(token);
  if (!decoded) throw new Error("id_token 无效");
  if (decoded.header.alg !== "RS256") throw new Error("仅支持 RS256 id_token");
  const kid = typeof decoded.header.kid === "string" && decoded.header.kid.trim()
    ? decoded.header.kid
    : null;
  let keys = await fetchJwks(jwksUrl);
  let jwk = selectKey(keys, kid);
  if (kid && !jwk) {
    keys = await fetchJwks(jwksUrl, true);
    jwk = selectKey(keys, kid);
  }
  if (!jwk) {
    throw new Error(kid ? "JWKS 中没有匹配的签名密钥" : "id_token 缺少明确的 kid");
  }

  let key;
  try {
    key = createPublicKey({ key: jwk, format: "jwk" });
  } catch {
    throw new Error("JWKS 签名密钥无效");
  }
  const parts = token.split(".");
  const verifier = createVerify("RSA-SHA256");
  verifier.update(`${parts[0]}.${parts[1]}`);
  verifier.end();
  if (!verifier.verify(key, Buffer.from(parts[2]!, "base64url"))) {
    throw new Error("id_token 签名无效");
  }

  const payload = decoded.payload;
  if (payload.iss !== expected.issuer) throw new Error("id_token issuer 不匹配");
  const aud = payload.aud;
  const audiences = Array.isArray(aud)
    ? aud.filter((value): value is string => typeof value === "string")
    : typeof aud === "string"
      ? [aud]
      : [];
  if (!audiences.includes(expected.audience)) throw new Error("id_token audience 不匹配");
  if (audiences.length > 1 && payload.azp !== expected.audience) {
    throw new Error("id_token azp 不匹配");
  }

  const now = Date.now() / 1000;
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || exp < now - 30) throw new Error("id_token 已过期");
  if (payload.nbf !== undefined) {
    const nbf = Number(payload.nbf);
    if (!Number.isFinite(nbf) || nbf > now + 30) throw new Error("id_token 尚未生效");
  }
  if (payload.iat !== undefined) {
    const iat = Number(payload.iat);
    if (!Number.isFinite(iat) || iat > now + 60) throw new Error("id_token 签发时间无效");
  }
  if (expected.nonce && payload.nonce !== expected.nonce) throw new Error("id_token nonce 不匹配");
  return payload;
}
