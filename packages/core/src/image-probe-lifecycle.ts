export type ImageProbeClock = {
  setTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout>;
  clearTimeout(timer: ReturnType<typeof setTimeout>): void;
};

const systemClock: ImageProbeClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

const abortError = (message: string): Error => Object.assign(new Error(message), { name: "AbortError" });
const timeoutError = (timeoutMs: number): Error => Object.assign(new Error(`image probe timed out after ${timeoutMs}ms`), { name: "TimeoutError" });

/** Bounded lifecycle for registry operations, including fetch implementations
 * that ignore AbortSignal. Late outcomes are observed but never re-enter state. */
export class ImageProbeLifecycle {
  private readonly pending = new Map<AbortController, () => void>();
  private closed = false;

  constructor(private readonly clock: ImageProbeClock = systemClock) {}

  run<T>(operation: (signal: AbortSignal) => Promise<T>, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    if (this.closed) return Promise.reject(abortError("image probe lifecycle is closed"));
    if (signal?.aborted) return Promise.reject(abortError("image probe was aborted"));
    const controller = new AbortController();
    return new Promise<T>((resolve, reject) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        if (timer) this.clock.clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        this.pending.delete(controller);
        callback();
      };
      const onAbort = () => {
        controller.abort();
        finish(() => reject(abortError("image probe was aborted")));
      };
      this.pending.set(controller, onAbort);
      signal?.addEventListener("abort", onAbort, { once: true });
      if (signal?.aborted) { onAbort(); return; }
      if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
        timer = this.clock.setTimeout(() => {
          controller.abort();
          finish(() => reject(timeoutError(timeoutMs)));
        }, timeoutMs);
        timer.unref?.();
      }
      let result: Promise<T>;
      try { result = operation(controller.signal); }
      catch (error) { finish(() => reject(error)); return; }
      result.then((value) => finish(() => resolve(value)), (error) => finish(() => reject(error)));
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const cancel of [...this.pending.values()]) cancel();
  }

  get activeCount(): number { return this.pending.size; }
}
