import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Db } from "../src/db/client.js";
import { agents, newId, tenants } from "../src/db/schema.js";
import { ensureTestSpace } from "./helpers/spaces.js";
import { CloudAgentSessionStore } from "../src/services/cloud-agent-session.js";
import { CloudAgentRuntime } from "../src/services/cloud-agent/runtime.js";

describe("cloud run lifecycle CAS and recovery", () => {
  let root = "";
  let db: Db;
  let close: () => Promise<void>;
  let store: CloudAgentSessionStore;
  let tenantId = "";
  let agentId = "";

  before(async () => {
    process.env.REDIS_URL = "off";
    root = mkdtempSync(join(tmpdir(), "zakura-run-lifecycle-"));
    const databaseUrl = `pglite:${join(root, "db")}`;
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(databaseUrl);
    const created = await (await import("../src/db/client.js")).createDb({ databaseUrl, dataDir: root });
    db = created.db;
    close = created.close;
    tenantId = newId();
    agentId = newId();
    await db.insert(tenants).values({ id: tenantId, name: "Runs", slug: "runs" });
    const spaceId = await ensureTestSpace(db, tenantId);
    await db.insert(agents).values({
      id: agentId,
      tenantId,
      spaceId,
      name: "Agent",
      slug: "agent",
      description: "",
      enableMemory: false,
      configJson: "{}",
    });
    store = new CloudAgentSessionStore(db);
  });

  after(async () => {
    await close?.();
    rmSync(root, { recursive: true, force: true });
  });

  it("keeps terminal status immutable when cancellation and failure arrive late", async () => {
    const session = await store.createSession({ tenantId, agentId, title: "terminal" });
    const run = await store.createRun(session.id);
    await store.markRunStarted(run.id);
    await store.finishRun(session.id, run.id, "completed");
    assert.equal(await store.requestCancel(session.id, run.id), false);
    await store.finishRun(session.id, run.id, "failed", "late failure");
    assert.equal((await store.getRun(run.id))?.status, "completed");
    assert.equal((await store.getSession(tenantId, agentId, session.id))?.activeRunId, null);
  });

  it("claims interrupted recovery once across replicas and emits one terminal sequence", async () => {
    const session = await store.createSession({ tenantId, agentId, title: "recover" });
    const run = await store.createRun(session.id);
    await store.markRunStarted(run.id);
    const replica = new CloudAgentSessionStore(db);
    const counts = await Promise.all([store.recoverInterruptedRuns(), replica.recoverInterruptedRuns()]);
    assert.equal(counts[0]! + counts[1]!, 1);
    assert.equal((await store.getRun(run.id))?.status, "failed");
    assert.equal((await store.getSession(tenantId, agentId, session.id))?.activeRunId, null);
    const events = await store.listEvents(session.id, { limit: 100 });
    assert.equal(events.filter((event) => event.type === "run_error").length, 1);
    assert.equal(events.filter((event) => event.type === "run_end").length, 1);
  });
});

describe("cloud runtime allocation and queue recovery", () => {
  const agent = {
    id: "agent",
    tenantId: "tenant",
    spaceId: "space",
    name: "Agent",
    slug: "agent",
    description: "",
    configJson: "{}",
    enableMemory: false,
    space: { id: "space", tenantId: "tenant", slug: "space", name: "Space" },
  } as any;

  function runtime(store: Record<string, any>) {
    return new CloudAgentRuntime({
      store: store as never,
      gateway: {} as never,
      modelRouter: {} as never,
      agentService: { get: async () => agent } as never,
    });
  }

  it("releases an allocated run when durable run_start preparation fails", async () => {
    const appended: string[] = [];
    const finishes: Array<{ status: string; error?: string }> = [];
    let failedRunStart = false;
    const store = {
      getSession: async () => ({
        id: "session",
        tenantId: "tenant",
        agentId: "agent",
        title: "Existing",
        lastSeq: 0,
        activeRunId: null,
        createdByUserId: null,
      }),
      createRun: async () => ({ id: "run", sessionId: "session", status: "queued" }),
      appendEvent: async (event: { type: string }) => {
        if (event.type === "run_start" && !failedRunStart) {
          failedRunStart = true;
          throw new Error("durable run_start write failed");
        }
        appended.push(event.type);
        return { seq: appended.length, ...event };
      },
      finishRun: async (_sessionId: string, _runId: string, status: string, error?: string) => {
        finishes.push({ status, error });
      },
      updateSession: async () => undefined,
    };
    await assert.rejects(
      runtime(store).startTurn({
        tenantId: "tenant",
        agentId: "agent",
        sessionId: "session",
        content: "hello",
      }),
      /durable run_start write failed/,
    );
    assert.deepEqual(appended, ["user_message", "run_error", "run_end"]);
    assert.deepEqual(finishes, [{ status: "failed", error: "durable run_start write failed" }]);
  });

  it("restores a claimed queue item when admission fails instead of dropping it", async () => {
    const item = {
      messageId: "queued-1",
      content: "keep me",
      attachments: [],
      mode: "queue",
      createdAt: new Date().toISOString(),
    };
    const restored: unknown[] = [];
    const store = {
      getSession: async () => ({ id: "session", activeRunId: null }),
      takeQueueNext: async () => null,
      takeNextQueued: async () => item,
      requeueFront: async (_sessionId: string, value: unknown) => { restored.push(value); },
    };
    const instance = runtime(store);
    (instance as any).startTurn = async () => { throw new Error("model route unavailable"); };
    await instance.startNextQueued({ tenantId: "tenant", agentId: "agent", sessionId: "session" });
    assert.deepEqual(restored, [item]);
  });
});
