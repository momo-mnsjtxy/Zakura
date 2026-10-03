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

  it("retries Telegram webhook refresh and persists one generated secret", async () => {
    const binding = {
      id: "binding-telegram", tenantId: "tenant-telegram", agentId: "agent-telegram",
      platform: "telegram", profileKey: "remote-telegram", enabled: true,
    };
    let persisted: Record<string, unknown> | null = null;
    const ingress = {
      getBinding: async () => binding,
      getBindingCredentials: () => ({
        enabled: true, values: { botToken: "fake-bot-token", mode: "webhook" },
        configuredFields: ["botToken"],
      }),
      mergeBindingCredentials: async (_tenantId: string, _bindingId: string, patch: Record<string, unknown>) => {
        persisted = patch;
      },
      isTenantAvailable: async () => true,
      listBindings: async () => [binding],
    };
    const runtime = new RemoteChannelRuntime(
      { databaseUrl: "pglite:test", publicBaseUrl: "https://zakura.example.test" } as never,
      {} as never, ingress as never, {} as never,
    );
    const originalFetch = globalThis.fetch;
    let calls = 0;
    let lastBody = "";
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls++;
      lastBody = String(init?.body ?? "");
      if (calls < 3) return Response.json({ ok: false, description: "temporary" }, { status: 503 });
      return Response.json({ ok: true });
    }) as typeof fetch;
    try {
      await (runtime as unknown as {
        tryRegisterTelegramWebhook: (tenantId: string, row: typeof binding) => Promise<void>;
      }).tryRegisterTelegramWebhook(binding.tenantId, binding);
      assert.equal(calls, 3);
      assert.equal(typeof persisted?.secretToken, "string");
      const body = JSON.parse(lastBody) as { url: string; secret_token: string };
      assert.equal(body.secret_token, persisted?.secretToken);
      assert.equal(body.url, `https://zakura.example.test/api/remote-channels/${binding.tenantId}/${binding.id}/webhook`);
    } finally {
      globalThis.fetch = originalFetch;
      await runtime.stop();
    }
  });
});
