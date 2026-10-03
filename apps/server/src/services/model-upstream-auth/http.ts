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

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("This operation was aborted", "AbortError");
}

async function boundedFetch(
  url: string,
  init: RequestInit,
  options?: JsonHttpOptions,
): Promise<Response> {
  const callerSignal = options?.signal;
  if (callerSignal?.aborted) throw abortReason(callerSignal);

  const controller = new AbortController();
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let onCallerAbort: (() => void) | undefined;
  const abort = new Promise<never>((_resolve, reject) => {
    const stop = (reason: unknown) => {
      if (!controller.signal.aborted) controller.abort(reason);
      reject(reason);
    };
    timeout = setTimeout(
      () =>
        stop(
          new DOMException(
            "The operation was aborted due to timeout",
            "TimeoutError",
          ),
        ),
      Math.max(1, options?.timeoutMs ?? 20_000),
    );
    if (callerSignal) {
      onCallerAbort = () => stop(abortReason(callerSignal));
      callerSignal.addEventListener("abort", onCallerAbort, { once: true });
    }
  });

  try {
    return await Promise.race([
      fetch(url, { ...init, signal: controller.signal }),
      abort,
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
    if (callerSignal && onCallerAbort) {
      callerSignal.removeEventListener("abort", onCallerAbort);
    }
  }
}

export function defaultJsonHttp(): JsonHttp {
  return {
    async postJson(url, body, headers, options) {
      const res = await boundedFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
          ...headers,
        },
        body: JSON.stringify(body),
      }, options);
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    },
    async getJson(url, headers, options) {
      const res = await boundedFetch(url, {
        method: "GET",
        headers: { Accept: "application/json", ...headers },
      }, options);
      const json = await res.json().catch(() => null);
      return { status: res.status, json };
    },
    async postForm(url, body, headers, options) {
      const res = await boundedFetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
          ...headers,
        },
        body: new URLSearchParams(body).toString(),
      }, options);
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
