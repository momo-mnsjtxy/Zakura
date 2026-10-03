export function toolCallRequestKey(filters) {
  return JSON.stringify({
    q: filters.q?.trim() ?? "",
    key: filters.apiKeyId ?? "all",
    agent: filters.agentId ?? "all",
    status: filters.status ?? "all",
    offset: filters.offset ?? 0,
  });
}

export function memoryMutationKey(action, id) {
  return `${action}:${id || "new"}`;
}

export function pollingTransition(state, event) {
  if (event === "start") return { ...state, polling: true, error: null };
  if (event === "success") return { polling: false, error: null };
  if (event instanceof Error) return { polling: false, error: event.message };
  return state;
}
