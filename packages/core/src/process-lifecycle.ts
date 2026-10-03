export type ProcessCloseReason = "stop" | "kill" | "timeout" | "cancel";

/** Coordinates a local process close path so competing timeout, cancellation,
 * explicit kill, and natural exit cannot execute cleanup more than once. */
export class ProcessLifecycle {
  private state: "running" | "closing" | "closed" = "running";
  private closing?: Promise<void>;
  private timer?: ReturnType<typeof setTimeout>;
  private abortCleanup?: () => void;

  constructor(private readonly closeProcess: (reason: ProcessCloseReason) => Promise<void>) {}

  get running(): boolean { return this.state === "running"; }

  close(reason: ProcessCloseReason): Promise<void> {
    if (this.closing) return this.closing;
    if (this.state === "closed") return Promise.resolve();
    this.state = "closing";
    this.clearTriggers();
    this.closing = Promise.resolve()
      .then(() => this.closeProcess(reason))
      .finally(() => { this.state = "closed"; });
    return this.closing;
  }

  /** Record natural process completion without invoking the close adapter. */
  finish(): void {
    if (this.state !== "running") return;
    this.state = "closed";
    this.clearTriggers();
  }

  armTimeout(timeoutMs: number): () => void {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || this.state !== "running") return () => {};
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { void this.close("timeout"); }, timeoutMs);
    return () => { if (this.timer) clearTimeout(this.timer); this.timer = undefined; };
  }

  bindAbort(signal?: AbortSignal): () => void {
    this.abortCleanup?.();
    if (!signal || this.state !== "running") return () => {};
    const onAbort = () => { void this.close("cancel"); };
    signal.addEventListener("abort", onAbort, { once: true });
    this.abortCleanup = () => signal.removeEventListener("abort", onAbort);
    if (signal.aborted) onAbort();
    return this.abortCleanup;
  }

  private clearTriggers(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.abortCleanup?.();
    this.abortCleanup = undefined;
  }
}
