import assert from "node:assert/strict";
import test from "node:test";
import { ImageProbeLifecycle, type ImageProbeClock } from "../src/image-probe-lifecycle.js";
import { _resetMirrorCacheForTests, checkImageUpdates, discoverDockerRegistryMirrors, type DockerLike } from "../src/image-update-check.js";

class FakeClock implements ImageProbeClock {
  callbacks = new Map<number, () => void>();
  next = 1;
  setTimeout(callback: () => void): ReturnType<typeof setTimeout> {
    const id = this.next++;
    this.callbacks.set(id, callback);
    return id as unknown as ReturnType<typeof setTimeout>;
  }
  clearTimeout(timer: ReturnType<typeof setTimeout>): void { this.callbacks.delete(timer as unknown as number); }
  fireAll() { for (const callback of [...this.callbacks.values()]) callback(); }
}

const never = <T>() => new Promise<T>(() => {});

test("timeout bounds a non-cooperative operation and quarantines its late result", async () => {
  const clock = new FakeClock();
  const lifecycle = new ImageProbeLifecycle(clock);
  let release!: (value: string) => void;
  const operation = new Promise<string>((resolve) => { release = resolve; });
  let settlements = 0;
  const request = lifecycle.run(() => operation, 10).finally(() => { settlements++; });
  clock.fireAll();
  await assert.rejects(request, { name: "TimeoutError" });
  release("late");
  await Promise.resolve();
  assert.equal(settlements, 1);
  assert.equal(lifecycle.activeCount, 0);
});

test("close bounds active non-cooperative operations and is idempotent", async () => {
  const lifecycle = new ImageProbeLifecycle();
  const request = lifecycle.run(() => never(), 60_000);
  lifecycle.close();
  lifecycle.close();
  await assert.rejects(request, { name: "AbortError" });
  await assert.rejects(lifecycle.run(() => Promise.resolve("no"), 1), { name: "AbortError" });
  assert.equal(lifecycle.activeCount, 0);
});

test("closing a shared lifecycle stops an active image sweep", async () => {
  const lifecycle = new ImageProbeLifecycle();
  const docker: DockerLike = {
    getImage: () => ({ inspect: async () => ({ Id: "local", RepoDigests: ["library/alpine@sha256:" + "a".repeat(64)] }) }),
  };
  let started!: () => void;
  const began = new Promise<void>((resolve) => { started = resolve; });
  const sweep = checkImageUpdates(docker, ["alpine:latest", "busybox:latest"], undefined, {
    lifecycle,
    timeoutMs: 60_000,
    fetchImpl: (() => { started(); return never<Response>(); }) as typeof fetch,
  });
  await began;
  lifecycle.close();
  await assert.rejects(sweep, { name: "AbortError" });
});

test("successful mirror cache expires using the injected clock", async () => {
  _resetMirrorCacheForTests();
  let now = 0;
  let calls = 0;
  const docker: DockerLike = {
    getImage: () => ({ inspect: async () => ({ Id: null }) }),
    info: async () => {
      calls++;
      return { RegistryConfig: { Mirrors: [`https://mirror-${calls}.test/`] } };
    },
  };
  assert.deepEqual(await discoverDockerRegistryMirrors(docker, { now: () => now, ttlMs: 10 }), ["mirror-1.test"]);
  now = 5;
  assert.deepEqual(await discoverDockerRegistryMirrors(docker, { now: () => now, ttlMs: 10 }), ["mirror-1.test"]);
  assert.equal(calls, 1);
  now = 11;
  assert.deepEqual(await discoverDockerRegistryMirrors(docker, { now: () => now, ttlMs: 10 }), ["mirror-2.test"]);
  assert.equal(calls, 2);
  _resetMirrorCacheForTests();
});
