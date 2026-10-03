import assert from "node:assert/strict";
import { before, describe, it } from "node:test";
import { globalRegistry } from "@zakura/core";
import {
  ZakuraTaskStore,
  parseProxyTaskId,
} from "../src/services/mcp-task-store.js";

const PROVIDER_ID = "task-store-lifecycle-test";

describe("MCP proxy task lifecycle and isolation", () => {
  const rpc: Array<{ tenantId: string; method: string; taskId: string }> = [];

  before(() => {
    if (globalRegistry.has(PROVIDER_ID)) return;
    globalRegistry.register(() => ({
      id: PROVIDER_ID,
      name: "Task Store Test",
      description: "",
      version: "1",
      category: "mcp",
      capabilities: ["tools"],
      configSchema: { type: "object", properties: {} },
      createRuntimeSpec: () => ({ containers: [], endpointTemplate: "http://test" }),
      healthCheck: async () => ({ status: "healthy", message: "ok" }),
      listTools: async () => [],
      callTool: async () => ({ content: [] }),
      invokeRaw: async (handle: { tenantId: string }, method: string, params?: unknown) => {
        const taskId = String((params as { taskId?: unknown } | undefined)?.taskId ?? "");
        rpc.push({ tenantId: handle.tenantId, method, taskId });
        if (method === "tasks/result") {
          return { content: [{ type: "text", text: `${handle.tenantId}:${taskId}` }] };
        }
        return {
          taskId,
          status: "working",
          ttl: 60_000,
          createdAt: "2026-01-01T00:00:00.000Z",
          lastUpdatedAt: "2026-01-01T00:00:01.000Z",
        };
      },
    }) as never);
  });

  function harness(opts: { now?: () => number; maxProxyTasks?: number } = {}) {
    let nonce = 0;
    const orchestrator = {
      toHandle: async (tenantId: string, instanceId: string) => ({
        id: instanceId,
        tenantId,
        name: instanceId,
        slug: instanceId,
        providerId: PROVIDER_ID,
        status: "running",
        config: {},
        containers: [],
      }),
    };
    return new ZakuraTaskStore(orchestrator as never, {
      ...opts,
      nonce: () => `nonce-${++nonce}`,
    });
  }

  function register(
    store: ZakuraTaskStore,
    tenantId: string,
    sessionId?: string,
    ttl: number | null = 60_000,
  ) {
    return store.registerProxyTask({
      tenantId,
      instanceId: `instance-${tenantId}`,
      providerId: PROVIDER_ID,
      slug: "same-slug",
      sessionId,
      upstream: {
        taskId: "same-upstream-id",
        status: "working",
        ttl,
        createdAt: "2026-01-01T00:00:00.000Z",
        lastUpdatedAt: "2026-01-01T00:00:01.000Z",
      },
    });
  }

  it("uses opaque collision-safe ids and enforces session-owned enumeration", async () => {
    rpc.length = 0;
    const store = harness();
    const first = register(store, "tenant-a", "session-a");
    const second = register(store, "tenant-b", "session-b");
    const repeated = register(store, "tenant-a", "session-a");
    assert.notEqual(first.taskId, second.taskId);
    assert.equal(repeated.taskId, first.taskId);
    assert.equal(first.taskId.includes("tenant-a"), false);
    assert.equal(first.taskId.includes("same-upstream-id"), false);
    assert.equal(parseProxyTaskId(first.taskId)?.localTaskId, "task");

    assert.equal(await store.getTask(first.taskId, "session-b"), null);
    assert.equal(rpc.length, 0);
    const visible = await store.getTask(first.taskId, "session-a");
    assert.equal(visible?.taskId, first.taskId);
    assert.deepEqual(rpc, [
      { tenantId: "tenant-a", method: "tasks/get", taskId: "same-upstream-id" },
    ]);
    assert.deepEqual(
      (await store.listTasks(undefined, "session-a")).tasks.map((task) => task.taskId),
      [first.taskId],
    );
    assert.deepEqual((await store.listTasks()).tasks, []);
  });

  it("prunes expired and over-capacity proxy state", async () => {
    let now = 1_000;
    const store = harness({ now: () => now, maxProxyTasks: 2 });
    const expired = register(store, "tenant-expired", undefined, 50);
    now = 1_051;
    assert.equal(await store.getTask(expired.taskId), null);

    const first = register(store, "tenant-1", undefined, null);
    now += 1;
    const second = register(store, "tenant-2", undefined, null);
    now += 1;
    const third = register(store, "tenant-3", undefined, null);
    assert.equal(await store.getTask(first.taskId), null);
    assert.ok(await store.getTask(second.taskId));
    assert.ok(await store.getTask(third.taskId));
  });

  it("rejects a superseded hosted input waiter", async () => {
    const store = harness();
    const task = await store.createTask(
      { ttl: 60_000, pollInterval: 100 },
      1,
      { method: "tools/call", params: { name: "demo" } } as never,
      "host-session",
    );
    const first = store.requestHostedInput(task.taskId, {
      first: { type: "elicitation", mode: "form", message: "first", requestedSchema: {} },
    });
    const second = store.requestHostedInput(task.taskId, {
      second: { type: "elicitation", mode: "form", message: "second", requestedSchema: {} },
    });
    await assert.rejects(() => first, /superseded/);
    await new Promise((resolve) => setImmediate(resolve));
    await store.applyTaskUpdate(task.taskId, { second: true });
    assert.deepEqual(await second, { second: true });
  });

  it("cleans tenant-owned and full proxy state", async () => {
    const store = harness();
    const first = register(store, "tenant-a", "session-a");
    const second = register(store, "tenant-b", "session-b");
    assert.equal(store.cleanupTenant("tenant-a"), 1);
    assert.equal(await store.getTask(first.taskId, "session-a"), null);
    assert.ok(await store.getTask(second.taskId, "session-b"));
    store.cleanup();
    assert.equal(await store.getTask(second.taskId, "session-b"), null);
  });
});
