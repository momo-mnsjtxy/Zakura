import assert from "node:assert/strict";
import test from "node:test";
import { createNetworkUiController, nextNetworkPoll, preserveSecretDraft, reconcileById, removeById } from "../src/lib/network-ui-state.js";

test("keyed network loads suppress stale responses without crossing pages", () => {
  const state = createNetworkUiController();
  const oldMesh = state.begin("mesh");
  const exposure = state.begin("exposure");
  state.begin("mesh");
  assert.equal(oldMesh.current(), false);
  assert.equal(exposure.current(), true);
});

test("repeated mutations share one request and rejected mutations unlock retry", async () => {
  const state = createNetworkUiController();
  let calls = 0;
  const first = state.runOnce("stop:e1", async () => { calls += 1; throw new Error("offline"); });
  assert.equal(first, state.runOnce("stop:e1", async () => { calls += 1; }));
  await assert.rejects(first, /offline/);
  await state.runOnce("stop:e1", async () => { calls += 1; });
  assert.equal(calls, 2);
});

test("network entities reconcile by id and removal is repeat safe", () => {
  assert.deepEqual(reconcileById([{ id: "a", status: "old" }], { id: "a", status: "ready" }), [{ id: "a", status: "ready" }]);
  assert.deepEqual(removeById(removeById([{ id: "a" }], "a"), "a"), []);
});

test("refresh preserves typed secrets and polling reconnects after bounded backoff", () => {
  assert.deepEqual(preserveSecretDraft({ token: "typed", host: "old" }, { token: "", host: "new" }, ["token"]), { token: "typed", host: "new" });
  const failed = nextNetworkPoll({ failures: 0 }, "error");
  assert.deepEqual(failed, { failures: 1, delayMs: 2000, connected: false });
  assert.deepEqual(nextNetworkPoll(failed, "success"), { failures: 0, delayMs: 1000, connected: true });
});
