/** Explicit caller cancellation. This is never a retryable upstream failure. */
export class ModelCallAbortedError extends Error {
  readonly aborted = true;
  constructor(message = "调用已被取消") {
    super(message);
    this.name = "ModelCallAbortedError";
  }
}

export function isAbortError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; current && depth < 6; depth += 1) {
    if (current instanceof ModelCallAbortedError) return true;
    if ((current as { aborted?: unknown }).aborted === true) return true;
    current = current instanceof Error ? current.cause : null;
  }
  return false;
}

export type RetryLifecycleOptions = {
  attempts?: number;
  baseDelayMs?: number;
  signal?: AbortSignal;
  shouldRetry(error: unknown, attempt: number): boolean;
  onRetry?: (error: unknown, attempt: number) => void;
};

function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ModelCallAbortedError();
}

async function retryDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfCancelled(signal);
  if (!signal) return new Promise((resolve) => setTimeout(resolve, ms));
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(done, ms);
    function done() { signal!.removeEventListener("abort", aborted); resolve(); }
    function aborted() { clearTimeout(timer); signal!.removeEventListener("abort", aborted); reject(new ModelCallAbortedError()); }
    signal.addEventListener("abort", aborted, { once: true });
  });
}

/** Provider-independent attempt/backoff/cancellation state machine. */
export async function executeRetryLifecycle<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryLifecycleOptions,
): Promise<T> {
  const attempts = Math.max(1, options.attempts ?? 2);
  const delay = Math.max(0, options.baseDelayMs ?? 300);
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfCancelled(options.signal);
    try {
      return await operation(attempt);
    } catch (error) {
      lastError = error;
      if (isAbortError(error) || attempt >= attempts || !options.shouldRetry(error, attempt)) throw error;
      options.onRetry?.(error, attempt);
      await retryDelay(delay * attempt, options.signal);
    }
  }
  throw lastError;
}

