import assert from "node:assert/strict";
import test from "node:test";

import {
  createLatestRequestGate,
  mergeOrderedEvent,
  prependUniqueHistory,
} from "../src/lib/chat-state.js";

test("repeated session actions allow only the latest response to commit", () => {
  const gate = createLatestRequestGate();
  const first = gate.begin();
  const second = gate.begin();
  assert.equal(gate.isCurrent(first), false);
  assert.equal(gate.isCurrent(second), true);
  gate.invalidate();
  assert.equal(gate.isCurrent(second), false);
});

test("stream reconnect replay is idempotent and out-of-order packets are sorted", () => {
  const first = { id: "a", seq: 1 };
  const third = { id: "c", seq: 3 };
  const second = { id: "b", seq: 2 };
  const ordered = mergeOrderedEvent(mergeOrderedEvent([first], third), second);
  assert.deepEqual(ordered.map((event) => event.seq), [1, 2, 3]);
  assert.equal(mergeOrderedEvent(ordered, { id: "replay", seq: 2 }), ordered);
});

test("history pagination does not duplicate live events", () => {
  const merged = prependUniqueHistory(
    [{ seq: 1 }, { seq: 2 }],
    [{ seq: 2 }, { seq: 3 }],
  );
  assert.deepEqual(merged.map((event) => event.seq), [1, 2, 3]);
});
