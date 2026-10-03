import { ApiError } from "./api-error";
import { getSession, setSession } from "./api-session";
import { decodeApiResponse } from "./http-response";

export type ApiRequestInit = RequestInit & { json?: unknown };

/** Stateless HTTP boundary. Caching and in-flight coordination live in api.ts. */
export async function requestJson<T>(path: string, init?: ApiRequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  const session = getSession();
  if (session) headers.set("Authorization", `Bearer ${session}`);

  let body = init?.body;
  if (init?.json !== undefined) {
    headers.set("Content-Type", "application/json");
    body = JSON.stringify(init.json);
  }
  const { json: _json, ...fetchInit } = init ?? {};
  const response = await fetch(path, { ...fetchInit, headers, body });
  const data = await decodeApiResponse(response);

  if (response.ok) return data as T;

  if (
    typeof window !== "undefined" &&
    response.status === 403 &&
    data.code === "account_suspended" &&
    !window.location.pathname.startsWith("/login")
  ) {
    setSession(null);
    const reason = typeof data.error === "string" ? data.error : "账号或所在团队已被封禁";
    window.location.replace(`/login?suspended=1&reason=${encodeURIComponent(reason)}`);
  }

  if (response.status >= 500 && typeof window !== "undefined") {
    void import("./otel").then(({ reportClientError }) => {
      reportClientError(
        "client.api",
        typeof data.error === "string" ? data.error : `HTTP ${response.status}`,
        { kind: "api", status_class: "5xx" },
      );
    });
  }

  throw new ApiError(
    typeof data.error === "string" ? data.error : `HTTP ${response.status}`,
    response.status,
    data,
  );
}
