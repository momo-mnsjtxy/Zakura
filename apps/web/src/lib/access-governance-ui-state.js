export function createAccessGovernanceController() {
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

export function reconcileAccessRow(rows, row) {
  return [...(rows ?? []).filter((item) => item.id !== row.id), row];
}

export function removeAccessRow(rows, id) {
  return (rows ?? []).filter((item) => item.id !== id);
}

export function closeSecretReveal() {
  return { secret: null, subjectId: null, copied: false };
}

export function accessDeepLink(search) {
  const params = new URLSearchParams(search ?? "");
  return { selectedId: params.get("client") || params.get("key") || null };
}
