export function createRunnerPlatformController() {
  const loads = new Map();
  const mutations = new Map();
  return {
    begin(scope) {
      const token = (loads.get(scope) ?? 0) + 1;
      loads.set(scope, token);
      return { current: () => loads.get(scope) === token };
    },
    invalidate(scope) {
      if (scope) loads.set(scope, (loads.get(scope) ?? 0) + 1);
      else for (const [key, value] of loads) loads.set(key, value + 1);
    },
    runOnce(key, operation) {
      if (mutations.has(key)) return mutations.get(key);
      const promise = Promise.resolve().then(operation);
      mutations.set(key, promise);
      promise.finally(() => { if (mutations.get(key) === promise) mutations.delete(key); }).catch(() => {});
      return promise;
    },
  };
}

export function reconcileRunner(rows, authoritative) {
  return [...(rows ?? []).filter((item) => item.id !== authoritative.id), authoritative];
}

export function mergeServiceDraft(current, server, secretKeys = []) {
  const next = { ...(server ?? {}) };
  for (const key of secretKeys) if (current?.[key]) next[key] = current[key];
  return next;
}

export function runnerPollState(state, result) {
  if (result === "success") return { failures: 0, connected: true, delayMs: state?.failures ? 1000 : 3000 };
  const failures = Math.min((state?.failures ?? 0) + 1, 6);
  return { failures, connected: false, delayMs: Math.min(1000 * 2 ** failures, 30000) };
}

export function closeRunnerActionState() {
  return { selectedId: null, action: null, error: null };
}
