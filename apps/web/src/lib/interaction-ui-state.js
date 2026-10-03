export function interactionKey(item) {
  return `${item.requestId}:${item.resolved?.status ?? item.resolved?.decision ?? "pending"}`;
}

export function nextAskDraft(current, previousRequestId, requestId, defaults = []) {
  if (previousRequestId === requestId) return current;
  return { selected: [...defaults], text: "", requestId };
}

export function isInteractionExpired(expiresAt, now = Date.now()) {
  if (!expiresAt) return false;
  const timestamp = new Date(expiresAt).getTime();
  return Number.isFinite(timestamp) && timestamp <= now;
}

export function createResolutionController() {
  const pending = new Set();
  return {
    begin(requestId) {
      if (pending.has(requestId)) return false;
      pending.add(requestId);
      return true;
    },
    finish(requestId) {
      pending.delete(requestId);
    },
    replayResolved(requestId) {
      pending.delete(requestId);
    },
    reconnect() {
      pending.clear();
    },
    isPending(requestId) {
      return pending.has(requestId);
    },
  };
}

export function resolveWithRetry(controller, requestId, action) {
  if (!controller.begin(requestId)) return Promise.resolve(false);
  return Promise.resolve()
    .then(action)
    .then(() => true)
    .catch((error) => {
      controller.finish(requestId);
      throw error;
    });
}

/** @param {{requestId: string, selected?: string[], text?: string, cancelled?: boolean}} input */
export function normalizeAskAnswer({ requestId, selected = [], text = "", cancelled = false }) {
  return {
    requestId,
    ...(cancelled ? { cancelled: true } : {}),
    ...(!cancelled && selected?.length ? { selected: [...new Set(selected)] } : {}),
    ...(!cancelled && text?.trim() ? { text: text.trim() } : {}),
  };
}
