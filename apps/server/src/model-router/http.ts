import type { ModelUpstreamConfig, ModelUpstreamProtocol } from "@zakura/shared";
import { Agent, setGlobalDispatcher } from "undici";
import {
  executeRetryLifecycle,
  isAbortError,
  ModelCallAbortedError,
} from "./lifecycle.js";

export { isAbortError, ModelCallAbortedError } from "./lifecycle.js";

// Every adapter shares one conservative pool. Provider calls are serialized at
// a higher layer when required; disabling pipelining isolates stream cancellation.
setGlobalDispatcher(
  new Agent({
    connections: 32,
    keepAliveTimeout: 60_000,
    keepAliveMaxTimeout: 120_000,
    pipelining: 1,
  }),
);

export function buildHeaders(
  config: ModelUpstreamConfig,
  protocol: ModelUpstreamProtocol,
): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json",
    ...(config.extraHeaders ?? {}),
  };
  if (config.apiKey) {
    if (protocol === "azure-openai") headers["api-key"] = config.apiKey;
    else if (protocol !== "gemini" && protocol !== "gemini-cli") {
      headers.Authorization = `Bearer ${config.apiKey}`;
    }
  }
  if (protocol === "codex") {
    headers.originator ||= "codex_cli_rs";
    headers["OpenAI-Beta"] ||= "responses=experimental";
  }
  return headers;
}

/** A provider response whose HTTP status is available to routing policy. */
export class UpstreamHttpError extends Error {
  readonly code?: string;
  readonly providerType?: string;

  constructor(
    message: string,
    readonly status: number,
    details?: { code?: string; type?: string },
  ) {
    super(message);
    this.name = "UpstreamHttpError";
    this.code = details?.code;
    this.providerType = details?.type;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Preserve structured provider failures carried inside a successful SSE response. */
export function providerStreamError(prefix: string, payload: unknown): UpstreamHttpError {
  const envelope = record(payload) ?? {};
  const nested = record(envelope.error) ?? envelope;
  const stringField = (key: string): string | undefined => {
    const value = nested[key] ?? envelope[key];
    return typeof value === "string" && value ? value : undefined;
  };
  const numericStatus = [
    nested.status,
    nested.status_code,
    envelope.status,
    envelope.status_code,
  ]
    .map((value) =>
      typeof value === "number"
        ? value
        : typeof value === "string" && /^\d{3}$/.test(value)
          ? Number(value)
          : null,
    )
    .find((value): value is number => value != null);
  const code = stringField("code");
  const type = stringField("type");
  const message =
    stringField("message") ??
    (typeof envelope.error === "string" ? envelope.error : undefined) ??
    "upstream stream error";
  const classification = `${code ?? ""} ${type ?? ""} ${message}`.toLowerCase();
  const inferredStatus =
    /rate[_ -]?limit|too[_ -]?many|quota/.test(classification)
      ? 429
      : /server[_ -]?error|overload|temporar|unavailable|internal[_ -]?error/.test(
            classification,
          )
        ? 503
        : 400;
  const status = numericStatus ?? inferredStatus;
  return new UpstreamHttpError(`${prefix} HTTP ${status}: ${message}`, status, {
    ...(code ? { code } : {}),
    ...(type ? { type } : {}),
  });
}

function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  let current = error;
  for (let depth = 0; current != null && depth < 8; depth += 1) {
    chain.push(current);
    current = current instanceof Error ? current.cause : null;
  }
  return chain;
}

function errorChainText(error: unknown): string {
  return errorChain(error)
    .flatMap((item) => {
      if (!(item instanceof Error)) return [String(item)];
      const code = (item as Error & { code?: unknown }).code;
      return [item.name, item.message, ...(typeof code === "string" ? [code] : [])];
    })
    .join(" | ");
}

const TRANSIENT_NETWORK_ERROR =
  /terminated|fetch failed|other side closed|socket hang up|socket idle|premature close|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|UND_ERR|TimeoutError|连接超时|空闲超时|aborted/i;

/** Return true only when replaying the request is safe at the transport layer. */
export function isRetryableModelError(error: unknown): boolean {
  if (isAbortError(error)) return false;
  // HTTP status is authoritative. An outer "aborted" message must not turn an
  // inner HTTP 400 into a retryable failure.
  for (const item of errorChain(error)) {
    if (item instanceof UpstreamHttpError) {
      return item.status === 408 || item.status === 429 || item.status >= 500;
    }
  }
  return TRANSIENT_NETWORK_ERROR.test(errorChainText(error));
}

export function withModelRetries<T>(
  operation: (attempt: number) => Promise<T>,
  options?: {
    attempts?: number;
    baseDelayMs?: number;
    shouldRetry?: (error: unknown, attempt: number) => boolean;
    onRetry?: (error: unknown, attempt: number) => void;
    signal?: AbortSignal;
  },
): Promise<T> {
  return executeRetryLifecycle(operation, {
    attempts: options?.attempts,
    baseDelayMs: options?.baseDelayMs,
    signal: options?.signal,
    shouldRetry: options?.shouldRetry ?? isRetryableModelError,
    onRetry: options?.onRetry,
  });
}

type Deadline = {
  signal: AbortSignal;
  reason(): Error | null;
  startIdle(message: string, ms: number): void;
  dispose(): void;
};

/** Link a caller signal with a deadline on all supported Node releases. */
function createDeadline(
  external: AbortSignal | null | undefined,
  timeoutMessage: string,
  timeoutMs: number,
): Deadline {
  const controller = new AbortController();
  let abortReason: Error | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const abort = (reason: Error) => {
    if (controller.signal.aborted) return;
    abortReason = reason;
    controller.abort(reason);
  };
  const onExternalAbort = () => abort(new ModelCallAbortedError());
  if (external?.aborted) onExternalAbort();
  else external?.addEventListener("abort", onExternalAbort, { once: true });
  const arm = (message: string, ms: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => abort(new Error(message)), Math.max(1, ms));
  };
  arm(timeoutMessage, timeoutMs);
  return {
    signal: controller.signal,
    reason: () => abortReason,
    startIdle: arm,
    dispose() {
      if (timer) clearTimeout(timer);
      external?.removeEventListener("abort", onExternalAbort);
    },
  };
}

