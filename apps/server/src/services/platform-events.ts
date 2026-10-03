/**
 * Tenant-scoped realtime platform events.
 *
 * Events are intentionally transient. Clients reconnect by loading the durable
 * resource snapshot and then subscribing again. Redis only fans live events
 * between API replicas; local delivery remains available when Redis is off.
 */
import { recordPlatformFault } from "@zakura/core";
import { newId } from "../db/schema.js";
import {
  createRedisSubscriber,
  getRedis,
  isRedisEnabled,
  REDIS_KEYS,
  type ZakuraRedis,
} from "./redis.js";
import type { AgentProgressSnapshot } from "./space-progress.js";
import type { PlatformServiceProgressSnapshot } from "./platform-service-progress.js";

export type PlatformEvent =
  | {
      type: "agent_progress";
      ts: number;
      agentId: string;
      snapshot: AgentProgressSnapshot;
    }
  | {
      type: "mcp_instance";
      ts: number;
      instanceId: string;
      slug: string;
      providerId: string;
      status: string;
      message?: string;
    }
  | {
      type: "mcp_progress";
      ts: number;
      instanceId: string;
      slug: string;
      step: string;
      message: string;
      level: "info" | "warn" | "error" | "ok";
    }
  | {
      type: "platform_service_progress";
      ts: number;
      serviceKey: string;
      snapshot: PlatformServiceProgressSnapshot;
    }
  | { type: "runner_node"; ts: number; nodeId: string }
  | { type: "agent_fs_changed"; ts: number; agentId: string; path: string }
  | { type: "agent_config_changed"; ts: number; agentId: string }
  | {
      type: "cloud_session_changed";
      ts: number;
      agentId: string;
      sessionId: string;
      reason?: "created" | "updated";
    }
  | {
      type: "connector_inbound";
      ts: number;
      agentId: string;
      sessionId: string;
      platform: string;
      title: string;
      preview?: string;
    }
  | {
      type: "browser_notify";
      ts: number;
      agentId: string;
      title: string;
      body?: string;
      url?: string;
    }
  | {
      type: "connector_notice";
      ts: number;
      agentId: string;
      bindingId?: string;
      platform: string;
      level: "info" | "warn" | "error" | "ok";
      message: string;
    };

export type PlatformEventInput = PlatformEvent extends infer Event
  ? Event extends { ts: number }
    ? Omit<Event, "ts">
    : never
  : never;

type Listener = (event: PlatformEvent) => void;
type RemoteUnsubscribe = (() => Promise<void>) | null;

type FanoutEnvelope = {
  from: string;
  tenantId: string;
  event: PlatformEvent;
};

/** Small transport boundary used for deterministic fan-out lifecycle tests. */
export interface PlatformEventTransport {
  subscribe(
    channel: string,
    listener: (message: string) => void,
  ): Promise<RemoteUnsubscribe>;
  publish(channel: string, message: string): Promise<void>;
  close(): Promise<void>;
}

class RedisPlatformEventTransport implements PlatformEventTransport {
  private subscriber: ZakuraRedis | null = null;
  private connecting: Promise<ZakuraRedis | null> | null = null;
  private closed = false;

  private async getSubscriber(): Promise<ZakuraRedis | null> {
    if (this.closed || !isRedisEnabled()) return null;
    if (this.subscriber?.isOpen) return this.subscriber;
    if (!this.connecting) {
      this.connecting = createRedisSubscriber()
        .then(async (subscriber) => {
          if (this.closed && subscriber?.isOpen) {
            await subscriber.quit().catch(() => undefined);
            return null;
          }
          this.subscriber = subscriber;
          return subscriber;
        })
        .finally(() => {
          this.connecting = null;
        });
    }
    return this.connecting;
  }

