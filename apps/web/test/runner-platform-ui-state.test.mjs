import assert from "node:assert/strict";
import test from "node:test";
import { closeRunnerActionState, createRunnerPlatformController, mergeServiceDraft, reconcileRunner, runnerPollState } from "../src/lib/runner-platform-ui-state.js";

test("runner and service loads are keyed and stale results are suppressed", () => {
  const state = createRunnerPlatformController();
  const old = state.begin("runner:r1");
  const services = state.begin("services");
  state.begin("runner:r1");
  assert.equal(old.current(), false);
  assert.equal(services.current(), true);
});

test("install, upgrade and cancel requests dedupe then unlock after interruption", async () => {
  const state = createRunnerPlatformController();
  let calls = 0;
  const first = state.runOnce("upgrade:r1", async () => { calls += 1; throw new Error("lost"); });
  assert.equal(first, state.runOnce("upgrade:r1", async () => { calls += 1; }));
  await assert.rejects(first, /lost/);
  await state.runOnce("upgrade:r1", async () => { calls += 1; });
  assert.equal(calls, 2);
});

test("authoritative runner status replaces by id and service refresh preserves secrets", () => {
  assert.deepEqual(reconcileRunner([{ id: "r1", status: "updating" }], { id: "r1", status: "online" }), [{ id: "r1", status: "online" }]);
  assert.deepEqual(mergeServiceDraft({ apiKey: "typed", host: "old" }, { apiKey: "", host: "new" }, ["apiKey"]), { apiKey: "typed", host: "new" });
});

test("polling reconnects quickly after bounded backoff and close resets action state", () => {
  const failed = runnerPollState({ failures: 0 }, "error");
  assert.deepEqual(failed, { failures: 1, connected: false, delayMs: 2000 });
  assert.deepEqual(runnerPollState(failed, "success"), { failures: 0, connected: true, delayMs: 1000 });
  assert.deepEqual(closeRunnerActionState(), { selectedId: null, action: null, error: null });
});
