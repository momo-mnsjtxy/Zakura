import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import {
  PlatformEventBus,
  platformEvents,
  type PlatformEvent,
  type PlatformEventTransport,
} from "../src/services/platform-events.js";
import { closeRedis } from "../src/services/redis.js";
import {
  beginAgentProgress,
  clearAgentProgress,
  finishAgentProgress,
  logAgentProgress,
} from "../src/services/space-progress.js";

class MemoryFanoutBroker {
  private readonly channels = new Map<string, Set<(message: string) => void>>();

  add(channel: string, listener: (message: string) => void): () => void {
    let listeners = this.channels.get(channel);
    if (!listeners) this.channels.set(channel, (listeners = new Set()));
    listeners.add(listener);
    return () => {
      listeners!.delete(listener);
      if (listeners!.size === 0) this.channels.delete(channel);
    };
  }

  publish(channel: string, message: string): void {
    for (const listener of [...(this.channels.get(channel) ?? [])]) listener(message);
  }

  count(channel: string): number {
    return this.channels.get(channel)?.size ?? 0;
  }
}

class MemoryFanoutTransport implements PlatformEventTransport {
  private readonly releases = new Set<() => void>();

  constructor(private readonly broker: MemoryFanoutBroker) {}

  async subscribe(channel: string, listener: (message: string) => void) {
    const remove = this.broker.add(channel, listener);
    this.releases.add(remove);
    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      this.releases.delete(remove);
      remove();
    };
  }

  async publish(channel: string, message: string): Promise<void> {
    this.broker.publish(channel, message);
  }

  async close(): Promise<void> {
    for (const release of this.releases) release();
    this.releases.clear();
  }
}

