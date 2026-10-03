import { recordPlatformFault } from "@zakura/core";
import type { CloudAgentQueuedMessage } from "@zakura/shared";
import {
  getRedis,
  isRedisEnabled,
  REDIS_KEYS,
  type ZakuraRedis,
} from "../redis.js";

const QUEUE_TTL_SECONDS = 7 * 24 * 60 * 60;
const MISSING_REVISION = "__zakura_missing_queue__";
const MAX_COMPARE_AND_SWAP_ATTEMPTS = 32;

export type QueueSnapshot = {
  /** Opaque value used to reject stale writers. */
  revision: string | null;
  items: CloudAgentQueuedMessage[];
};

export type QueueCommit = {
  items: CloudAgentQueuedMessage[];
  /** Written atomically with the queue snapshot when present. */
  immediate?: CloudAgentQueuedMessage;
};

/** Persistence boundary used by the queue state machine. */
export interface SessionQueuePersistence {
  read(sessionId: string): Promise<QueueSnapshot>;
  compareAndSwap(
    sessionId: string,
    expectedRevision: string | null,
    commit: QueueCommit,
  ): Promise<boolean>;
  takeImmediate(sessionId: string): Promise<CloudAgentQueuedMessage | null>;
  clear(sessionId: string): Promise<void>;
}

export function normalizeQueuedMessage(
  item: CloudAgentQueuedMessage,
): CloudAgentQueuedMessage {
  return {
    messageId: item.messageId,
    content: item.content ?? "",
    attachments: Array.isArray(item.attachments) ? [...item.attachments] : [],
    mode: item.mode === "queue" ? "queue" : "steer",
    ...(item.interrupt ? { interrupt: true } : {}),
    createdAt: item.createdAt || new Date().toISOString(),
    ...(item.userId
      ? {
          userId: item.userId,
          ...(item.userName ? { userName: item.userName } : {}),
        }
      : {}),
  };
}

function copyItems(items: CloudAgentQueuedMessage[]): CloudAgentQueuedMessage[] {
  return items.map(normalizeQueuedMessage);
}

function decodeItems(raw: string | null): CloudAgentQueuedMessage[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return (parsed as CloudAgentQueuedMessage[])
      .filter((item) => item && typeof item.messageId === "string" && item.messageId.length > 0)
      .map(normalizeQueuedMessage);
  } catch {
    return [];
  }
}

/**
 * Process-local persistence used when Redis is explicitly disabled.
 * Values stay serialized so its compare-and-swap contract matches Redis.
 */
export class MemorySessionQueuePersistence implements SessionQueuePersistence {
  private readonly queues = new Map<string, string>();
  private readonly immediate = new Map<string, string>();

  async read(sessionId: string): Promise<QueueSnapshot> {
    const raw = this.queues.get(sessionId) ?? null;
    return { revision: raw, items: decodeItems(raw) };
  }

  async compareAndSwap(
    sessionId: string,
    expectedRevision: string | null,
    commit: QueueCommit,
  ): Promise<boolean> {
    const current = this.queues.get(sessionId) ?? null;
    if (current !== expectedRevision) return false;
    if (commit.items.length === 0) this.queues.delete(sessionId);
    else this.queues.set(sessionId, JSON.stringify(copyItems(commit.items)));
    if (commit.immediate) {
      this.immediate.set(sessionId, JSON.stringify(normalizeQueuedMessage(commit.immediate)));
    }
    return true;
  }

  async takeImmediate(sessionId: string): Promise<CloudAgentQueuedMessage | null> {
    const raw = this.immediate.get(sessionId);
    if (!raw) return null;
    this.immediate.delete(sessionId);
    return decodeImmediate(raw);
  }

  async clear(sessionId: string): Promise<void> {
    this.queues.delete(sessionId);
    this.immediate.delete(sessionId);
  }
}

function decodeImmediate(raw: string | null): CloudAgentQueuedMessage | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as CloudAgentQueuedMessage;
    if (!parsed || typeof parsed.messageId !== "string" || !parsed.messageId) return null;
    return normalizeQueuedMessage(parsed);
  } catch {
    return null;
  }
}

/** Redis snapshot persistence with cross-process optimistic concurrency. */
export class RedisSessionQueuePersistence implements SessionQueuePersistence {
  constructor(private readonly redis: ZakuraRedis) {}

