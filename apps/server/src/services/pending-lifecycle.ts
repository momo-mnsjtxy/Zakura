export type PendingWaitOptions = {
  expiresAt: Date | null;
  subscribeCancel: (listener: () => void) => () => void;
  onExpire: () => void;
  onCancel: () => void;
};

/** Shared one-shot request lifecycle for approvals and user questions. */
export class PendingLifecycle<T> {
  private readonly pending = new Map<string, (value: T) => void>();

  wait(id: string, options: PendingWaitOptions): Promise<T> {
    return new Promise<T>((resolve) => {
      let active = true;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const unsubscribe = options.subscribeCancel(() => {
        if (active) options.onCancel();
      });
      const finish = (value: T) => {
        if (!active) return;
        active = false;
        unsubscribe();
        if (timer) clearTimeout(timer);
        this.pending.delete(id);
        resolve(value);
      };
      this.pending.set(id, finish);
      if (options.expiresAt) {
        const delay = options.expiresAt.getTime() - Date.now();
        if (delay <= 0) options.onExpire();
        else timer = setTimeout(() => active && options.onExpire(), delay + 20);
      }
    });
  }

  settle(id: string, value: T): boolean {
    const finish = this.pending.get(id);
    if (!finish) return false;
    finish(value);
    return true;
  }
}