  async subscribe(
    channel: string,
    listener: (message: string) => void,
  ): Promise<RemoteUnsubscribe> {
    const subscriber = await this.getSubscriber();
    if (!subscriber || this.closed) return null;
    await subscriber.subscribe(channel, listener);
    let active = true;
    return async () => {
      if (!active) return;
      active = false;
      await subscriber.unsubscribe(channel).catch(() => undefined);
    };
  }

  async publish(channel: string, message: string): Promise<void> {
    if (this.closed || !isRedisEnabled()) return;
    const redis = await getRedis();
    if (redis) await redis.publish(channel, message);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const subscriber = await (this.connecting ?? Promise.resolve(this.subscriber)).catch(
      () => null,
    );
    this.subscriber = null;
    this.connecting = null;
    if (subscriber?.isOpen) await subscriber.quit().catch(() => undefined);
  }
}

type ChannelLease = {
  release(): Promise<void>;
};

export type PlatformEventBusOptions = {
  transport?: PlatformEventTransport;
  now?: () => number;
  instanceId?: string;
};

/**
 * Local tenant bus plus Redis fan-out.
 *
 * A tenant has one remote subscription regardless of its local listener count.
 * Channel transitions are serialized so unsubscribe/reconnect races cannot tear
 * down the newly-established subscription.
 */
export class PlatformEventBus {
  private readonly instanceId: string;
  private readonly now: () => number;
  private readonly transport: PlatformEventTransport;
  private readonly listeners = new Map<string, Map<symbol, Listener>>();
  private readonly tenantLeases = new Map<string, ChannelLease>();
  private readonly channelTransitions = new Map<string, Promise<void>>();
  private allLease: ChannelLease | null = null;
  private warnedPublish = false;
  private closed = false;

  constructor(options: PlatformEventBusOptions = {}) {
    this.instanceId = options.instanceId ?? newId();
    this.now = options.now ?? Date.now;
    this.transport = options.transport ?? new RedisPlatformEventTransport();
  }

