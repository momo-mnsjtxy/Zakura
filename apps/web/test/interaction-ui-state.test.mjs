import assert from "node:assert/strict";
import test from "node:test";
import { createResolutionController, interactionKey, isInteractionExpired, nextAskDraft, normalizeAskAnswer, resolveWithRetry } from "../src/lib/interaction-ui-state.js";

test("duplicate prompts resolve once until replay confirms resolution", () => {
  const controller = createResolutionController();
  assert.equal(controller.begin("r1"), true);
  assert.equal(controller.begin("r1"), false);
  controller.replayResolved("r1");
  assert.equal(controller.begin("r1"), true);
  controller.reconnect();
  assert.equal(controller.begin("r1"), true);
});

test("timeout display is deterministic while the server remains resolution authority", () => {
  assert.equal(isInteractionExpired("2026-01-01T00:00:00.000Z", Date.parse("2026-01-02T00:00:00.000Z")), true);
  assert.equal(isInteractionExpired(null, 0), false);
});

test("ask answers dedupe options, trim text, and preserve cancel", () => {
  assert.deepEqual(normalizeAskAnswer({ requestId: "r", selected: ["a", "a"], text: " note " }), {
    requestId: "r", selected: ["a"], text: "note",
  });
  assert.deepEqual(normalizeAskAnswer({ requestId: "r", cancelled: true, selected: ["a"] }), {
    requestId: "r", cancelled: true,
  });
  assert.equal(interactionKey({ requestId: "r", resolved: { status: "timeout" } }), "r:timeout");
});

test("same-request cloned defaults preserve in-progress ask draft", () => {
  const current = { requestId: "r", selected: ["user-choice"], text: "draft" };
  assert.equal(nextAskDraft(current, "r", "r", ["server-default"]), current);
  assert.deepEqual(nextAskDraft(current, "r", "next", ["new-default"]), {
    requestId: "next", selected: ["new-default"], text: "",
  });
});

test("failed async resolution unlocks the card for retry", async () => {
  const controller = createResolutionController();
  await assert.rejects(resolveWithRetry(controller, "r", async () => { throw new Error("offline"); }), /offline/);
  assert.equal(controller.isPending("r"), false);
  assert.equal(await resolveWithRetry(controller, "r", async () => undefined), true);
});
