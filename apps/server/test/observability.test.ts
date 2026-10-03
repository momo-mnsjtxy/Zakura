import assert from "node:assert/strict";
import { describe, it, afterEach } from "node:test";
import { Hono } from "hono";
import { resetTelemetry } from "@zakura/core";
import {
  mountPlatformProbes,
  probeDocker,
  probeRedis,
  registerServerHealthChecks,
  SERVER_VERSION,
} from "../src/observability.js";

describe("platform probes", () => {
  afterEach(() => {
    resetTelemetry({ service: "zakura", version: SERVER_VERSION }).shutdown();
  });

  it("livez is 200 without leaking urls", async () => {
    const t = resetTelemetry({ service: "zakura", version: SERVER_VERSION });
    const app = new Hono();
    mountPlatformProbes(app);
    const res = await app.request("/livez");
    assert.equal(res.status, 200);
    const body = (await res.json()) as Record<string, unknown>;
    assert.equal(body.status, "ok");
    assert.equal(body.service, "zakura");
    assert.equal(body.version, SERVER_VERSION);
    assert.equal("endpoints" in body, false);
    assert.equal(typeof body.uptimeSec, "number");
    t.shutdown();
  });

  it("readyz is 503 until boot completes", async () => {
    resetTelemetry({ service: "zakura", version: SERVER_VERSION });
    const app = new Hono();
    mountPlatformProbes(app);
    const res = await app.request("/readyz");
    assert.equal(res.status, 503);
    const body = (await res.json()) as { status: string };
    assert.equal(body.status, "not_ready");
  });

  it("metrics is prometheus text", async () => {
    const t = resetTelemetry({ service: "zakura", version: SERVER_VERSION });
    t.recordHttp("GET", "/api/agents/secret-slug", 200, 12);
    const app = new Hono();
    mountPlatformProbes(app);
    const res = await app.request("/metrics");
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /zakura_http_requests_total/);
    assert.equal(text.includes("secret-slug"), false);
    assert.match(text, /route_class="api"/);
  });

  it("mounts probes and registers dependency checks idempotently", async () => {
    const t = resetTelemetry({ service: "zakura", version: SERVER_VERSION });
    const app = new Hono();
    mountPlatformProbes(app);
    const routeCount = app.routes.length;
    mountPlatformProbes(app);
    assert.equal(app.routes.length, routeCount);

    let dbChecks = 0;
    let dockerChecks = 0;
    const deps = {
      db: {
        execute: async () => {
          dbChecks += 1;
        },
      },
      runtime: {
        ping: async () => {
          dockerChecks += 1;
          return { ok: true, version: "fake" };
        },
      },
    };
    const previousRedis = process.env.REDIS_URL;
    process.env.REDIS_URL = "off";
    try {
      registerServerHealthChecks(deps as never);
      registerServerHealthChecks(deps as never);
      t.health.setReady(true);
      const ready = await t.health.ready();
      assert.equal(ready.status, "ready");
      assert.equal(dbChecks, 1);
      assert.equal(dockerChecks, 1);
    } finally {
      if (previousRedis === undefined) delete process.env.REDIS_URL;
      else process.env.REDIS_URL = previousRedis;
    }
  });

  it("normalizes disabled and failed dependency probes", async () => {
    assert.deepEqual(await probeRedis({ enabled: () => false }), { status: "disabled" });
    const redis = await probeRedis({
      enabled: () => true,
      getClient: async () => ({
        ping: async () => {
          throw new Error("fake redis failure");
        },
      }) as never,
    });
    assert.equal(redis.status, "down");
    assert.match(redis.message ?? "", /fake redis failure/);

    const docker = await probeDocker({
      ping: async () => {
        throw new Error("fake docker failure");
      },
    } as never);
    assert.equal(docker.status, "down");
    assert.match(docker.message ?? "", /fake docker failure/);
  });
});