export async function httpJson<T>(
  url: string,
  init: RequestInit & { timeoutMs?: number },
): Promise<{ ok: boolean; status: number; data: T | null; text: string }> {
  const timeoutMs = init.timeoutMs ?? 60_000;
  const { timeoutMs: _timeout, signal: external, ...request } = init;
  const deadline = createDeadline(
    external,
    `model request 连接超时（${timeoutMs}ms）`,
    timeoutMs,
  );
  try {
    const response = await fetch(url, { ...request, signal: deadline.signal });
    const text = await response.text();
    let data: T | null = null;
    if (text) {
      try {
        data = JSON.parse(text) as T;
      } catch {
        // Provider error pages remain available as text to the adapter.
      }
    }
    return { ok: response.ok, status: response.status, data, text };
  } catch (error) {
    throw deadline.reason() ?? error;
  } finally {
    deadline.dispose();
  }
}

/**
 * Incremental parser for provider SSE. Each complete data line is emitted
 * immediately, including gateways that omit the spec's blank separator.
 */
export class SseDataDecoder {
  private readonly decoder = new TextDecoder();
  private buffer = "";
  private stopped = false;

  constructor(private readonly onData: (payload: string) => void | boolean) {}

  push(bytes: Uint8Array): boolean {
    if (this.stopped) return false;
    this.buffer += this.decoder.decode(bytes, { stream: true });
    this.consumeLines(false);
    return !this.stopped;
  }

  finish(): boolean {
    if (this.stopped) return false;
    this.buffer += this.decoder.decode();
    this.consumeLines(true);
    return !this.stopped;
  }

