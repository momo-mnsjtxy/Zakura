import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DockerRuntime } from "../src/runtime/docker.js";

describe("production DockerRuntime recovery", () => {
  it("force-removes a container allocated after create timeout", async () => {
    let release!: (value: any) => void;
    const removed: Array<{ force?: boolean }> = [];
    const container = {
      id: "late",
      start: async () => {},
      inspect: async () => ({ Id: "late", Name: "/late", Config: { Image: "img", Labels: {} }, State: { Status: "running" }, NetworkSettings: { Ports: {} }, Mounts: [] }),
      remove: async (opts: { force?: boolean }) => { removed.push(opts); },
    };
    const runtime = new DockerRuntime({} as never, { operationTimeoutMs: 5 });
    (runtime as any).docker = {
      createContainer: () => new Promise((resolve) => { release = resolve; }),
      getContainer: () => container,
    };
    const pending = runtime.createAndStart({ tenantId: "t", purpose: "test", spec: { name: "late", image: "img" } });
    await assert.rejects(pending, { name: "TimeoutError" });
    release(container);
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepEqual(removed, [{ force: true }]);
  });

  it("coalesces repeated stop and remove operations", async () => {
    let stops = 0; let removes = 0;
    const container = {
      stop: async () => { stops += 1; await new Promise((resolve) => setTimeout(resolve, 5)); },
      remove: async () => { removes += 1; await new Promise((resolve) => setTimeout(resolve, 5)); },
    };
    const runtime = new DockerRuntime({} as never, { operationTimeoutMs: 100 });
    (runtime as any).docker = { getContainer: () => container };
    await Promise.all([runtime.stop("c"), runtime.stop("c")]);
    await Promise.all([runtime.remove("c"), runtime.remove("c")]);
    assert.equal(stops, 1);
    assert.equal(removes, 1);
  });
});
