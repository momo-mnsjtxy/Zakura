import type { CreateContainerOptions, ContainerRuntime, RunningContainer } from "./runtime.js";
import type { StdioExec } from "./stdio-exec.js";

export type RecoveringRuntimeOptions = {
  operationTimeoutMs?: number;
  cleanupTimeoutMs?: number;
};

/** Lifecycle decorator for local ContainerRuntime adapters. It preserves the
 * runtime contract while coalescing destructive operations and cleaning up a
 * container allocated after its create caller has timed out. */
export class RecoveringContainerRuntime implements ContainerRuntime {
  readonly kind: string;
  private readonly operationTimeoutMs: number;
  private readonly cleanupTimeoutMs: number;
  private readonly stopping = new Map<string, Promise<void>>();
  private readonly removing = new Map<string, Promise<void>>();

  constructor(private readonly inner: ContainerRuntime, options: RecoveringRuntimeOptions = {}) {
    this.kind = inner.kind;
    this.operationTimeoutMs = options.operationTimeoutMs ?? 30_000;
    this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 10_000;
  }

  ping() { return this.inner.ping(); }
  ensureNetwork(name: string) { return deadline(this.inner.ensureNetwork(name), this.operationTimeoutMs, "ensure network"); }
  ensureImage(image: string) { return deadline(this.inner.ensureImage(image), this.operationTimeoutMs, "ensure image"); }

  async createAndStart(opts: CreateContainerOptions): Promise<RunningContainer> {
    const allocation = this.inner.createAndStart(opts);
    try {
      return await deadline(allocation, this.operationTimeoutMs, "create container");
    } catch (error) {
      // If timeout/cancellation won while the runtime was allocating, observe a
      // late success and remove it. This prevents orphaned local containers.
      if (isTimeout(error)) {
        void allocation.then((container) => this.cleanupLate(container.id)).catch(() => undefined);
      }
      throw error;
    }
  }

  stop(containerId: string): Promise<void> {
    const existing = this.stopping.get(containerId);
    if (existing) return existing;
    const operation = deadline(this.inner.stop(containerId), this.operationTimeoutMs, "stop container")
      .finally(() => this.stopping.delete(containerId));
    this.stopping.set(containerId, operation);
    return operation;
  }

  remove(containerId: string, force?: boolean): Promise<void> {
    const existing = this.removing.get(containerId);
    if (existing) return existing;
    const operation = deadline(this.inner.remove(containerId, force), this.operationTimeoutMs, "remove container")
      .finally(() => this.removing.delete(containerId));
    this.removing.set(containerId, operation);
    return operation;
  }

  inspect(containerId: string) { return this.inner.inspect(containerId); }
  list(filters?: { tenantId?: string; instanceId?: string; purpose?: string }) { return this.inner.list(filters); }
  exec(containerId: string, command: string[], opts?: { workingDir?: string; env?: Record<string, string>; timeoutMs?: number }) {
    return deadline(this.inner.exec(containerId, command, opts), opts?.timeoutMs ?? this.operationTimeoutMs, "container exec");
  }
  execStdio(containerId: string, command: string[], opts?: { workingDir?: string; env?: Record<string, string> }): Promise<StdioExec> {
    if (!this.inner.execStdio) return Promise.reject(new Error(`Runtime ${this.kind} does not support execStdio`));
    return deadline(this.inner.execStdio(containerId, command, opts), this.operationTimeoutMs, "container stdio");
  }
  attachStdio(containerId: string): Promise<StdioExec> {
    if (!this.inner.attachStdio) return Promise.reject(new Error(`Runtime ${this.kind} does not support attachStdio`));
    return deadline(this.inner.attachStdio(containerId), this.operationTimeoutMs, "container attach");
  }
  logs(containerId: string, tail?: number) { return this.inner.logs(containerId, tail); }
  buildSpecName(tenantSlug: string, instanceSlug: string, containerName: string) {
    return this.inner.buildSpecName(tenantSlug, instanceSlug, containerName);
  }

  private async cleanupLate(containerId: string): Promise<void> {
    await deadline(this.inner.remove(containerId, true), this.cleanupTimeoutMs, "late container cleanup").catch(() => undefined);
  }
}

export async function deadline<T>(promise: Promise<T>, timeoutMs: number, operation: string): Promise<T> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          const error = new Error(`${operation} timed out after ${timeoutMs}ms`);
          error.name = "TimeoutError";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function isTimeout(error: unknown): boolean {
  return error instanceof Error && error.name === "TimeoutError";
}

