const SESSION_KEY = "zakura_session";
export const SESSION_CHANGED_EVENT = "zakura_session_changed";

/** Browser session boundary shared by HTTP and realtime transports. */
export function getSession(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(SESSION_KEY);
}

export function setSession(token: string | null) {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(SESSION_KEY, token);
  else window.localStorage.removeItem(SESSION_KEY);
  window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
}