  async read(sessionId: string): Promise<QueueSnapshot> {
    const value = await this.redis.get(REDIS_KEYS.queue(sessionId));
    const raw = typeof value === "string" ? value : null;
    return { revision: raw, items: decodeItems(raw) };
  }

  async compareAndSwap(
    sessionId: string,
    expectedRevision: string | null,
    commit: QueueCommit,
  ): Promise<boolean> {
    const queueKey = REDIS_KEYS.queue(sessionId);
    const immediateKey = REDIS_KEYS.queueNext(sessionId);
    const next = commit.items.length > 0 ? JSON.stringify(copyItems(commit.items)) : "";
    const immediate = commit.immediate
      ? JSON.stringify(normalizeQueuedMessage(commit.immediate))
      : "";
    const changed = await this.redis.eval(
      `local current = redis.call('GET', KEYS[1])
       local actual = current or ARGV[1]
       if actual ~= ARGV[2] then return 0 end
       if ARGV[3] == '' then
         redis.call('DEL', KEYS[1])
       else
         redis.call('SET', KEYS[1], ARGV[3], 'EX', ARGV[4])
       end
       if ARGV[5] ~= '' then
         redis.call('SET', KEYS[2], ARGV[5], 'EX', ARGV[4])
       end
       return 1`,
      {
        keys: [queueKey, immediateKey],
        arguments: [
          MISSING_REVISION,
          expectedRevision ?? MISSING_REVISION,
          next,
          String(QUEUE_TTL_SECONDS),
          immediate,
        ],
      },
    );
    return Number(changed) === 1;
  }

  async takeImmediate(sessionId: string): Promise<CloudAgentQueuedMessage | null> {
    const raw = await this.redis.eval(
      `local value = redis.call('GET', KEYS[1])
       if value then redis.call('DEL', KEYS[1]) end
       return value`,
      { keys: [REDIS_KEYS.queueNext(sessionId)], arguments: [] },
    );
    return decodeImmediate(typeof raw === "string" ? raw : null);
  }

  async clear(sessionId: string): Promise<void> {
    await this.redis.del([
      REDIS_KEYS.queue(sessionId),
      REDIS_KEYS.queueNext(sessionId),
    ]);
  }
}

/** Selects Redis when configured and otherwise retains one process-local backend. */
export class ConfiguredSessionQueuePersistence implements SessionQueuePersistence {
  private readonly memory = new MemorySessionQueuePersistence();

  private async current(): Promise<SessionQueuePersistence> {
    if (!isRedisEnabled()) return this.memory;
    const redis = await getRedis();
    if (!redis) return this.memory;
    return new RedisSessionQueuePersistence(redis);
  }

  async read(sessionId: string): Promise<QueueSnapshot> {
    return (await this.current()).read(sessionId);
  }

  async compareAndSwap(
    sessionId: string,
    expectedRevision: string | null,
    commit: QueueCommit,
  ): Promise<boolean> {
    return (await this.current()).compareAndSwap(sessionId, expectedRevision, commit);
  }

  async takeImmediate(sessionId: string): Promise<CloudAgentQueuedMessage | null> {
    return (await this.current()).takeImmediate(sessionId);
  }

  async clear(sessionId: string): Promise<void> {
    return (await this.current()).clear(sessionId);
  }
}

type Mutation<T> = (items: CloudAgentQueuedMessage[]) => {
  items: CloudAgentQueuedMessage[];
  result: T;
  immediate?: CloudAgentQueuedMessage;
};

/**
 * Durable state machine for follow-up messages.
 *
 * Mutations are ordered within a process and use CAS in persistence, so two API
 * replicas cannot silently overwrite each other's enqueue/dequeue decisions.
 */
export class SessionMessageQueue {
  private readonly chains = new Map<string, Promise<unknown>>();

  constructor(
    private readonly persistence: SessionQueuePersistence =
      new ConfiguredSessionQueuePersistence(),
  ) {}

  async list(sessionId: string): Promise<CloudAgentQueuedMessage[]> {
    const snapshot = await this.persistence.read(sessionId);
    return copyItems(snapshot.items);
  }

  enqueue(
    sessionId: string,
    item: CloudAgentQueuedMessage,
  ): Promise<CloudAgentQueuedMessage[]> {
    const queued = normalizeQueuedMessage(item);
    return this.mutate(sessionId, (items) => {
      const next = [...items.filter((candidate) => candidate.messageId !== queued.messageId), queued];
      return { items: next, result: copyItems(next) };
    });
  }

