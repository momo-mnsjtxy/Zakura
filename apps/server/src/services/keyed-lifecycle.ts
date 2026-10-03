/** Coalesces concurrent idempotent lifecycle operations per resource key. */
export class KeyedLifecycle {
  private readonly active = new Map<string, Promise<unknown>>();
  run<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const current = this.active.get(key) as Promise<T> | undefined;
    if (current) return current;
    const next = Promise.resolve().then(operation).finally(() => {
      if (this.active.get(key) === next) this.active.delete(key);
    });
    this.active.set(key, next);
    return next;
  }
}
