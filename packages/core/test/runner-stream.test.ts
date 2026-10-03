import assert from "node:assert/strict";
import test from "node:test";
import { openRunnerDuplex, type RunnerStreamHub } from "../src/runner-stream.js";

class FakeHub implements RunnerStreamHub {
  calls: Array<{ method: string; params?: unknown; timeout?: number }> = [];
  listener?: (channel: string, data: Buffer) => void;
  unsubscribed = 0;
  async rpc<T>(method: string, params?: unknown, timeout?: number): Promise<T> {
    this.calls.push({ method, params, timeout });
    return (method.endsWith("start") ? { id: "stream-1" } : { ok: true }) as T;
  }
  onStream(_id: string, fn: (channel: string, data: Buffer) => void) {
    this.listener = fn;
    return () => { this.unsubscribed++; this.listener = undefined; };
  }
  emit(channel: string, data = "") { this.listener?.(channel, Buffer.from(data)); }
}

const open = (hub: FakeHub, signal?: AbortSignal) => openRunnerDuplex({
  hub, startMethod: "host.pty.start", startParams: { command: ["sh"] },
  writeMethod: "host.pty.write", closeMethod: "host.pty.close", timeoutMs: 123, signal,
});

test("routes stdout/stderr and unsubscribes exactly once on remote exit", async () => {
  const hub = new FakeHub();
  const stream = await open(hub);
  let stderr = "";
  stream.onStderr((text) => { stderr += text; });
  const reader = stream.readable.getReader();
  hub.emit("stderr", "warning");
  hub.emit("stdout", "hello");
  assert.equal(Buffer.from((await reader.read()).value!).toString(), "hello");
  hub.emit("exit");
  assert.equal((await reader.read()).done, true);
  assert.equal(stderr, "warning");
  assert.equal(hub.unsubscribed, 1);
  assert.equal(hub.calls.filter((call) => call.method === "host.pty.close").length, 0);
});

test("write preserves base64 wire contract and kill is idempotent", async () => {
  const hub = new FakeHub();
  const stream = await open(hub);
  const writer = stream.writable.getWriter();
  await writer.write(Buffer.from([0, 255, 1]));
  await Promise.all([stream.kill(), stream.kill()]);
  const write = hub.calls.find((call) => call.method === "host.pty.write")!;
  assert.deepEqual(write.params, { id: "stream-1", base64: "AP8B" });
  assert.equal(write.timeout, 123);
  assert.equal(hub.calls.filter((call) => call.method === "host.pty.close").length, 1);
  assert.equal(hub.unsubscribed, 1);
});

test("abort closes remote stream and rejects already-aborted starts", async () => {
  const hub = new FakeHub();
  const controller = new AbortController();
  const stream = await open(hub, controller.signal);
  controller.abort();
  await stream.kill();
  assert.equal(hub.calls.filter((call) => call.method === "host.pty.close").length, 1);
  assert.equal(hub.unsubscribed, 1);

  const pre = new AbortController();
  pre.abort();
  await assert.rejects(open(new FakeHub(), pre.signal), { name: "AbortError" });
});

test("readable cancellation propagates one remote close", async () => {
  const hub = new FakeHub();
  const stream = await open(hub);
  await stream.readable.cancel();
  assert.equal(hub.calls.filter((call) => call.method === "host.pty.close").length, 1);
  assert.equal(hub.unsubscribed, 1);
});

test("abort during start closes a stream allocated after cancellation", async () => {
  let release!: (value: { id: string }) => void;
  const start = new Promise<{ id: string }>((resolve) => { release = resolve; });
  const calls: string[] = [];
  const hub: RunnerStreamHub = {
    async rpc<T>(method: string): Promise<T> {
      calls.push(method);
      if (method === "host.pty.start") return start as Promise<T>;
      return { ok: true } as T;
    },
  };
  const controller = new AbortController();
  const opening = openRunnerDuplex({
    hub,
    startMethod: "host.pty.start",
    startParams: {},
    writeMethod: "host.pty.write",
    closeMethod: "host.pty.close",
    signal: controller.signal,
  });
  controller.abort();
  await assert.rejects(opening, { name: "AbortError" });
  release({ id: "late-stream" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(calls, ["host.pty.start", "host.pty.close"]);
});
