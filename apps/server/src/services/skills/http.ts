/** Network boundary for skill source discovery and package hydration. */
import { createHash } from "node:crypto";
import { SkillSourceError } from "./source.js";

export type SkillFetchOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
  attempts?: number;
  baseDelayMs?: number;
  dedupe?: boolean;
};

const inflight = new Map<string, Promise<Response>>();

function fingerprint(headers: Headers): string {
  const auth = [
    headers.get("authorization") ?? "",
    headers.get("private-token") ?? "",
  ].join("\u0000");
  return auth
    ? createHash("sha256").update(auth).digest("base64url").slice(0, 16)
    : "anonymous";
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
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
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function retryable(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function retryAfter(response: Response): number | null {
  const raw = response.headers.get("retry-after")?.trim();
  if (!raw) return null;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, Math.round(seconds * 1_000));
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}

async function fetchAttempt(
  url: string,
  init: RequestInit,
  options: SkillFetchOptions,
): Promise<Response> {
  const attempts = Math.min(4, Math.max(1, options.attempts ?? 3));
  const timeoutMs = Math.max(1, options.timeoutMs ?? 20_000);
  const baseDelayMs = Math.max(0, options.baseDelayMs ?? 150);
  for (let attempt = 1; attempt <= attempts; attempt++) {
    if (options.signal?.aborted) {
      throw new SkillSourceError(`请求已取消：${url}`, "http");
    }
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    timer.unref?.();
    const onAbort = () => controller.abort(options.signal?.reason);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (response.ok || !retryable(response.status) || attempt === attempts) return response;
      // Drain before retrying so undici can reuse the local/upstream connection.
      await response.arrayBuffer().catch(() => undefined);
      await wait(retryAfter(response) ?? baseDelayMs * 2 ** (attempt - 1), options.signal);
    } catch (error) {
      if (options.signal?.aborted) {
        throw new SkillSourceError(`请求已取消：${url}`, "http");
      }
      if (attempt === attempts) {
        if (timedOut) throw new SkillSourceError(`请求超时：${url}`, "http");
        throw new SkillSourceError(
          `网络错误：${error instanceof Error ? error.message : String(error)}`,
          "http",
        );
      }
      await wait(baseDelayMs * 2 ** (attempt - 1), options.signal);
    } finally {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }
  throw new SkillSourceError(`请求失败：${url}`, "http");
}

export async function fetchSkillSource(
  url: string,
  init: RequestInit = {},
  options: SkillFetchOptions = {},
): Promise<Response> {
  const method = (init.method ?? "GET").toUpperCase();
  const headers = new Headers(init.headers);
  const canDedupe = (options.dedupe ?? true) && !options.signal &&
    (method === "GET" || method === "HEAD");
  if (!canDedupe) return fetchAttempt(url, { ...init, headers }, options);

  const key = `${method}:${url}:${fingerprint(headers)}`;
  let request = inflight.get(key);
  if (!request) {
    request = fetchAttempt(url, { ...init, headers }, options).finally(() => {
      if (inflight.get(key) === request) inflight.delete(key);
    });
    inflight.set(key, request);
  }
  // The canonical response is never consumed; each caller receives its own body.
  return (await request).clone();
}
