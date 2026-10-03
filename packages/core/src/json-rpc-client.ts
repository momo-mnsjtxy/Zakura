export type JsonRpcId = string | number;
export type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};
export type JsonRpcTransport = {
  send(message: JsonRpcMessage, signal?: AbortSignal): Promise<void>;
  onMessage(listener: (message: JsonRpcMessage) => void): () => void;
  close(): Promise<void>;
};
export type JsonRpcRequestOptions = { timeoutMs?: number; signal?: AbortSignal };

export class JsonRpcClient {
  private nextId = 1;
  private readonly pending = new Map<JsonRpcId, { resolve(value: unknown): void; reject(error: unknown): void; cleanup(): void }>();
  private readonly unsubscribe: () => void;
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(private readonly transport: JsonRpcTransport, private readonly defaultTimeoutMs = 30_000) {
    this.unsubscribe = transport.onMessage((message) => this.receive(message));
  }

  request<T>(method: string, params?: unknown, options: JsonRpcRequestOptions = {}): Promise<T> {
    if (this.closed) return Promise.reject(new Error("JSON-RPC client is closed"));
    const id = this.nextId++;
    const timeoutMs = options.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const onAbort = () => settle(false, abortError());
      const cleanup = () => {
        if (timer) clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        this.pending.delete(id);
      };
      const settle = (ok: boolean, value: unknown) => {
        const active = this.pending.get(id);
        if (!active) return;
        cleanup();
        if (ok) resolve(value as T); else reject(value);
      };
      this.pending.set(id, { resolve: (value) => settle(true, value), reject: (error) => settle(false, error), cleanup });
      if (options.signal?.aborted) { onAbort(); return; }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      if (timeoutMs > 0) timer = setTimeout(() => {
        const error = new Error(`JSON-RPC ${method} timed out after ${timeoutMs}ms`);
        error.name = "TimeoutError";
        settle(false, error);
      }, timeoutMs);
      void this.transport.send({ jsonrpc: "2.0", id, method, params }, options.signal).catch((error) => settle(false, error));
    });
  }

  notify(method: string, params?: unknown, signal?: AbortSignal): Promise<void> {
    if (this.closed) return Promise.reject(new Error("JSON-RPC client is closed"));
    return this.transport.send({ jsonrpc: "2.0", method, params }, signal);
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.unsubscribe();
    const error = new Error("JSON-RPC client closed");
    for (const pending of [...this.pending.values()]) pending.reject(error);
    this.closePromise = bounded(this.transport.close(), this.defaultTimeoutMs, "JSON-RPC close");
    return this.closePromise;
  }

  private receive(message: JsonRpcMessage): void {
    if (message.id == null) return;
    const pending = this.pending.get(message.id);
    if (!pending) return;
    if (message.error) {
      const error = new Error(message.error.message);
      Object.assign(error, { code: message.error.code, data: message.error.data });
      pending.reject(error);
    } else pending.resolve(message.result);
  }
}

export class JsonLineTransport implements JsonRpcTransport {
  private readonly listeners = new Set<(message: JsonRpcMessage) => void>();
  private readonly reader: ReadableStreamDefaultReader<Uint8Array>;
  private readonly writer: WritableStreamDefaultWriter<Uint8Array>;
  private readonly decoder = new TextDecoder();
  private readonly encoder = new TextEncoder();
  private buffer = "";
  private closed = false;
  private closePromise?: Promise<void>;

  constructor(readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>) {
    this.reader = readable.getReader();
    this.writer = writable.getWriter();
    void this.pump();
  }
  onMessage(listener: (message: JsonRpcMessage) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async send(message: JsonRpcMessage, signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new Error("JSON-RPC transport is closed");
    if (signal?.aborted) throw abortError();
    await this.writer.write(this.encoder.encode(`${JSON.stringify(message)}\n`));
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.listeners.clear();
    this.closePromise = Promise.allSettled([this.reader.cancel(), this.writer.close()]).then(() => undefined);
    return this.closePromise;
  }
  private async pump(): Promise<void> {
    try {
      while (!this.closed) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.buffer += this.decoder.decode(value, { stream: true });
        for (;;) {
          const newline = this.buffer.indexOf("\n");
          if (newline < 0) break;
          const line = this.buffer.slice(0, newline).trim();
          this.buffer = this.buffer.slice(newline + 1);
          if (!line) continue;
          try {
            const message = JSON.parse(line) as JsonRpcMessage;
            if (message.jsonrpc === "2.0") for (const listener of this.listeners) listener(message);
          } catch { /* malformed peer frame is isolated */ }
        }
      }
    } catch { /* close/error is surfaced through request timeout or close */ }
  }
}

export class HttpJsonRpcTransport implements JsonRpcTransport {
  private readonly listeners = new Set<(message: JsonRpcMessage) => void>();
  private readonly active = new Set<AbortController>();
  private closed = false;
  constructor(private readonly endpoint: string, private readonly fetchImpl: typeof fetch = fetch, private readonly headers: Record<string, string> = {}) {}
  onMessage(listener: (message: JsonRpcMessage) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  async send(message: JsonRpcMessage, signal?: AbortSignal): Promise<void> {
    if (this.closed) throw new Error("JSON-RPC transport is closed");
    const controller = new AbortController();
    const onAbort = () => controller.abort(signal?.reason);
    if (signal?.aborted) onAbort(); else signal?.addEventListener("abort", onAbort, { once: true });
    this.active.add(controller);
    try {
      const response = await this.fetchImpl(this.endpoint, { method: "POST", headers: { "content-type": "application/json", ...this.headers }, body: JSON.stringify(message), signal: controller.signal });
      if (!response.ok) throw new Error(`JSON-RPC HTTP ${response.status}`);
      if (message.id == null) return;
      if (response.headers.get("content-type")?.includes("text/event-stream")) {
        await readSseMessages(response, (reply) => {
          for (const listener of this.listeners) listener(reply);
        });
      } else {
        const reply = await response.json() as JsonRpcMessage;
        for (const listener of this.listeners) listener(reply);
      }
    } finally {
      signal?.removeEventListener("abort", onAbort);
      this.active.delete(controller);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.active) controller.abort();
    this.active.clear();
    this.listeners.clear();
  }
}

function abortError(): Error { const error = new Error("JSON-RPC request cancelled"); error.name = "AbortError"; return error; }

async function bounded<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (timeoutMs <= 0) return promise;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => { const error = new Error(`${label} timed out`); error.name = "TimeoutError"; reject(error); }, timeoutMs);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}

async function readSseMessages(response: Response, receive: (message: JsonRpcMessage) => void): Promise<void> {
  if (!response.body) throw new Error("JSON-RPC SSE response has no body");
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let data: string[] = [];
  const dispatch = () => {
    if (!data.length) return;
    const raw = data.join("\n");
    data = [];
    try {
      const message = JSON.parse(raw) as JsonRpcMessage;
      if (message.jsonrpc === "2.0") receive(message);
    } catch { /* malformed events are isolated */ }
  };
  for (;;) {
    const { value, done } = await reader.read();
    buffer += decoder.decode(value, { stream: !done });
    for (;;) {
      const newline = buffer.indexOf("\n");
      if (newline < 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/, "");
      buffer = buffer.slice(newline + 1);
      if (line === "") dispatch();
      else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
    }
    if (done) { if (buffer.startsWith("data:")) data.push(buffer.slice(5).trimStart()); dispatch(); break; }
  }
}
