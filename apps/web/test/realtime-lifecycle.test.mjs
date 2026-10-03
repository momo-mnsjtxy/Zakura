import assert from "node:assert/strict";
import test from "node:test";
import { createConnectionTracker } from "../src/lib/realtime-lifecycle.js";

test("first connect differs from reconnect and reset starts a fresh socket lifecycle", () => {
  const tracker = createConnectionTracker();
  assert.equal(tracker.connect(), false);
  assert.equal(tracker.connect(), true);
  tracker.reset();
  assert.equal(tracker.connect(), false);
});
