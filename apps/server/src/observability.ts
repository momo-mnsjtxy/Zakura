import { sql } from "drizzle-orm";
import type { Hono } from "hono";
import {
  getTelemetry,
  initTelemetry,
  type HealthCheckResult,
  type Telemetry,
} from "@zakura/core";
import type { Db } from "./db/client.js";
import { getRedis, isRedisEnabled } from "./services/redis.js";
import type { DockerRuntime } from "./runtime/docker.js";

export const SERVER_VERSION = "0.2.0";

const registeredHealth = new WeakSet<Telemetry>();
const mountedProbeApps = new WeakSet<object>();

export function initServerTelemetry(): Telemetry {
  return initTelemetry({
    service: "zakura",
    version: SERVER_VERSION,
  });
}

export async function probeDb(db: Db): Promise<HealthCheckResult> {
  const t0 = performance.now();
  try {
    await db.execute(sql`SELECT 1`);
    return { status: "up", latencyMs: Math.round(performance.now() - t0) };
  } catch (err) {
    return {
      status: "down",
      latencyMs: Math.round(performance.now() - t0),
      message: err instanceof Error ? err.message : "db probe failed",
    };
  }
}

export async function probeRedis(deps: {
  enabled?: () => boolean;
  getClient?: typeof getRedis;
} = {}): Promise<HealthCheckResult> {
  const enabled = deps.enabled ?? isRedisEnabled;
  const getClient = deps.getClient ?? getRedis;
  if (!enabled()) return { status: "disabled" };
  const t0 = performance.now();
  try {
    const client = await getClient();
    if (!client) return { status: "disabled" };
    await client.ping();
    return { status: "up", latencyMs: Math.round(performance.now() - t0) };
  } catch (err) {
    return {
      status: "down",
      latencyMs: Math.round(performance.now() - t0),
      message: err instanceof Error ? err.message : "redis probe failed",
    };
  }
}

export async function probeDocker(runtime: DockerRuntime): Promise<HealthCheckResult> {
  const t0 = performance.now();
  try {
    const ping = await runtime.ping();
    const latencyMs = Math.round(performance.now() - t0);
    if (ping.ok) return { status: "up", latencyMs };
    return { status: "down", latencyMs, message: ping.error };
  } catch (err) {
    return {
      status: "down",
      latencyMs: Math.round(performance.now() - t0),
      message: err instanceof Error ? err.message : "docker probe failed",
    };
  }
}

export function registerServerHealthChecks(opts: {
  db: Db;
  runtime: DockerRuntime;
}): void {
  const telemetry = getTelemetry();
  if (registeredHealth.has(telemetry)) return;
  registeredHealth.add(telemetry);
  telemetry.registerCheck("db", () => probeDb(opts.db), { critical: true });
  telemetry.registerCheck("redis", () => probeRedis(), {
    critical: isRedisEnabled(),
  });
  telemetry.registerCheck("docker", () => probeDocker(opts.runtime), {
    critical: false,
  });
}

/** Liveness / readiness / Prometheus. No tenant data. Public. */
export function mountPlatformProbes(app: Hono): void {
  if (mountedProbeApps.has(app)) return;
  mountedProbeApps.add(app);
  const live = (c: { json: (body: unknown, status?: 200) => Response }) =>
    c.json(getTelemetry().health.live(), 200);

  const ready = async (c: {
    json: (body: unknown, status?: 200 | 503) => Response;
  }) => {
    const body = await getTelemetry().health.ready();
    return c.json(body, body.status === "ready" ? 200 : 503);
  };

  const metricsText = (c: {
    text: (body: string, status?: 200, headers?: Record<string, string>) => Response;
  }) =>
    c.text(getTelemetry().metrics.renderPrometheus(), 200, {
      "content-type": "text/plain; version=0.0.4; charset=utf-8",
    });

  app.get("/livez", live);
  app.get("/healthz", live);
  app.get("/readyz", ready);
  app.get("/metrics", metricsText);
  app.get("/api/health", live);
  app.get("/api/livez", live);
  app.get("/api/ready", ready);
  app.get("/api/readyz", ready);
  app.get("/api/metrics", metricsText);
}