  subscribe(tenantId: string, listener: Listener): () => void {
    if (this.closed) return () => undefined;
    let tenant = this.listeners.get(tenantId);
    const firstForTenant = !tenant;
    if (!tenant) {
      tenant = new Map();
      this.listeners.set(tenantId, tenant);
    }
    const subscriptionId = Symbol(tenantId);
    tenant.set(subscriptionId, listener);
    if (firstForTenant) this.acquireTenant(tenantId);

    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const current = this.listeners.get(tenantId);
      current?.delete(subscriptionId);
      if (current && current.size === 0) {
        this.listeners.delete(tenantId);
        this.releaseTenant(tenantId);
      }
    };
  }

  publish(tenantId: string, event: PlatformEventInput): void {
    if (this.closed) return;
    const full = { ...event, ts: this.now() } as PlatformEvent;
    this.emitTenant(tenantId, full);
    this.publishRemote(REDIS_KEYS.platformChannel(tenantId), tenantId, full);
  }

  publishAll(event: PlatformEventInput): void {
    if (this.closed) return;
    const full = { ...event, ts: this.now() } as PlatformEvent;
    for (const tenantId of this.listeners.keys()) this.emitTenant(tenantId, full);
    this.publishRemote(REDIS_KEYS.platformChannelAll, "*", full);
  }

  hasListeners(tenantId: string): boolean {
    return (this.listeners.get(tenantId)?.size ?? 0) > 0;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.listeners.clear();
    const leases = [...this.tenantLeases.values()];
    this.tenantLeases.clear();
    if (this.allLease) leases.push(this.allLease);
    this.allLease = null;
    await Promise.all(leases.map((lease) => lease.release().catch(() => undefined)));
    await Promise.all(
      [...this.channelTransitions.values()].map((transition) =>
        transition.catch(() => undefined),
      ),
    );
    this.channelTransitions.clear();
    await this.transport.close().catch((error) =>
      this.fault("platform_events.close", error, { dep: "redis" }),
    );
  }

  private acquireTenant(tenantId: string): void {
    if (this.closed || this.tenantLeases.has(tenantId)) return;
    const channel = REDIS_KEYS.platformChannel(tenantId);
    this.tenantLeases.set(
      tenantId,
      this.createLease(channel, (message) => this.receiveTenant(message)),
    );
    if (!this.allLease) {
      this.allLease = this.createLease(REDIS_KEYS.platformChannelAll, (message) =>
        this.receiveAll(message),
      );
    }
  }

  private releaseTenant(tenantId: string): void {
    const lease = this.tenantLeases.get(tenantId);
    if (!lease) return;
    this.tenantLeases.delete(tenantId);
    void lease.release();
    if (this.tenantLeases.size === 0 && this.allLease) {
      const all = this.allLease;
      this.allLease = null;
      void all.release();
    }
  }

  private createLease(
    channel: string,
    listener: (message: string) => void,
  ): ChannelLease {
    const previous = this.channelTransitions.get(channel) ?? Promise.resolve();
    let released = false;
    let releasePromise: Promise<void> | null = null;
    const ready = previous
      .catch(() => undefined)
      .then(async (): Promise<RemoteUnsubscribe> => {
        if (this.closed || released) return null;
        try {
          return await this.transport.subscribe(channel, listener);
        } catch (error) {
          this.fault("platform_events.subscribe", error, { dep: "redis" });
          return null;
        }
      });

    return {
      release: () => {
        if (releasePromise) return releasePromise;
        released = true;
        releasePromise = ready
          .then(async (unsubscribe) => {
            await unsubscribe?.();
          })
          .catch((error) =>
            this.fault("platform_events.unsubscribe", error, { dep: "redis" }),
          );
        this.channelTransitions.set(channel, releasePromise);
        void releasePromise.finally(() => {
          if (this.channelTransitions.get(channel) === releasePromise) {
            this.channelTransitions.delete(channel);
          }
        });
        return releasePromise;
      },
    };
  }

  private receiveTenant(message: string): void {
    const envelope = this.parseEnvelope(message, "platform_events.parse");
    if (!envelope || envelope.from === this.instanceId) return;
    this.emitTenant(envelope.tenantId, envelope.event);
  }

  private receiveAll(message: string): void {
    const envelope = this.parseEnvelope(message, "platform_events.broadcast_parse");
    if (!envelope || envelope.from === this.instanceId) return;
    for (const tenantId of this.listeners.keys()) this.emitTenant(tenantId, envelope.event);
  }

  private parseEnvelope(message: string, faultKind: string): FanoutEnvelope | null {
    try {
      const parsed = JSON.parse(message) as Partial<FanoutEnvelope>;
      if (
        typeof parsed.from !== "string" ||
        typeof parsed.tenantId !== "string" ||
        !parsed.event ||
        typeof parsed.event !== "object" ||
        typeof (parsed.event as { type?: unknown }).type !== "string"
      ) {
        throw new Error("invalid platform event envelope");
      }
      return parsed as FanoutEnvelope;
    } catch (error) {
      this.fault(faultKind, error, { dep: "redis" });
      return null;
    }
  }

  private publishRemote(channel: string, tenantId: string, event: PlatformEvent): void {
    const envelope: FanoutEnvelope = { from: this.instanceId, tenantId, event };
    void this.transport.publish(channel, JSON.stringify(envelope)).catch((error) => {
      if (this.warnedPublish) return;
      this.warnedPublish = true;
      this.fault("platform_events.publish", error, { dep: "redis" });
    });
  }

  private emitTenant(tenantId: string, event: PlatformEvent): void {
    const tenant = this.listeners.get(tenantId);
    if (!tenant) return;
    for (const listener of tenant.values()) {
      try {
        listener(event);
      } catch (error) {
        this.fault("platform_events.listener", error);
      }
    }
  }

  private fault(kind: string, error: unknown, fields: { dep?: string } = {}): void {
    recordPlatformFault(kind, error, {
      subsystem: "platform_events",
      ...fields,
    });
  }
}

export const platformEvents = new PlatformEventBus();
