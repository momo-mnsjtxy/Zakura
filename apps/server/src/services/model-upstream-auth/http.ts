export type JsonHttp = {
  postJson: (
    url: string,
    body: unknown,
    headers?: Record<string, string>,
    options?: JsonHttpOptions,
  ) => Promise<{ status: number; json: unknown }>;
  getJson: (
    url: string,
    headers?: Record<string, string>,
    options?: JsonHttpOptions,
  ) => Promise<{ status: number; json: unknown }>;
  postForm: (
    url: string,
    body: Record<string, string>,
    headers?: Record<string, string>,
    options?: JsonHttpOptions,
  ) => Promise<{ status: number; json: unknown }>;
};

export type JsonHttpOptions = {
  signal?: AbortSignal;
  timeoutMs?: number;
};

function requestSignal(options?: JsonHttpOptions): AbortSignal {
  const timeout = AbortSignal.timeout(Math.max(1, options?.timeoutMs ?? 20_000));
  return options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
}

export function defaultJsonHttp(): JsonHttp {
  return {
    async postJson(url, body, headers, options) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
        signal: requestSignal(options),
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    },
    async getJson(url, headers, options) {
      const res = await fetch(url, {
        method: "GET",
        headers: { Accept: "application/json", ...headers },
        signal: requestSignal(options),
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    },
    async postForm(url, body, headers, options) {
      const res = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          ...headers,
        },
        body: new URLSearchParams(body).toString(),
        signal: requestSignal(options),
      });
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    },
  };
}

export function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

export function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}
