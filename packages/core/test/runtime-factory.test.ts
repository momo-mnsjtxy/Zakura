import assert from "node:assert/strict";
import test from "node:test";
import type { ContainerRuntime, CreateContainerOptions, RunningContainer } from "../src/runtime.js";
import { createContainerRuntime } from "../src/runtime-factory.js";

const running = (id: string): RunningContainer => ({ id, name: id, image: "img", status: "running", ports: [], labels: {} });
const opts = { tenantId: "t", purpose: "test", spec: {} } as CreateContainerOptions;

class ConcreteRuntime implements ContainerRuntime {
  readonly kind: string;
  createImpl: () => Promise<RunningContainer> = async () => running("created");
  removeCalls: Array<{ id: string; force?: boolean }> = [];
  closeCalls = 0;
  closeImpl: () => Promise<void> = async () => {};
  constructor(kind: string) { this.kind = kind; }
  providerExtension() { return `extension:${this.kind}`; }
  async ping() { return { ok: true as const, version: "1" }; }
  async ensureNetwork() {}
  async ensureImage() {}
  async createAndStart() { return this.createImpl(); }
  async stop() {}
  async remove(id: string, force?: boolean) { this.removeCalls.push({ id, force }); }
  async inspect() { return null; }
  async list() { return []; }
  async exec() { return { exitCode: 0, stdout: "", stderr: "" }; }
  async logs() { return ""; }
  buildSpecName(t: string, i: string, c: string) { return `${t}-${i}-${c}`; }
  async close() { this.closeCalls++; return this.closeImpl(); }
}

test("selects requested provider and preserves concrete runtime contract", async () => {
  let dockerCalls = 0;
  const remote = new ConcreteRuntime("remote");
  const selected = createContainerRuntime({
    provider: "remote",
    providers: {
      docker: () => { dockerCalls++; return new ConcreteRuntime("docker"); },
      remote: () => remote,
    },
  });
  assert.equal(selected instanceof ConcreteRuntime, true);
  assert.equal(selected.kind, "remote");
  assert.equal(selected.providerExtension(), "extension:remote");
  assert.equal(dockerCalls, 0);
  assert.deepEqual(await selected.createAndStart(opts), running("created"));
});

test("defaults to docker and can intentionally disable recovery decoration", () => {
  const docker = new ConcreteRuntime("docker");
  const selected = createContainerRuntime({ providers: { docker: () => docker }, recovery: false });
  assert.equal(selected, docker);
  assert.throws(() => createContainerRuntime({ provider: "missing", providers: { docker: () => docker } }), /Unknown container runtime provider/);
});

test("factory composition removes a container allocated after create timeout", async () => {
  const raw = new ConcreteRuntime("docker");
  let release!: (container: RunningContainer) => void;
  raw.createImpl = () => new Promise((resolve) => { release = resolve; });
  const runtime = createContainerRuntime({
    providers: { docker: () => raw },
    recovery: { operationTimeoutMs: 5, cleanupTimeoutMs: 30 },
  });
  await assert.rejects(runtime.createAndStart(opts), { name: "TimeoutError" });
  release(running("late"));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(raw.removeCalls, [{ id: "late", force: true }]);
});

test("close coalesces concurrently, exposes failure, and permits retry", async () => {
  const raw = new ConcreteRuntime("docker");
  let release!: () => void;
  let attempts = 0;
  raw.closeImpl = () => {
    attempts++;
    if (attempts === 1) return new Promise<void>((_, reject) => { release = () => reject(new Error("close interrupted")); });
    return Promise.resolve();
  };
  const runtime = createContainerRuntime({ providers: { docker: () => raw } });
  const first = runtime.close!();
  const concurrent = runtime.close!();
  assert.equal(first, concurrent);
  release();
  await assert.rejects(first, /close interrupted/);
  await runtime.close!();
  assert.equal(raw.closeCalls, 2);
  assert.equal(attempts, 2);
});

test("optional capabilities remain absent when provider does not implement them", () => {
  const raw = new ConcreteRuntime("minimal");
  Object.defineProperty(raw, "close", { value: undefined });
  const runtime = createContainerRuntime({ providers: { docker: () => raw } });
  assert.equal(runtime.execStdio, undefined);
  assert.equal(runtime.attachStdio, undefined);
  assert.equal(runtime.close, undefined);
});
