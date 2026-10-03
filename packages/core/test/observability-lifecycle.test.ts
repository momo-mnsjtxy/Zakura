import assert from "node:assert/strict";
import test from "node:test";
import { HealthRegistry } from "../src/observability/health.js";
import { MetricsRegistry } from "../src/observability/metrics.js";
import { resetTelemetry, resetTelemetryAsync, Telemetry } from "../src/observability/telemetry.js";

test("duplicate health registration explicitly replaces the prior check", async () => {
  const health = new HealthRegistry("svc", "1");
  health.setReady(true);
  let oldCalls = 0;
  let newCalls = 0;
  health.register("db", () => { oldCalls++; return { status: "down" }; });
  health.register("db", () => { newCalls++; return { status: "up" }; });
  const ready = await health.ready();
  assert.equal(ready.status, "ready");
  assert.equal(ready.checks.db?.status, "up");
  assert.equal(oldCalls, 0);
  assert.equal(newCalls, 1);
});

test("health timeout aborts a cooperative check and returns compatible status", async () => {
  const health = new HealthRegistry("svc", "1");
  health.setReady(true);
  let aborted = false;
  health.register("slow", (signal) => new Promise((resolve) => {
    signal?.addEventListener("abort", () => { aborted = true; resolve({ status: "up" }); }, { once: true });
  }), { timeoutMs: 3 });
  const ready = await health.ready();
  assert.equal(aborted, true);
  assert.equal(ready.status, "not_ready");
  assert.equal(ready.checks.slow?.status, "down");
  assert.equal(ready.checks.slow?.message, "health check timeout");
});

test("metric family metadata conflicts are rejected", () => {
  const metrics = new MetricsRegistry();
  assert.equal(metrics.counter("requests_total", "requests"), metrics.counter("requests_total", "requests"));
  assert.throws(() => metrics.gauge("requests_total", "requests"), /conflicting metric family metadata/);
  metrics.histogram("latency_ms", "latency", [1, 2]);
  assert.throws(() => metrics.histogram("latency_ms", "latency", [1, 3]), /conflicting metric family metadata/);
  assert.throws(() => metrics.histogram("latency_ms", "other", [1, 2]), /conflicting metric family metadata/);
});

test("metric series cardinality is bounded deterministically", () => {
  const metrics = new MetricsRegistry(2);
  const counter = metrics.counter("events_total", "events");
  counter.inc({ kind: "a" });
  counter.inc({ kind: "b" });
  counter.inc({ kind: "c" });
  counter.inc({ kind: "a" });
  assert.equal(counter.get({ kind: "a" }), 2);
  assert.equal(counter.get({ kind: "b" }), 1);
  assert.equal(counter.get({ kind: "c" }), 0);
  const rendered = metrics.renderPrometheus();
  assert.match(rendered, /kind="a"/);
  assert.match(rendered, /kind="b"/);
  assert.doesNotMatch(rendered, /kind="c"/);
});

test("telemetry shutdown coalesces success and awaits exporter", async () => {
  let calls = 0;
  let finish!: () => void;
  const exporter = {
    sink: () => {},
    shutdown: () => { calls++; return new Promise<void>((resolve) => { finish = resolve; }); },
  };
  const telemetry = new Telemetry({ service: "test", otlpBridge: exporter });
  const first = telemetry.shutdown();
  const second = telemetry.shutdown();
  assert.equal(first, second);
  await Promise.resolve();
  assert.equal(calls, 1);
  finish();
  await first;
  assert.equal(await telemetry.shutdown(), undefined);
  assert.equal(calls, 1);
});

test("failed exporter shutdown is observable and retryable", async () => {
  let calls = 0;
  const exporter = {
    sink: () => {},
    shutdown: async () => { if (++calls === 1) throw new Error("flush failed"); },
  };
  const telemetry = new Telemetry({ service: "test", otlpBridge: exporter });
  await assert.rejects(telemetry.shutdown(), /flush failed/);
  await telemetry.shutdown();
  assert.equal(calls, 2);
});

test("ordered reset awaits the previous exporter flush", async () => {
  let release!: () => void;
  let flushed = false;
  resetTelemetry({
    service: "old",
    otlpBridge: {
      sink: () => {},
      shutdown: () => new Promise<void>((resolve) => { release = () => { flushed = true; resolve(); }; }),
    },
  });
  const resetting = resetTelemetryAsync({ service: "new", otlpBridge: null });
  await Promise.resolve();
  assert.equal(flushed, false);
  release();
  const current = await resetting;
  assert.equal(flushed, true);
  assert.equal(current.service, "new");
  await current.shutdown();
});
