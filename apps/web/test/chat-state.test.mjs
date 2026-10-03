import assert from "node:assert/strict";
import test from "node:test";

import {
  createLatestRequestGate,
  createActionController,
  mergeOrderedEvent,
  nextHistoryState,
  prependUniqueHistory,
  realtimeTransition,
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

test("interrupted cancel unlocks so the user can retry", () => {
  const action = createActionController();
  assert.equal(action.begin(), true);
  assert.equal(action.begin(), false);
  action.finish();
  assert.equal(action.begin(), true);
});

test("history state closes pagination when replay adds no rows", () => {
  const current = [{ seq: 2 }, { seq: 3 }];
  const next = nextHistoryState({ current, incoming: [{ seq: 2 }], serverHasMore: true, beforeSeq: 2 });
  assert.equal(next.events, current);
  assert.equal(next.hasMore, false);
  assert.equal(next.oldestSeq, 2);
});

test("realtime error recovers on subscription ready or the next event", () => {
  const offline = realtimeTransition({ status: "online", error: null }, { type: "error", message: "lost" });
  assert.deepEqual(offline, { status: "offline", error: "lost" });
  assert.deepEqual(realtimeTransition(offline, "ready"), { status: "online", error: null });
  assert.deepEqual(realtimeTransition(offline, "event"), { status: "online", error: null });
});
