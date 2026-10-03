export class RunCancellationRegistry {
  private readonly cancelled = new Set<string>();
  private readonly listeners = new Map<string, Set<() => void>>();
  constructor(private readonly onError: (error: unknown) => void = () => {}) {}
  isCancelled(runId: string): boolean { return this.cancelled.has(runId); }
  subscribe(runId: string, listener: () => void): () => void {
    if (this.cancelled.has(runId)) { this.invoke(listener); return () => {}; }
    let set = this.listeners.get(runId);
    if (!set) this.listeners.set(runId, (set = new Set()));
    set.add(listener);
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.listeners.get(runId);
      current?.delete(listener);
      if (current?.size === 0) this.listeners.delete(runId);
    };
  }
  cancel(runId: string): void {
    if (this.cancelled.has(runId)) return;
    this.cancelled.add(runId);
    const pending = this.listeners.get(runId);
    this.listeners.delete(runId);
    for (const listener of pending ?? []) this.invoke(listener);
  }
  clear(runId: string): void { this.cancelled.delete(runId); this.listeners.delete(runId); }
  private invoke(listener: () => void): void {
    try { listener(); } catch (error) { this.onError(error); }
  }
}
