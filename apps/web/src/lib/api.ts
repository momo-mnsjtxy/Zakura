"use client";

import { requestJson } from "./api-transport";

export { ApiError } from "./api-error";
export { getSession, setSession } from "./api-session";

const API_BASE = "";

export type PlatformInfo = {
  setupCompleted: boolean;
  version: string;
  mode: string;
  /** True when SaaS edition is active */
  multiTenant?: boolean;
  /** oss | saas */
  edition?: "oss" | "saas";
  /** Public self-registration (SaaS only) */
  registrationEnabled?: boolean;
  /** 邮箱密码登录；OAuth 启用后可由超管关闭 */
  passwordLoginEnabled?: boolean;
  /** Login OAuth providers (SaaS); secrets never included */
  oauthProviders?: Array<{ id: string; name: string; enabled: boolean }>;
  /** 登录页高亮方式：auto | password | oauth provider id */
  highlightedLoginMethod?: string;
};

type ApiInit = RequestInit & {
  json?: unknown;
  /**
   * GET 缓存 TTL（毫秒）。默认 2000；`false` / `0` 仅做 in-flight 去重不落缓存。
   * 轮询类接口（如 progress）请传 `false`。
   */
  cacheTtlMs?: number | false;
};

type CacheEntry = { expires: number; data: unknown };

const inflight = new Map<string, Promise<unknown>>();
const responseCache = new Map<string, CacheEntry>();
const DEFAULT_GET_TTL_MS = 2000;

/** 清除 GET 响应缓存。传 path 前缀时仅清除匹配项（如 `/api/agents`）。 */
export function invalidateApiCache(pathPrefix?: string) {
  if (!pathPrefix) {
    responseCache.clear();
    return;
  }
  for (const key of responseCache.keys()) {
    if (key.includes(pathPrefix)) responseCache.delete(key);
  }
}

function requestKey(method: string, path: string) {
  return `${method.toUpperCase()} ${path}`;
}

async function executeRequest<T>(path: string, init?: ApiInit): Promise<T> {
  const { json: _json, cacheTtlMs: _ttl, ...fetchInit } = init ?? {};
  return requestJson<T>(`${API_BASE}${path}`, { ...fetchInit, json: init?.json });
}

export async function api<T = unknown>(path: string, init?: ApiInit): Promise<T> {
  const method = (init?.method ?? "GET").toUpperCase();
  const isGet =
    method === "GET" && init?.json === undefined && init?.body === undefined;

  if (!isGet) {
    // 写操作后整表失效，避免子页读到陈旧 agent/me 等
    invalidateApiCache();
    return executeRequest<T>(path, init);
  }

  const key = requestKey(method, path);
  const ttl =
    init?.cacheTtlMs === false || init?.cacheTtlMs === 0
      ? 0
      : (init?.cacheTtlMs ?? DEFAULT_GET_TTL_MS);

  if (ttl > 0) {
    const hit = responseCache.get(key);
    if (hit && hit.expires > Date.now()) return hit.data as T;
  }

  const pending = inflight.get(key);
  if (pending) return pending as Promise<T>;

  const promise = executeRequest<T>(path, init).then((data) => {
    if (ttl > 0) {
      responseCache.set(key, { expires: Date.now() + ttl, data });
    }
    return data;
  });

  inflight.set(key, promise);
  try {
    return await promise;
  } finally {
    inflight.delete(key);
  }
}
