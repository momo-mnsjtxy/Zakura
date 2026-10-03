/**
 * Shared HTTP transport for first-party connectors.
 *
 * Provider modules describe endpoints and payloads; this module owns the parts that
 * must behave consistently across every connector: bounded retries, cancellation,
 * timeout handling, JSON decoding, error metadata and concurrent GET de-duplication.
 */
import { createHash } from "node:crypto";

export type ConnectorAuthScheme = "bearer" | "token" | "private-token";

export type ConnectorRetryOptions = {
  /** Total attempts, including the first request. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
};

export type ConnectorRequestInit = Omit<RequestInit, "body"> & {
  json?: unknown;
  body?: RequestInit["body"];
  authScheme?: ConnectorAuthScheme;
  timeoutMs?: number;
  retry?: ConnectorRetryOptions | false;
  /** Concurrent identical safe requests share one upstream request. */
  dedupe?: boolean;
};

export class ConnectorHttpError extends Error {
  readonly status: number;
  readonly responseBody: string;
  readonly requestId: string | null;
  readonly retryAfterMs: number | null;

  constructor(input: {
    status: number;
    responseBody: string;
    requestId?: string | null;
    retryAfterMs?: number | null;
  }) {
    const detail = input.responseBody.trim().slice(0, 400);
    super(`${input.status}${detail ? `: ${detail}` : ""}`);
    this.name = "ConnectorHttpError";
    this.status = input.status;
    this.responseBody = input.responseBody;
    this.requestId = input.requestId ?? null;
    this.retryAfterMs = input.retryAfterMs ?? null;
  }
}

const inflight = new Map<string, Promise<unknown>>();

function authHeaders(
  token: string,
  scheme: ConnectorAuthScheme,
  source?: RequestInit["headers"],
): Headers {
  const headers = new Headers(source);
  if (scheme === "private-token") headers.set("PRIVATE-TOKEN", token);
  else if (scheme === "token") headers.set("Authorization", `Token ${token}`);
  else headers.set("Authorization", `Bearer ${token}`);
  return headers;
}

function tokenFingerprint(token: string): string {
  return createHash("sha256").update(token).digest("base64url").slice(0, 16);
}

function retryAfterMs(headers: Headers, now = Date.now()): number | null {
  const raw = headers.get("retry-after")?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1_000));
  const at = Date.parse(raw);
  return Number.isFinite(at) ? Math.max(0, at - now) : null;
}

function retryableMethod(method: string, headers: Headers): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS" ||
    headers.has("Idempotency-Key");
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const done = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const timer = setTimeout(done, ms);
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function combineWithTimeout(external: AbortSignal | null | undefined, timeoutMs: number) {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException("Connector request timed out", "TimeoutError"));
  }, timeoutMs);
  timer.unref?.();
  const onAbort = () => controller.abort(external?.reason);
  if (external?.aborted) onAbort();
  else external?.addEventListener("abort", onAbort, { once: true });
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    dispose() {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

async function executeJson<T>(
  url: string,
  token: string,
  init: ConnectorRequestInit,
): Promise<T> {
  const method = (init.method ?? (init.json === undefined ? "GET" : "POST")).toUpperCase();
  const headers = authHeaders(token, init.authScheme ?? "bearer", init.headers);
  if (init.json !== undefined) headers.set("Content-Type", "application/json");
  const canRetry = retryableMethod(method, headers);
  const retry = init.retry === false ? {} : (init.retry ?? {});
  const attempts = canRetry ? Math.min(5, Math.max(1, retry.attempts ?? 3)) : 1;
  const baseDelayMs = Math.max(0, retry.baseDelayMs ?? 150);
  const maxDelayMs = Math.max(baseDelayMs, retry.maxDelayMs ?? 2_000);
  const {
    json: _json,
    authScheme: _authScheme,
    timeoutMs: _timeoutMs,
    retry: _retry,
    dedupe: _dedupe,
    ...fetchInit
  } = init;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (init.signal?.aborted) throw init.signal.reason ?? new DOMException("Aborted", "AbortError");
    const timeout = combineWithTimeout(init.signal, Math.max(1, init.timeoutMs ?? 60_000));
    try {
      const response = await fetch(url, {
        ...fetchInit,
        method,
        headers,
        body: init.json !== undefined ? JSON.stringify(init.json) : init.body,
        signal: timeout.signal,
      });
      const text = await response.text();
      if (response.ok) {
        if (!text) return {} as T;
        try {
          return JSON.parse(text) as T;
        } catch {
          throw new Error(`Connector returned invalid JSON (${response.status})`);
        }
      }
      const error = new ConnectorHttpError({
        status: response.status,
        responseBody: text,
        requestId:
          response.headers.get("x-request-id") ?? response.headers.get("x-github-request-id"),
        retryAfterMs: retryAfterMs(response.headers),
      });
      if (attempt >= attempts || !retryableStatus(response.status)) throw error;
      const backoff = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      await delay(error.retryAfterMs ?? backoff, init.signal ?? undefined);
    } catch (error) {
      if (error instanceof ConnectorHttpError) throw error;
      if (init.signal?.aborted) throw init.signal.reason ?? error;
      if (timeout.timedOut() && attempt >= attempts) {
        throw new Error(`Connector request timed out after ${init.timeoutMs ?? 60_000}ms`);
      }
      if (attempt >= attempts) throw error;
      await delay(Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1)), init.signal ?? undefined);
    } finally {
      timeout.dispose();
    }
  }
  throw new Error("Connector request exhausted without a result");
}

export function connectorJson<T>(
  url: string,
  token: string,
  init: ConnectorRequestInit = {},
): Promise<T> {
  const method = (init.method ?? (init.json === undefined ? "GET" : "POST")).toUpperCase();
  const shouldDedupe = (init.dedupe ?? true) && (method === "GET" || method === "HEAD");
  if (!shouldDedupe) return executeJson<T>(url, token, init);

  // Authentication participates in the key, but only as a one-way fingerprint. Two
  // tenants can never observe each other's response through request coalescing.
  const key = `${method}:${url}:${tokenFingerprint(token)}:${init.authScheme ?? "bearer"}`;
  const existing = inflight.get(key) as Promise<T> | undefined;
  if (existing) return existing;
  const request = executeJson<T>(url, token, init).finally(() => {
    if (inflight.get(key) === request) inflight.delete(key);
  });
  inflight.set(key, request);
  return request;
}
