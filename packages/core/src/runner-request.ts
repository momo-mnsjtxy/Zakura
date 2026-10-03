export type UnaryRunnerHub = {
  rpc<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
};

export type RunnerRequestOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
};

type PendingRequest = {
  reject: (reason: unknown) => void;
  cleanup: () => void;
};

const abortError = (message: string): Error => {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
};

const timeoutError = (method: string, timeoutMs: number): Error => {
  const error = new Error(`Runner RPC ${method} timed out after ${timeoutMs}ms`);
  error.name = "TimeoutError";
  return error;
};

/**
 * Owns non-stream Runner RPC request lifetime. The Hub wire API has no cancel
 * frame, so cancellation rejects locally and quarantines a late reply rather
 * than allowing it to re-enter client state.
 */
export class RunnerRequestLifecycle {
  private readonly pending = new Set<PendingRequest>();
  private closed = false;

  constructor(private readonly hub: UnaryRunnerHub) {}

  request<T>(method: string, params?: unknown, options: RunnerRequestOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(abortError("Runner client is closed"));
    if (options.signal?.aborted) return Promise.reject(abortError(`Runner RPC ${method} was aborted`));

    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const signal = options.signal;
      const settle = (fn: () => void) => {
        if (settled) return;
        settled = true;
        request.cleanup();
        this.pending.delete(request);
        fn();
      };
      const onAbort = () => settle(() => reject(abortError(`Runner RPC ${method} was aborted`)));
      const request: PendingRequest = {
        reject: (reason) => settle(() => reject(reason)),
        cleanup: () => {
          if (timer) clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
        },
      };
      this.pending.add(request);
      signal?.addEventListener("abort", onAbort, { once: true });
      // The signal can flip between the preflight check and listener install.
      if (signal?.aborted) {
        onAbort();
        return;
      }
      const timeoutMs = options.timeoutMs;
      if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = setTimeout(() => settle(() => reject(timeoutError(method, timeoutMs))), timeoutMs);
        timer.unref?.();
      }

      let operation: Promise<T>;
      try {
        operation = this.hub.rpc<T>(method, params, timeoutMs);
      } catch (error) {
        settle(() => reject(error));
        return;
      }
      operation.then(
        (value) => settle(() => resolve(value)),
        (error) => settle(() => reject(error)),
      );
    });
  }

  close(reason: Error = abortError("Runner client is closed")): void {
    if (this.closed) return;
    this.closed = true;
    for (const request of [...this.pending]) request.reject(reason);
  }

  get pendingCount(): number {
    return this.pending.size;
  }
}
