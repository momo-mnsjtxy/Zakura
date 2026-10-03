/**
 * Coordinates connector/channel requests that may outlive the screen which
 * started them.  The controller is deliberately framework agnostic so sheets,
 * catalog pages and remote-channel editors share the same race semantics.
 */
export function createChannelConnectionController() {
  const scopes = new Map();
  const active = new Map();

  return {
    beginLoad(scope = "default") {
      const token = (scopes.get(scope) ?? 0) + 1;
      scopes.set(scope, token);
      return {
        token,
        current: () => token === scopes.get(scope),
      };
    },
    invalidate(scope) {
      if (scope) scopes.set(scope, (scopes.get(scope) ?? 0) + 1);
      else {
        for (const [key, value] of scopes) scopes.set(key, value + 1);
      }
    },
    isCurrent(token, scope = "default") {
      return token === scopes.get(scope);
    },
    runOnce(key, operation) {
      if (active.has(key)) return active.get(key);
      const promise = Promise.resolve().then(operation);
      active.set(key, promise);
      promise.finally(() => {
        if (active.get(key) === promise) active.delete(key);
      }).catch(() => {});
      return promise;
    },
    pending(key) {
      return active.has(key);
    },
  };
}

export function reconcileChannelBinding(bindings, binding) {
  const next = (bindings ?? []).filter((item) => item.id !== binding.id);
  return [...next, binding];
}

export function removeChannelBinding(bindings, id) {
  return (bindings ?? []).filter((item) => item.id !== id);
}

export function connectorOauthResult(search) {
  const params = new URLSearchParams(search ?? "");
  const state = params.get("oauth");
  if (!state) return null;
  if (state === "1" || state === "success") return { ok: true, message: "授权已完成" };
  return {
    ok: false,
    message: params.get("error_description") || params.get("error") || "授权未完成，请重试",
  };
}
