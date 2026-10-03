import assert from "node:assert/strict";
import test from "node:test";
import type { ContainerRuntime, CreateContainerOptions, RunningContainer } from "../src/runtime.js";
import { RecoveringContainerRuntime } from "../src/recovering-runtime.js";

const container = (id = "c1"): RunningContainer => ({ id, name: id, image: "test", status: "running", ports: [], labels: {} });
class FakeRuntime implements ContainerRuntime {
  readonly kind = "fake";
  createImpl: (opts: CreateContainerOptions) => Promise<RunningContainer> = async () => container();
  stopImpl: (id: string) => Promise<void> = async () => {};
  removeImpl: (id: string, force?: boolean) => Promise<void> = async () => {};
  createCalls = 0; stopCalls = 0; removeCalls: Array<{ id: string; force?: boolean }> = [];
  ping = async () => ({ ok: true as const, version: "1" });
  ensureNetwork = async () => {};
  ensureImage = async () => {};
  async createAndStart(opts: CreateContainerOptions) { this.createCalls++; return this.createImpl(opts); }
  async stop(id: string) { this.stopCalls++; return this.stopImpl(id); }
  async remove(id: string, force?: boolean) { this.removeCalls.push({ id, force }); return this.removeImpl(id, force); }
  async inspect(_id: string) { return null; }
  async list() { return []; }
  async exec() { return { exitCode: 0, stdout: "", stderr: "" }; }
  async logs() { return ""; }
  buildSpecName(t: string, i: string, c: string) { return `${t}-${i}-${c}`; }
}
const createOpts = { tenantId: "t", purpose: "test", spec: {} } as CreateContainerOptions;

test("late create success after timeout is force-removed", async () => {
  const fake = new FakeRuntime();
  let release!: (value: RunningContainer) => void;
  fake.createImpl = () => new Promise((resolve) => { release = resolve; });
  const runtime = new RecoveringContainerRuntime(fake, { operationTimeoutMs: 5, cleanupTimeoutMs: 20 });
  await assert.rejects(runtime.createAndStart(createOpts), { name: "TimeoutError" });
  release(container("late"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(fake.removeCalls, [{ id: "late", force: true }]);
});

test("create interruption propagates without speculative cleanup", async () => {
  const fake = new FakeRuntime();
  fake.createImpl = async () => { throw new Error("daemon disconnected"); };
  const runtime = new RecoveringContainerRuntime(fake);
  await assert.rejects(runtime.createAndStart(createOpts), /daemon disconnected/);
  assert.equal(fake.removeCalls.length, 0);
});

test("repeated concurrent stop coalesces and later retry is allowed", async () => {
  const fake = new FakeRuntime();
  let release!: () => void;
  let firstAttempt = true;
  fake.stopImpl = () => {
    if (!firstAttempt) return Promise.resolve();
    firstAttempt = false;
    return new Promise<void>((resolve) => { release = resolve; });
  };
  const runtime = new RecoveringContainerRuntime(fake);
  const first = runtime.stop("c1");
  const second = runtime.stop("c1");
  assert.equal(first, second);
  assert.equal(fake.stopCalls, 1);
  release(); await first;
  await runtime.stop("c1");
  assert.equal(fake.stopCalls, 2);
});

test("remove interruption clears coalescing state for recovery retry", async () => {
  const fake = new FakeRuntime();
  let attempts = 0;
  fake.removeImpl = async () => { attempts++; if (attempts === 1) throw new Error("interrupted"); };
  const runtime = new RecoveringContainerRuntime(fake);
  const first = runtime.remove("c1", true);
  const same = runtime.remove("c1", true);
  assert.equal(first, same);
  await assert.rejects(first, /interrupted/);
  await runtime.remove("c1", true);
  assert.equal(attempts, 2);
});

test("stop timeout is bounded and permits a subsequent attempt", async () => {
  const fake = new FakeRuntime();
  fake.stopImpl = async () => new Promise<void>(() => {});
  const runtime = new RecoveringContainerRuntime(fake, { operationTimeoutMs: 3 });
  await assert.rejects(runtime.stop("c1"), { name: "TimeoutError" });
  await assert.rejects(runtime.stop("c1"), { name: "TimeoutError" });
  assert.equal(fake.stopCalls, 2);
});
