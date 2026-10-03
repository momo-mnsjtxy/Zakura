import assert from "node:assert/strict";
import test from "node:test";
import { accessDeepLink, closeSecretReveal, createAccessGovernanceController, reconcileAccessRow, removeAccessRow } from "../src/lib/access-governance-ui-state.js";

test("access governance loads are keyed and suppress stale responses", () => {
  const state = createAccessGovernanceController();
  const stale = state.begin("keys");
  const policies = state.begin("policies");
  state.begin("keys");
  assert.equal(stale.current(), false);
  assert.equal(policies.current(), true);
});

test("repeated revoke or rotation shares one request and unlocks after failure", async () => {
  const state = createAccessGovernanceController();
  let calls = 0;
  const first = state.runOnce("rotate:c1", async () => { calls += 1; throw new Error("offline"); });
  assert.equal(first, state.runOnce("rotate:c1", async () => { calls += 1; }));
  await assert.rejects(first, /offline/);
  await state.runOnce("rotate:c1", async () => { calls += 1; });
  assert.equal(calls, 2);
});

test("server rows reconcile by stable id and revoke is repeat safe", () => {
  assert.deepEqual(reconcileAccessRow([{ id: "k", name: "old" }], { id: "k", name: "new" }), [{ id: "k", name: "new" }]);
  assert.deepEqual(removeAccessRow(removeAccessRow([{ id: "k" }], "k"), "k"), []);
});

test("one-time secret close and deep-link reset are deterministic", () => {
  assert.deepEqual(closeSecretReveal(), { secret: null, subjectId: null, copied: false });
  assert.deepEqual(accessDeepLink("?client=c1"), { selectedId: "c1" });
  assert.deepEqual(accessDeepLink(""), { selectedId: null });
});
