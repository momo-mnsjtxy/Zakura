import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CloudAgentQueuedMessage } from "@zakura/shared";
import {
  ConfiguredSessionQueuePersistence,
  MemorySessionQueuePersistence,
  SessionMessageQueue,
  type QueueCommit,
  type QueueSnapshot,
  type SessionQueuePersistence,
} from "../src/services/cloud-agent/session-message-queue.js";
import { isRedisEnabled } from "../src/services/redis.js";

function item(
  messageId: string,
  mode: "steer" | "queue" = "queue",
): CloudAgentQueuedMessage {
  return {
    messageId,
    content: `content:${messageId}`,
    attachments: [],
    mode,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

describe("SessionMessageQueue", () => {
  it("preserves all concurrent writes across independent service replicas", async () => {
    const persistence = new MemorySessionQueuePersistence();
    const first = new SessionMessageQueue(persistence);
    const second = new SessionMessageQueue(persistence);

    await Promise.all(
      Array.from({ length: 80 }, (_, index) =>
        (index % 2 === 0 ? first : second).enqueue("session", item(`m-${index}`)),
      ),
    );

    const ids = (await first.list("session")).map((queued) => queued.messageId);
    assert.equal(ids.length, 80);
    assert.equal(new Set(ids).size, 80);
    assert.deepEqual(
      [...ids].sort(),
      Array.from({ length: 80 }, (_, index) => `m-${index}`).sort(),
    );
  });

  it("keeps FIFO, drains only steer entries and returns defensive snapshots", async () => {
    const queue = new SessionMessageQueue(new MemorySessionQueuePersistence());
    await queue.enqueue("session", item("a", "steer"));
    await queue.enqueue("session", item("b", "queue"));
    await queue.enqueue("session", item("c", "steer"));

    const exposed = await queue.list("session");
    exposed[0]!.content = "mutated by caller";
    assert.equal((await queue.list("session"))[0]!.content, "content:a");

    const drained = await queue.drainSteer("session");
    assert.deepEqual(drained.map((queued) => queued.messageId), ["a", "c"]);
    assert.deepEqual((await queue.list("session")).map((queued) => queued.messageId), ["b"]);
    assert.equal((await queue.takeHead("session"))?.messageId, "b");
    assert.equal(await queue.takeHead("session"), null);
  });

  it("atomically moves an interrupting item into the one-shot immediate slot", async () => {
    const queue = new SessionMessageQueue(new MemorySessionQueuePersistence());
    await queue.enqueue("session", item("a"));
    await queue.enqueue("session", item("b"));

    const claimed = await queue.claimImmediate("session", "b");
    assert.equal(claimed?.messageId, "b");
    assert.equal(claimed?.interrupt, true);
    assert.deepEqual((await queue.list("session")).map((queued) => queued.messageId), ["a"]);
    assert.equal((await queue.takeImmediate("session"))?.messageId, "b");
    assert.equal(await queue.takeImmediate("session"), null);
  });

  it("retries a stale compare-and-swap without applying a mutation twice", async () => {
    const memory = new MemorySessionQueuePersistence();
    let rejectOnce = true;
    const persistence: SessionQueuePersistence = {
      read: (sessionId: string): Promise<QueueSnapshot> => memory.read(sessionId),
      compareAndSwap: async (
        sessionId: string,
        revision: string | null,
        commit: QueueCommit,
      ) => {
        if (rejectOnce) {
          rejectOnce = false;
          return false;
        }
        return memory.compareAndSwap(sessionId, revision, commit);
      },
      takeImmediate: (sessionId) => memory.takeImmediate(sessionId),
      clear: (sessionId) => memory.clear(sessionId),
    };
    const queue = new SessionMessageQueue(persistence);

    await queue.enqueue("session", item("only-once"));
    assert.deepEqual((await queue.list("session")).map((queued) => queued.messageId), [
      "only-once",
    ]);
  });

  it("clears queue and immediate reservation together", async () => {
    const queue = new SessionMessageQueue(new MemorySessionQueuePersistence());
    await queue.enqueue("session", item("a"));
    await queue.claimImmediate("session", "a");
    await queue.clear("session");
    assert.deepEqual(await queue.list("session"), []);
    assert.equal(await queue.takeImmediate("session"), null);
  });
});

describe(
  "SessionMessageQueue hosted Redis replicas",
  { skip: !isRedisEnabled() ? "REDIS_URL=off" : false },
  () => {
    it("preserves concurrent writes from independent replicas", async () => {
      const sessionId = `queue-cross-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const persistence = new ConfiguredSessionQueuePersistence();
      const first = new SessionMessageQueue(persistence);
      const second = new SessionMessageQueue(persistence);
      try {
        await Promise.all(
          Array.from({ length: 40 }, (_, index) =>
            (index % 2 === 0 ? first : second).enqueue(sessionId, item(`redis-${index}`)),
          ),
        );
        const ids = (await first.list(sessionId)).map((entry) => entry.messageId);
        assert.equal(ids.length, 40);
        assert.equal(new Set(ids).size, 40);
      } finally {
        await first.clear(sessionId);
      }
    });
  },
);
