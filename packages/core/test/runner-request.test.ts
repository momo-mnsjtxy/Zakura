import assert from "node:assert/strict";
import test from "node:test";
import { RunnerRequestLifecycle, type UnaryRunnerHub } from "../src/runner-request.js";
import { RunnerClient } from "../src/runner-client.js";

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

test("forwards unary wire request and releases settled bookkeeping", async () => {
  const calls: unknown[][] = [];
  const hub: UnaryRunnerHub = { rpc: async <T>(...args: unknown[]) => { calls.push(args); return { ok: true } as T; } };
  const lifecycle = new RunnerRequestLifecycle(hub);
  assert.deepEqual(await lifecycle.request("host.fs.stat", { path: "/a" }, { timeoutMs: 500 }), { ok: true });
  assert.deepEqual(calls, [["host.fs.stat", { path: "/a" }, 500]]);
  assert.equal(lifecycle.pendingCount, 0);
});

test("timeout rejects once and quarantines a late reply", async () => {
  const call = deferred<string>();
  const lifecycle = new RunnerRequestLifecycle({ rpc: () => call.promise });
  let settlements = 0;
  const request = lifecycle.request("host.fs.read", {}, { timeoutMs: 5 }).finally(() => { settlements++; });
  await assert.rejects(request, { name: "TimeoutError" });
  call.resolve("late");
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(settlements, 1);
  assert.equal(lifecycle.pendingCount, 0);
});

test("AbortSignal cancellation ignores late rejection", async () => {
  const call = deferred<string>();
  const lifecycle = new RunnerRequestLifecycle({ rpc: () => call.promise });
  const controller = new AbortController();
  const request = lifecycle.request("docker.list", {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(request, { name: "AbortError" });
  call.reject(new Error("late failure"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(lifecycle.pendingCount, 0);
});

test("close cancels all pending calls, is idempotent, and blocks future calls", async () => {
  const a = deferred<unknown>();
  const b = deferred<unknown>();
  let calls = 0;
  const lifecycle = new RunnerRequestLifecycle({ rpc: () => (++calls === 1 ? a.promise : b.promise) });
  const first = lifecycle.request("host.fs.list");
  const second = lifecycle.request("docker.images");
  lifecycle.close();
  lifecycle.close();
  await Promise.all([
    assert.rejects(first, { name: "AbortError" }),
    assert.rejects(second, { name: "AbortError" }),
  ]);
  await assert.rejects(lifecycle.request("sys.info"), { name: "AbortError" });
  assert.equal(calls, 2);
  assert.equal(lifecycle.pendingCount, 0);
  a.resolve({}); b.resolve({});
});

test("already-aborted and synchronous hub failures clean up deterministically", async () => {
  let calls = 0;
  const lifecycle = new RunnerRequestLifecycle({ rpc: () => { calls++; throw new Error("sync"); } });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(lifecycle.request("sys.info", {}, { signal: controller.signal }), { name: "AbortError" });
  assert.equal(calls, 0);
  await assert.rejects(lifecycle.request("sys.info"), /sync/);
  assert.equal(lifecycle.pendingCount, 0);
});

test("RunnerClient routes ordinary unary calls through close lifecycle", async () => {
  const call = deferred<unknown>();
  let calls = 0;
  const client = new RunnerClient({
    hub: { rpc: () => { calls++; return call.promise; } },
    workspaceKind: "host",
  });
  const ping = client.ping();
  client.close();
  client.close();
  await assert.rejects(ping, { name: "AbortError" });
  await assert.rejects(client.listDetailed("space", "/"), { name: "AbortError" });
  assert.equal(calls, 1);
  call.resolve({ version: "late" });
});
