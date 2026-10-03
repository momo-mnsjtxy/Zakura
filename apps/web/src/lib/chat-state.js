/**
 * Small, framework-free controllers for chat state. Keeping ordering and request
 * ownership here makes route components render state instead of reimplementing
 * concurrency rules in effects.
 */

export function createLatestRequestGate() {
  let current = 0;
  return {
    begin() {
      current += 1;
      return current;
    },
    isCurrent(id) {
      return id === current;
    },
    invalidate() {
      current += 1;
    },
  };
}

/**
 * Merge an event stream by stable id/sequence. Fast ordered delivery remains an
 * O(1) append while reconnect replays and out-of-order packets stay idempotent.
 *
 * @template {{ id: string, seq: number }} T
 * @param {readonly T[]} events
 * @param {T} incoming
 * @returns {T[] | readonly T[]}
 */
export function mergeOrderedEvent(events, incoming) {
  const last = events[events.length - 1];
  if (!last || incoming.seq > last.seq) return [...events, incoming];
  if (events.some((event) => event.id === incoming.id || event.seq === incoming.seq)) {
    return events;
  }
  return [...events, incoming].sort((left, right) => left.seq - right.seq);
}

/**
 * Merge older history without duplicating packets replayed by the live stream.
 *
 * @template {{ seq: number }} T
 * @param {readonly T[]} older
 * @param {readonly T[]} current
 */
export function prependUniqueHistory(older, current) {
  const seen = new Set(current.map((event) => event.seq));
  return [...older.filter((event) => !seen.has(event.seq)), ...current];
}

/** Tracks one in-flight action and guarantees release after failures/cancellation. */
export function createActionController() {
  let pending = false;
  return {
    begin() {
      if (pending) return false;
      pending = true;
      return true;
    },
    finish() {
      pending = false;
    },
    get pending() {
      return pending;
    },
  };
}

export function nextHistoryState({ current, incoming, serverHasMore, beforeSeq }) {
  const events = prependUniqueHistory(incoming, current);
  const changed = events.length !== current.length;
  const incomingOldest = incoming.reduce(
    (min, event) => Math.min(min, event.seq),
    Number.POSITIVE_INFINITY,
  );
  const advancedCursor = Number.isFinite(incomingOldest) && incomingOldest < beforeSeq;
  return {
    events: changed ? events : current,
    hasMore: Boolean(serverHasMore) && (changed || advancedCursor),
    oldestSeq: advancedCursor ? incomingOldest : (events[0]?.seq ?? beforeSeq),
  };
}

export function realtimeTransition(state, event) {
  if (event === "ready" || event === "event") return { status: "online", error: null };
  if (event && typeof event === "object" && event.type === "error") {
    return { status: "offline", error: event.message };
  }
  return state;
}

export function createGenerationGuard() {
  let generation = 0;
  return {
    next() {
      generation += 1;
      return generation;
    },
    isCurrent(value) {
      return value === generation;
    },
  };
}
