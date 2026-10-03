import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { PLATFORM_SERVICE_KEYS } from "@zakura/shared";
import { PlatformServiceManager } from "../src/services/platform-services.js";

async function eventually(check: () => boolean | Promise<boolean>, timeoutMs = 4_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await check())) {
    if (Date.now() >= deadline) throw new Error("condition timed out");
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("platform service durable lifecycle", () => {
  let dataDir = "";
  let db: import("../src/db/client.js").Db;
  let close: () => Promise<void>;
  let originalFetch: typeof fetch;
  const containers: Array<{ id: string; name: string; labels: Record<string, string> }> = [];
  let creates = 0;
  let failCreateAt = 0;
  let failRemovals = false;
  let healthStatus = 200;
  const runtime = {
    ping: async () => ({ ok: true, version: "fake-docker" }),
    ensureNetwork: async () => undefined,
    ensureImage: async (_image: string, onProgress?: (line: string) => void) => {
      onProgress?.("pull complete");
      await new Promise((resolve) => setTimeout(resolve, 25));
    },
    list: async () => containers.map((row) => ({ ...row, status: "running" })),
    createAndStart: async ({ spec }: { spec: { name: string; labels?: Record<string, string>; ports?: Array<{ containerPort: number; hostPort?: number }> } }) => {
      creates++;
      if (failCreateAt && creates === failCreateAt) throw new Error("fake create failure");
      const row = { id: `container-${creates}`, name: spec.name, labels: spec.labels ?? {} };
      containers.push(row);
      return {
        ...row,
        status: "running",
        ports: (spec.ports ?? []).map((port) => ({ ...port, hostPort: port.hostPort ?? 19080 })),
      };
    },
    logs: async () => "ready",
    stop: async () => undefined,
    remove: async (id: string) => {
      if (failRemovals) throw new Error("fake remove failure");
      const index = containers.findIndex((row) => row.id === id);
      if (index >= 0) containers.splice(index, 1);
    },
  };
  const config = {
    secret: "platform-service-test-secret-32bytes",
    dockerNetwork: "zakura-test",
    dataDir: "/tmp/zakura-platform-test",
    platformServiceEndpointMode: "published",
    multiTenant: false,
  } as never;

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "zakura-platform-lifecycle-"));
    const databaseUrl = `pglite:${join(dataDir, "pglite")}`;
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(databaseUrl);
    const { createDb } = await import("../src/db/client.js");
    const opened = await createDb({ databaseUrl, dataDir });
    db = opened.db;
    close = opened.close;
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response("ok", { status: healthStatus })) as typeof fetch;
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await close?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("atomically seeds one row per service across manager instances", async () => {
    const a = new PlatformServiceManager(db, runtime as never, config);
    const b = new PlatformServiceManager(db, runtime as never, config);
    await Promise.all(Array.from({ length: 8 }, (_, index) => (index % 2 ? a : b).ensureRows()));
    const { platformServices } = await import("../src/db/schema.js");
    const rows = await db.select().from(platformServices);
    assert.equal(rows.length, PLATFORM_SERVICE_KEYS.length);
    assert.equal(new Set(rows.map((row) => row.serviceKey)).size, PLATFORM_SERVICE_KEYS.length);
  });

  it("returns fresh patched state and refuses to overwrite corrupt ciphertext", async () => {
    const manager = new PlatformServiceManager(db, runtime as never, config);
    const patched = await manager.patch("searxng", {
      mode: "external",
      config: { externalUrl: "https://search.example.test/", apiKey: "secret-key" },
    });
    assert.equal(patched.mode, "external");
    assert.equal(patched.endpointUrl, "https://search.example.test");
    assert.equal(patched.config.hasApiKey, true);
    const { platformServices } = await import("../src/db/schema.js");
    const row = await db.query.platformServices.findFirst({
      where: eq(platformServices.serviceKey, "searxng"),
    });
    assert.ok(row);
    assert.equal(row.configEnc.includes("secret-key"), false);
    await db.update(platformServices).set({ configEnc: "corrupt" }).where(eq(platformServices.id, row.id));
    await assert.rejects(
      () => manager.patch("searxng", { config: { externalUrl: "https://overwrite.test" } }),
      /拒绝覆盖/,
    );
    const unchanged = await db.query.platformServices.findFirst({ where: eq(platformServices.id, row.id) });
    assert.equal(unchanged?.configEnc, "corrupt");
    // Restore a valid row for later lifecycle checks.
    await db.update(platformServices).set({ configEnc: row.configEnc }).where(eq(platformServices.id, row.id));
  });

  it("treats external HTTP 4xx as unhealthy", async () => {
    const manager = new PlatformServiceManager(db, runtime as never, config);
    await manager.patch("searxng", {
      mode: "external",
      config: { externalUrl: "https://search.example.test" },
    });
    healthStatus = 404;
    const checked = await manager.refreshHealth("searxng");
    assert.equal(checked.healthStatus, "unhealthy");
    assert.match(checked.lastError ?? "", /HTTP 404/);
    healthStatus = 200;
  });

  it("claims concurrent starts once and reconciles a stop during startup", async () => {
    const first = new PlatformServiceManager(db, runtime as never, config);
    const second = new PlatformServiceManager(db, runtime as never, config);
    await first.patch("searxng", { mode: "managed" });
    creates = 0;
    containers.splice(0);
    await Promise.all([first.startAsync("searxng"), second.startAsync("searxng")]);
    await eventually(async () => (await first.get("searxng"))?.status === "running");
    assert.equal(creates, 1);

    await first.stop("searxng");
    await eventually(async () => (await first.get("searxng"))?.status === "stopped");
    await first.startAsync("searxng");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await first.stop("searxng");
    await eventually(async () => (await first.get("searxng"))?.status === "stopped");
    assert.equal(containers.length, 0);
  });

  it("persists partial container state when startup cleanup fails", async () => {
    const manager = new PlatformServiceManager(db, runtime as never, config);
    await manager.patch("firecrawl", { mode: "managed" });
    creates = 0;
    failCreateAt = 2;
    failRemovals = true;
    containers.splice(0);
    await manager.startAsync("firecrawl");
    await eventually(async () => (await manager.get("firecrawl"))?.status === "error", 8_000);
    const { platformServices } = await import("../src/db/schema.js");
    const failed = await db.query.platformServices.findFirst({
      where: eq(platformServices.serviceKey, "firecrawl"),
    });
    assert.ok(failed);
    assert.equal((JSON.parse(failed.containersJson) as unknown[]).length, 1);
    assert.match(failed.lastError ?? "", /fake create failure/);

    failCreateAt = 0;
    failRemovals = false;
    await manager.stop("firecrawl");
    await eventually(async () => (await manager.get("firecrawl"))?.status === "stopped");
    assert.equal(containers.length, 0);
  });
});
