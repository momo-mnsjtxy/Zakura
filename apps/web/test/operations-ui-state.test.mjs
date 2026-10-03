import assert from "node:assert/strict";
import test from "node:test";
import { memoryMutationKey, pollingTransition, toolCallRequestKey } from "../src/lib/operations-ui-state.js";

test("tool-call filter state creates stable stale-load keys", () => {
  assert.equal(toolCallRequestKey({ q: " x ", apiKeyId: "all", agentId: "a", status: "error", offset: 20 }),
    '{"q":"x","key":"all","agent":"a","status":"error","offset":20}');
});

test("memory mutation keys separate regenerate, delete and retry", () => {
  assert.equal(memoryMutationKey("delete", "m1"), "delete:m1");
  assert.equal(memoryMutationKey("reembed", "m1"), "reembed:m1");
});

test("polling state recovers after errors and later success", () => {
  const failed = pollingTransition(pollingTransition({ polling: false, error: null }, "start"), new Error("offline"));
  assert.deepEqual(failed, { polling: false, error: "offline" });
  assert.deepEqual(pollingTransition(failed, "success"), { polling: false, error: null });
});
