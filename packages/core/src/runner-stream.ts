import { Buffer } from "node:buffer";

export type RunnerStreamHub = {
  rpc<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  onStream?: (id: string, fn: (chan: string, data: Buffer) => void) => () => void;
};

export type RunnerDuplex = {
  writable: WritableStream<Uint8Array>;
  readable: ReadableStream<Uint8Array>;
  kill: () => Promise<void>;
  onStderr: (fn: (chunk: string) => void) => () => void;
};

export async function openRunnerDuplex(input: {
  hub: RunnerStreamHub;
  startMethod: string;
  startParams: Record<string, unknown>;
  writeMethod: string;
  closeMethod: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}): Promise<RunnerDuplex> {
  if (input.signal?.aborted) throw abortError();
  const startPromise = input.hub.rpc<{ id: string }>(
    input.startMethod,
    input.startParams,
    input.timeoutMs,
  );
  let started: { id: string };
  try {
    started = await raceAbort(startPromise, input.signal);
  } catch (error) {
    // Cancellation may win after the daemon has already allocated a stream.
    // Observe the eventual start result and close it so no PTY/process leaks.
    if (input.signal?.aborted) {
      void startPromise.then((late) => {
        if (late.id) {
          return input.hub.rpc(input.closeMethod, { id: late.id }, input.timeoutMs);
        }
      }).catch(() => undefined);
    }
    throw error;
  }
  if (!started.id) throw new Error(`Runner ${input.startMethod} returned no stream id`);

  const listeners = new Set<(chunk: string) => void>();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let unsubscribe: (() => void) | undefined;
  let closePromise: Promise<void> | undefined;
  let closed = false;
  let remoteExited = false;

  const cleanup = () => {
    unsubscribe?.();
    unsubscribe = undefined;
    input.signal?.removeEventListener("abort", onAbort);
    listeners.clear();
  };
  const finishReadable = () => {
    if (closed) return;
    closed = true;
    cleanup();
    try { controller?.close(); } catch { /* consumer already cancelled */ }
  };
  const closeRemote = (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      try {
        if (!remoteExited) {
          await input.hub.rpc(input.closeMethod, { id: started.id }, input.timeoutMs);
        }
      } finally {
        finishReadable();
      }
    })().catch((error) => {
      // Cleanup failures are observable, and a later explicit kill may retry
      // the remote close even though local listeners are already detached.
      closePromise = undefined;
      throw error;
    });
    return closePromise;
  };
  const onAbort = () => { void closeRemote().catch(() => undefined); };

  const readable = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      unsubscribe = input.hub.onStream?.(started.id, (channel, data) => {
        if (closed) return;
        if (channel === "stdout" && data.length) c.enqueue(new Uint8Array(data));
        else if (channel === "stderr" && data.length) {
          const text = data.toString("utf8");
          for (const listener of listeners) listener(text);
        } else if (channel === "exit") {
          remoteExited = true;
          finishReadable();
        }
      });
    },
    cancel() { return closeRemote(); },
  });
  input.signal?.addEventListener("abort", onAbort, { once: true });
  if (input.signal?.aborted) onAbort();

  const writable = new WritableStream<Uint8Array>({
    async write(chunk) {
      if (closed) throw new Error("Runner stream is closed");
      await raceAbort(
        input.hub.rpc(input.writeMethod, { id: started.id, base64: Buffer.from(chunk).toString("base64") }, input.timeoutMs),
        input.signal,
      );
    },
    close: closeRemote,
    abort: closeRemote,
  });

  return {
    readable,
    writable,
    kill: closeRemote,
    onStderr(listener) {
      if (!closed) listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

async function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) throw abortError();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function abortError(): Error {
  const error = new Error("Runner operation cancelled");
  error.name = "AbortError";
  return error;
}