  private consumeLines(final: boolean): void {
    while (!this.stopped) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).replace(/\r$/, "");
      this.buffer = this.buffer.slice(newline + 1);
      this.consumeLine(line);
    }
    if (final && !this.stopped && this.buffer) {
      const line = this.buffer.replace(/\r$/, "");
      this.buffer = "";
      this.consumeLine(line);
    }
  }

  private consumeLine(line: string): void {
    if (!line.startsWith("data:")) return;
    const payload = line.slice(5).trim();
    if (payload && this.onData(payload) === false) this.stopped = true;
  }
}

/** Fetch SSE with separate connection and stream-idle deadlines. */
export async function httpSse(
  prefix: string,
  url: string,
  init: RequestInit & { timeoutMs?: number; idleTimeoutMs?: number },
  onData: (payload: string) => void | boolean,
): Promise<void> {
  const timeoutMs = init.timeoutMs ?? 60_000;
  const idleTimeoutMs = init.idleTimeoutMs ?? Math.max(timeoutMs, 120_000);
  const {
    timeoutMs: _timeout,
    idleTimeoutMs: _idleTimeout,
    signal: external,
    ...request
  } = init;
  const deadline = createDeadline(
    external,
    `${prefix} 连接超时（${timeoutMs}ms）`,
    timeoutMs,
  );
  let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;
  try {
    const response = await fetch(url, { ...request, signal: deadline.signal });
    if (!response.ok || !response.body) {
      const text = await response.text().catch(() => "");
      let data: unknown = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch {
          // apiError uses the bounded text fallback.
        }
      }
      throw apiError(prefix, response.status, data, text);
    }
    const idleMessage = `${prefix} 流空闲超时（${idleTimeoutMs}ms 无数据）`;
    deadline.startIdle(idleMessage, idleTimeoutMs);
    reader = response.body.getReader();
    const parser = new SseDataDecoder(onData);
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      deadline.startIdle(idleMessage, idleTimeoutMs);
      if (!parser.push(value)) {
        await reader.cancel().catch(() => undefined);
        return;
      }
    }
    parser.finish();
  } catch (error) {
    const reason = deadline.reason();
    if (reason) throw reason;
    if (error instanceof UpstreamHttpError) throw error;
    if (error instanceof TypeError || error instanceof DOMException) {
      throw new Error(`${prefix} 连接中断: ${error.message}`, { cause: error });
    }
    throw error;
  } finally {
    deadline.dispose();
    reader?.releaseLock();
  }
}

export function apiError(
  prefix: string,
  status: number,
  data: unknown,
  text: string,
): UpstreamHttpError {
  let message = text.slice(0, 500);
  let code: string | undefined;
  let type: string | undefined;
  if (data && typeof data === "object" && "error" in data) {
    const providerError = (data as { error?: unknown }).error;
    if (typeof providerError === "string") message = providerError;
    else if (providerError && typeof providerError === "object") {
      const details = providerError as {
        message?: unknown;
        code?: unknown;
        type?: unknown;
      };
      const providerMessage = details.message;
      if (typeof providerMessage === "string") message = providerMessage;
      if (typeof details.code === "string") code = details.code;
      if (typeof details.type === "string") type = details.type;
    }
  }
  return new UpstreamHttpError(`${prefix} HTTP ${status}: ${message}`, status, {
    ...(code ? { code } : {}),
    ...(type ? { type } : {}),
  });
}

/** Ordered, bounded parallel mapping used by batch-only provider APIs. */
export async function mapConcurrent<T, R>(
  items: T[],
  concurrency: number,
  operation: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const workerCount = Math.min(items.length, Math.max(1, Math.floor(concurrency)));
  const output = new Array<R>(items.length);
  let nextIndex = 0;
  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      output[index] = await operation(items[index]!, index);
    }
  };
  await Promise.all(Array.from({ length: workerCount }, worker));
  return output;
}