  update(
    sessionId: string,
    messageId: string,
    patch: { content?: string },
  ): Promise<CloudAgentQueuedMessage | null> {
    return this.mutate(sessionId, (items) => {
      let found: CloudAgentQueuedMessage | null = null;
      const next = items.map((candidate) => {
        if (candidate.messageId !== messageId) return candidate;
        found = normalizeQueuedMessage({
          ...candidate,
          ...(patch.content !== undefined ? { content: patch.content } : {}),
        });
        return found;
      });
      return { items: next, result: found };
    });
  }

  remove(sessionId: string, messageId: string): Promise<CloudAgentQueuedMessage | null> {
    return this.mutate(sessionId, (items) => {
      const found = items.find((candidate) => candidate.messageId === messageId) ?? null;
      return {
        items: items.filter((candidate) => candidate.messageId !== messageId),
        result: found ? normalizeQueuedMessage(found) : null,
      };
    });
  }

  promote(sessionId: string, messageId: string): Promise<CloudAgentQueuedMessage | null> {
    return this.mutate(sessionId, (items) => {
      const found = items.find((candidate) => candidate.messageId === messageId);
      if (!found) return { items, result: null };
      const promoted = normalizeQueuedMessage({ ...found, interrupt: true });
      return {
        items: [promoted, ...items.filter((candidate) => candidate.messageId !== messageId)],
        result: promoted,
      };
    });
  }

  claimImmediate(
    sessionId: string,
    messageId: string,
  ): Promise<CloudAgentQueuedMessage | null> {
    return this.mutate(sessionId, (items) => {
      const found = items.find((candidate) => candidate.messageId === messageId);
      if (!found) return { items, result: null };
      const immediate = normalizeQueuedMessage({ ...found, interrupt: true });
      return {
        items: items.filter((candidate) => candidate.messageId !== messageId),
        result: immediate,
        immediate,
      };
    });
  }

  takeImmediate(sessionId: string): Promise<CloudAgentQueuedMessage | null> {
    return this.persistence.takeImmediate(sessionId);
  }

  async clear(sessionId: string): Promise<void> {
    const pending = this.chains.get(sessionId);
    if (pending) await pending.catch(() => undefined);
    await this.persistence.clear(sessionId);
    this.chains.delete(sessionId);
  }

  takeHead(sessionId: string): Promise<CloudAgentQueuedMessage | null> {
    return this.mutate(sessionId, (items) => {
      const [head, ...rest] = items;
      return { items: head ? rest : items, result: head ? normalizeQueuedMessage(head) : null };
    });
  }

  async requeueFront(sessionId: string, item: CloudAgentQueuedMessage): Promise<void> {
    const queued = normalizeQueuedMessage(item);
    await this.mutate(sessionId, (items) => ({
      items: [queued, ...items.filter((candidate) => candidate.messageId !== queued.messageId)],
      result: undefined,
    }));
  }

  drainSteer(sessionId: string): Promise<CloudAgentQueuedMessage[]> {
    return this.mutate(sessionId, (items) => {
      const drained = items.filter((candidate) => candidate.mode === "steer");
      return {
        items: items.filter((candidate) => candidate.mode !== "steer"),
        result: copyItems(drained),
      };
    });
  }

  private mutate<T>(sessionId: string, mutation: Mutation<T>): Promise<T> {
    const previous = this.chains.get(sessionId) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(async () => {
      for (let attempt = 0; attempt < MAX_COMPARE_AND_SWAP_ATTEMPTS; attempt += 1) {
        const snapshot = await this.persistence.read(sessionId);
        const next = mutation(copyItems(snapshot.items));
        const committed = await this.persistence.compareAndSwap(sessionId, snapshot.revision, {
          items: copyItems(next.items),
          ...(next.immediate ? { immediate: normalizeQueuedMessage(next.immediate) } : {}),
        });
        if (committed) return next.result;
      }
      const error = new Error(`会话队列并发冲突过多：${sessionId}`);
      recordPlatformFault("cloud_agent.queue_conflict", error, {
        subsystem: "cloud_agent",
        dep: isRedisEnabled() ? "redis" : undefined,
      });
      throw error;
    });
    this.chains.set(sessionId, operation);
    void operation.finally(() => {
      if (this.chains.get(sessionId) === operation) this.chains.delete(sessionId);
    }).catch(() => undefined);
    return operation;
  }
}
