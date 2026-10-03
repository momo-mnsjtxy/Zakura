export function createNetworkUiController() {
  const generations = new Map();
  const mutations = new Map();
  return {
    begin(scope) {
      const token = (generations.get(scope) ?? 0) + 1;
      generations.set(scope, token);
      return { current: () => generations.get(scope) === token };
    },
    invalidate(scope) {
      if (scope) generations.set(scope, (generations.get(scope) ?? 0) + 1);
      else for (const [key, value] of generations) generations.set(key, value + 1);
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

export function reconcileById(rows, row) {
  return [...(rows ?? []).filter((item) => item.id !== row.id), row];
}

export function removeById(rows, id) {
  return (rows ?? []).filter((item) => item.id !== id);
}

export function preserveSecretDraft(previous, incoming, secretKeys) {
  const next = { ...(incoming ?? {}) };
  for (const key of secretKeys ?? []) if (previous?.[key]) next[key] = previous[key];
  return next;
}

export function nextNetworkPoll(state, outcome) {
  if (outcome === "success") return { failures: 0, delayMs: state?.failures ? 1000 : 5000, connected: true };
  const failures = Math.min((state?.failures ?? 0) + 1, 6);
  return { failures, delayMs: Math.min(1000 * 2 ** failures, 30000), connected: false };
}
