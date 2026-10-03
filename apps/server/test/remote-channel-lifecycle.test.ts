import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RemoteChannelRuntime } from "../src/services/remote-channel-runtime.js";

describe("remote channel binding lifecycle", () => {
  it("coalesces concurrent starts, waits on invalidate, and permits retry after failure", async () => {
    const binding = {
      id: "binding-1",
      tenantId: "tenant-1",
      agentId: "agent-1",
      platform: "slack",
      profileKey: "remote-slack",
      enabled: true,
    };
    const ingress = {
      getBinding: async () => binding,
      listBindings: async () => [binding],
      isTenantAvailable: async () => true,
    };
    const runtime = new RemoteChannelRuntime(
      { databaseUrl: "pglite:test", publicBaseUrl: "http://localhost" } as never,
      {} as never,
      ingress as never,
      {} as never,
    );
    let starts = 0;
    let shutdowns = 0;
    const fakeBot = { shutdown: async () => { shutdowns++; } };
    (runtime as unknown as { createBot: () => Promise<unknown>; bots: Map<string, unknown> })
      .createBot = async () => {
        starts++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        (runtime as unknown as { bots: Map<string, unknown> }).bots.set(binding.id, fakeBot);
        return fakeBot;
      };

    await Promise.all(Array.from({ length: 12 }, () => runtime.startBinding("tenant-1", binding.id)));
    assert.equal(starts, 1);
    await runtime.invalidate(binding.id);
    assert.equal(shutdowns, 1);

    let first = true;
    (runtime as unknown as { createBot: () => Promise<unknown> }).createBot = async () => {
      starts++;
      if (first) {
        first = false;
        throw new Error("temporary adapter failure");
      }
      (runtime as unknown as { bots: Map<string, unknown> }).bots.set(binding.id, fakeBot);
      return fakeBot;
    };
    await assert.rejects(runtime.startBinding("tenant-1", binding.id), /temporary adapter failure/);
    await runtime.startBinding("tenant-1", binding.id);
    assert.equal(starts, 3);
    await runtime.stop();
    assert.equal(shutdowns, 2);
  });

  it("rejects suspended tenant webhooks and tears down all tenant state idempotently", async () => {
    const binding = {
      id: "binding-suspended", tenantId: "tenant-suspended", agentId: "agent-1",
      platform: "slack", profileKey: "remote-slack", enabled: true,
    };
    let available = true;
    let shutdowns = 0;
    const ingress = {
      getBinding: async () => binding,
      listBindings: async () => [binding],
      isTenantAvailable: async () => available,
    };
    const runtime = new RemoteChannelRuntime(
      { databaseUrl: "pglite:test", publicBaseUrl: "http://localhost" } as never,
      {} as never, ingress as never, {} as never,
    );
    const fakeBot = {
      shutdown: async () => { shutdowns++; },
      webhooks: { slack: async () => new Response("ok") },
    };
    (runtime as unknown as { createBot: () => Promise<unknown>; bots: Map<string, unknown> }).createBot = async () => {
      (runtime as unknown as { bots: Map<string, unknown> }).bots.set(binding.id, fakeBot);
      return fakeBot;
    };
    await runtime.startBinding(binding.tenantId, binding.id);
    runtime.sessions.bind("session-1", {
      chat: {} as never, threadId: "thread", channelId: "channel",
      platform: "slack", bindingId: binding.id,
    });

    available = false;
    const response = await runtime.handleWebhook(
      binding.tenantId, binding.id, new Request("http://localhost/webhook", { method: "POST" }),
    );
    assert.equal(response.status, 403);
    assert.equal(shutdowns, 1);
    assert.equal(runtime.sessions.get("session-1"), undefined);
    await runtime.lifecycleHook().afterSuspend(binding.tenantId);
    await runtime.lifecycleHook().afterMemberRemoved(binding.tenantId, "user-1");
    assert.equal(shutdowns, 1, "repeat lifecycle notifications remain idempotent");
    await assert.rejects(runtime.startBinding(binding.tenantId, binding.id), /团队不可用/);
  });
});