async function settleFanout(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

after(async () => {
  // 订阅会惰性建立 Redis 连接，不关会吊住测试进程
  await platformEvents.close();
  await closeRedis();
});

describe("platformEvents bus", () => {
  it("delivers events only to the tenant's subscribers", () => {
    const a: PlatformEvent[] = [];
    const b: PlatformEvent[] = [];
    const unsubA = platformEvents.subscribe("tenant-a", (ev) => a.push(ev));
    const unsubB = platformEvents.subscribe("tenant-b", (ev) => b.push(ev));

    platformEvents.publish("tenant-a", { type: "runner_node", nodeId: "n1" });
    assert.equal(a.length, 1);
    assert.equal(b.length, 0);
    assert.equal(a[0]!.type, "runner_node");
    assert.equal(typeof a[0]!.ts, "number");

    unsubA();
    platformEvents.publish("tenant-a", { type: "runner_node", nodeId: "n2" });
    assert.equal(a.length, 1);
    unsubB();
  });

  it("survives a throwing listener", () => {
    const got: PlatformEvent[] = [];
    const unsub1 = platformEvents.subscribe("tenant-c", () => {
      throw new Error("boom");
    });
    const unsub2 = platformEvents.subscribe("tenant-c", (ev) => got.push(ev));
    platformEvents.publish("tenant-c", { type: "runner_node", nodeId: "n1" });
    assert.equal(got.length, 1);
    unsub1();
    unsub2();
  });

  it("hasListeners reflects subscription state", () => {
    assert.equal(platformEvents.hasListeners("tenant-d"), false);
    const unsub = platformEvents.subscribe("tenant-d", () => {});
    assert.equal(platformEvents.hasListeners("tenant-d"), true);
    unsub();
    assert.equal(platformEvents.hasListeners("tenant-d"), false);
  });

  it("tracks duplicate callbacks as independent idempotent subscriptions", () => {
    const got: PlatformEvent[] = [];
    const listener = (event: PlatformEvent) => got.push(event);
    const first = platformEvents.subscribe("tenant-duplicate", listener);
    const second = platformEvents.subscribe("tenant-duplicate", listener);

    platformEvents.publish("tenant-duplicate", { type: "runner_node", nodeId: "n1" });
    assert.equal(got.length, 2);

    first();
    first();
    assert.equal(platformEvents.hasListeners("tenant-duplicate"), true);
    platformEvents.publish("tenant-duplicate", { type: "runner_node", nodeId: "n2" });
    assert.equal(got.length, 3);

    second();
    assert.equal(platformEvents.hasListeners("tenant-duplicate"), false);
  });
});

describe("PlatformEventBus transport lifecycle", () => {
  it("fans out across replicas with tenant isolation and no publisher loopback", async () => {
    const broker = new MemoryFanoutBroker();
    const first = new PlatformEventBus({
      transport: new MemoryFanoutTransport(broker),
      instanceId: "first",
      now: () => 123,
    });
    const second = new PlatformEventBus({
      transport: new MemoryFanoutTransport(broker),
      instanceId: "second",
      now: () => 456,
    });
    const local: PlatformEvent[] = [];
    const remote: PlatformEvent[] = [];
    const other: PlatformEvent[] = [];
    first.subscribe("tenant", (event) => local.push(event));
    second.subscribe("tenant", (event) => remote.push(event));
    second.subscribe("other", (event) => other.push(event));
    await settleFanout();

    first.publish("tenant", { type: "runner_node", nodeId: "node" });
    await settleFanout();

    assert.equal(local.length, 1);
    assert.equal(remote.length, 1);
    assert.equal(other.length, 0);
    assert.equal(local[0]!.ts, 123);
    assert.equal(remote[0]!.ts, 123);

    first.publishAll({ type: "runner_node", nodeId: "host-broadcast" });
    await settleFanout();
    assert.equal(local.length, 2);
    assert.equal(remote.length, 2);
    assert.equal(other.length, 1);
    assert.equal(other[0]!.ts, 123);
    await Promise.all([first.close(), second.close()]);
  });

  it("serializes immediate unsubscribe/reconnect without leaking or losing the new lease", async () => {
    const broker = new MemoryFanoutBroker();
    const publisher = new PlatformEventBus({
      transport: new MemoryFanoutTransport(broker),
      instanceId: "publisher",
    });
    const subscriber = new PlatformEventBus({
      transport: new MemoryFanoutTransport(broker),
      instanceId: "subscriber",
    });
    const received: PlatformEvent[] = [];

    const releaseFirst = subscriber.subscribe("reconnect", () => {
      throw new Error("released listener must never fire");
    });
    releaseFirst();
    subscriber.subscribe("reconnect", (event) => received.push(event));
    await settleFanout();

    assert.equal(broker.count("zakura:platform:evt:reconnect"), 1);
    publisher.publish("reconnect", { type: "runner_node", nodeId: "after-reconnect" });
    await settleFanout();
    assert.equal(received.length, 1);
    await Promise.all([publisher.close(), subscriber.close()]);
  });

  it("tears down tenant and host subscriptions on close", async () => {
    const broker = new MemoryFanoutBroker();
    const bus = new PlatformEventBus({
      transport: new MemoryFanoutTransport(broker),
      instanceId: "closing",
    });
    bus.subscribe("a", () => undefined);
    bus.subscribe("b", () => undefined);
    await settleFanout();
    assert.equal(broker.count("zakura:platform:evt:a"), 1);
    assert.equal(broker.count("zakura:platform:evt:b"), 1);
    assert.equal(broker.count("zakura:platform:evt:all"), 1);

    await bus.close();
    assert.equal(broker.count("zakura:platform:evt:a"), 0);
    assert.equal(broker.count("zakura:platform:evt:b"), 0);
    assert.equal(broker.count("zakura:platform:evt:all"), 0);
  });
});

describe("agent progress publishing", () => {
  it("publishes snapshots to the bound tenant across begin/log/finish", () => {
    const events: PlatformEvent[] = [];
    const unsub = platformEvents.subscribe("tenant-p", (ev) => events.push(ev));

    beginAgentProgress("agent-x", "starting", "tenant-p");
    logAgentProgress("agent-x", "pull", "拉取镜像", { percent: 30 });
    finishAgentProgress("agent-x", { ok: true, message: "就绪" });

    const snapshots = events.filter(
      (e): e is Extract<PlatformEvent, { type: "agent_progress" }> =>
        e.type === "agent_progress",
    );
    assert.equal(snapshots.length, 3);
    assert.equal(snapshots[0]!.snapshot.running, true);
    assert.equal(snapshots[1]!.snapshot.percent, 30);
    assert.equal(snapshots[2]!.snapshot.done, true);
    assert.equal(snapshots[2]!.snapshot.percent, 100);

    clearAgentProgress("agent-x");
    unsub();
  });

  it("does not publish when no tenant was bound", () => {
    const events: PlatformEvent[] = [];
    const unsub = platformEvents.subscribe("tenant-q", (ev) => events.push(ev));
    beginAgentProgress("agent-y", "starting");
    logAgentProgress("agent-y", "s", "m");
    assert.equal(events.length, 0);
    clearAgentProgress("agent-y");
    unsub();
  });
});
