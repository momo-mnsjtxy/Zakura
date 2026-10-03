import assert from "node:assert/strict";
import test from "node:test";
import { ProcessLifecycle, type ProcessCloseReason } from "../src/process-lifecycle.js";
import { ShellJob } from "../src/shell-job.js";

test("competing stop/kill/cancel paths execute process cleanup once", async () => {
  const reasons: ProcessCloseReason[] = [];
  const lifecycle = new ProcessLifecycle(async (reason) => { reasons.push(reason); await new Promise((r) => setTimeout(r, 2)); });
  const a = lifecycle.close("stop");
  const b = lifecycle.close("kill");
  assert.equal(a, b);
  await Promise.all([a, b]);
  await lifecycle.close("cancel");
  assert.deepEqual(reasons, ["stop"]);
  assert.equal(lifecycle.running, false);
});

test("natural finish disarms timeout and abort cleanup", async () => {
  let closes = 0;
  const lifecycle = new ProcessLifecycle(async () => { closes++; });
  const controller = new AbortController();
  lifecycle.bindAbort(controller.signal);
  lifecycle.armTimeout(5);
  lifecycle.finish();
  controller.abort();
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(closes, 0);
});

test("timeout and abort race still clean up once", async () => {
  const reasons: ProcessCloseReason[] = [];
  const lifecycle = new ProcessLifecycle(async (reason) => { reasons.push(reason); });
  const controller = new AbortController();
  lifecycle.bindAbort(controller.signal);
  lifecycle.armTimeout(1);
  controller.abort();
  await new Promise((r) => setTimeout(r, 5));
  assert.deepEqual(reasons, ["cancel"]);
});

test("ShellJob kill is idempotent and preserves timeout snapshot contract", async () => {
  const job = new ShellJob({ agentId: "agent-1" });
  let kills = 0;
  job.setIO({ write() {}, async kill() { kills++; await new Promise((r) => setTimeout(r, 2)); } });
  const one = job.kill();
  const two = job.kill();
  assert.equal(one, two);
  await Promise.all([one, two]);
  assert.equal(kills, 1);
  assert.equal(job.snapshot().running, false);
  assert.equal(job.snapshot().timedOut, true);
  assert.equal(job.snapshot().exitCode, 124);
});

test("ShellJob abort cancellation cleans up once without timeout labeling", async () => {
  const job = new ShellJob({ agentId: "agent-1" });
  let kills = 0;
  job.setIO({ write() {}, async kill() { kills++; } });
  const controller = new AbortController();
  job.cancel(controller.signal);
  controller.abort();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(kills, 1);
  assert.equal(job.snapshot().exitCode, 130);
  assert.equal(job.snapshot().timedOut, false);
});
