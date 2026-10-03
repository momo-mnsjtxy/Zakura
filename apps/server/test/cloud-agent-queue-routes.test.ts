import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import type { CloudAgentQueuedMessage } from "@zakura/shared";
import { registerCloudAgentRoutes } from "../src/api/cloud-agent-routes.js";
import type { AgentService } from "../src/services/agents.js";
import type { CloudAgentSessionStore } from "../src/services/cloud-agent-session.js";

type RuntimeCall = Record<string, unknown>;

function queued(messageId: string, content = "queued"): CloudAgentQueuedMessage {
  return {
    messageId,
    content,
    attachments: [],
    mode: "queue",
    createdAt: "2026-01-01T00:00:00.000Z",
  };
}

function harness(options: {
  activeRunId?: string | null;
  pending?: CloudAgentQueuedMessage[];
  startError?: Error;
} = {}) {
  const calls = {
    start: [] as RuntimeCall[],
    enqueue: [] as RuntimeCall[],
    interrupt: [] as RuntimeCall[],
    update: [] as RuntimeCall[],
    remove: [] as RuntimeCall[],
  };
  let pending = [...(options.pending ?? [])];
  const session = {
    id: "session",
    agentId: "agent",
    tenantId: "tenant",
    kind: "chat",
    activeRunId: options.activeRunId ?? null,
    originJson: "{}",
  };
  const store = {
    async getSession(tenantId: string, agentId: string, sessionId: string) {
      return tenantId === "tenant" && agentId === "agent" && sessionId === "session"
        ? session
        : null;
    },
    async listQueued() {
      return [...pending];
    },
    async updateQueued(_sessionId: string, messageId: string, patch: { content?: string }) {
      calls.update.push({ messageId, patch });
      const item = pending.find((candidate) => candidate.messageId === messageId);
      if (!item) return null;
      item.content = patch.content ?? item.content;
      return { ...item };
    },
    async removeQueued(_sessionId: string, messageId: string) {
      calls.remove.push({ messageId });
      const item = pending.find((candidate) => candidate.messageId === messageId) ?? null;
      pending = pending.filter((candidate) => candidate.messageId !== messageId);
      return item;
    },
  };
  const runtime = {
    async startTurn(input: RuntimeCall) {
      calls.start.push(input);
      if (options.startError) throw options.startError;
      return { sessionId: "session", runId: "run-new" };
    },
    async enqueueFollowUp(input: RuntimeCall) {
      calls.enqueue.push(input);
      return { messageId: "message-new", mode: input.mode };
    },
    async interruptWithQueued(input: RuntimeCall) {
      calls.interrupt.push(input);
      return { ok: true, runId: "run-active", messageId: input.messageId };
    },
    async startNextQueued() {},
  };
  const app = new Hono<any>();
  app.use("*", async (context, next) => {
    context.set("session", {
      tenantId: "tenant",
      userId: "user",
      email: "owner@example.test",
      role: "owner",
    });
    await next();
  });
  registerCloudAgentRoutes(app, {
    agentService: {
      async get() {
        return { id: "agent", configJson: "{}" };
      },
    } as unknown as AgentService,
    store: store as unknown as CloudAgentSessionStore,
    runtime,
    modelRouter: {} as never,
  });

  const request = (path: string, method: string, body?: unknown) =>
    app.request(path, {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
  return { app, calls, request };
}

describe("cloud agent queue routes", () => {
  it("starts an idle session and preserves sender, attachments and run options", async () => {
    const { calls, request } = harness();
    const response = await request(
      "/api/agents/agent/cloud/sessions/session/messages",
      "POST",
      {
        content: "hello",
        attachments: [{ type: "image", url: "data:image/png;base64,AA==" }],
        options: {
          reasoning: { enabled: true, effort: "high" },
          skills: [" one ", "one", "two"],
          disabledTools: ["shell"],
        },
      },
    );

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { sessionId: "session", runId: "run-new" });
    assert.equal(calls.start.length, 1);
    assert.equal(calls.enqueue.length, 0);
    assert.deepEqual(calls.start[0], {
      tenantId: "tenant",
      agentId: "agent",
      sessionId: "session",
      content: "hello",
      attachments: [{ type: "image", url: "data:image/png;base64,AA==" }],
      options: {
        reasoning: { enabled: true, effort: "high" },
        skills: ["one", "two"],
        disabledTools: ["shell"],
      },
      userId: "user",
      userName: "owner@example.test",
      platformAdminAuthorized: false,
    });
  });

  it("enqueues during an active run and returns the stable 202 queue contract", async () => {
    const { calls, request } = harness({ activeRunId: "run-active" });
    const response = await request(
      "/api/agents/agent/cloud/sessions/session/messages",
      "POST",
      { content: "follow up", followUp: "queue" },
    );

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      queued: true,
      messageId: "message-new",
      mode: "queue",
    });
    assert.equal(calls.start.length, 0);
    assert.deepEqual(calls.enqueue[0], {
      tenantId: "tenant",
      agentId: "agent",
      sessionId: "session",
      content: "follow up",
      mode: "queue",
      userId: "user",
      userName: "owner@example.test",
      platformAdminAuthorized: false,
    });
  });

  it("falls back to enqueue when an idle start loses the active-run race", async () => {
    const { calls, request } = harness({
      startError: new Error("当前会话已有进行中的 Run，请先等待或取消"),
    });
    const response = await request(
      "/api/agents/agent/cloud/sessions/session/messages",
      "POST",
      { content: "raced", followUp: "steer" },
    );

    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), {
      queued: true,
      messageId: "message-new",
      mode: "steer",
    });
    assert.equal(calls.start.length, 1);
    assert.equal(calls.enqueue.length, 1);
  });

  it("keeps edit, remove and interrupt status/body contracts", async () => {
    const { calls, request } = harness({ pending: [queued("m1")] });
    const edit = await request(
      "/api/agents/agent/cloud/sessions/session/queue/m1",
      "PATCH",
      { content: "edited" },
    );
    assert.equal(edit.status, 200);
    assert.deepEqual(await edit.json(), { ok: true, item: queued("m1", "edited") });

    const interrupt = await request(
      "/api/agents/agent/cloud/sessions/session/queue/m1/interrupt",
      "POST",
    );
    assert.equal(interrupt.status, 200);
    assert.deepEqual(await interrupt.json(), {
      ok: true,
      runId: "run-active",
      messageId: "m1",
    });
    assert.deepEqual(calls.interrupt[0], {
      tenantId: "tenant",
      agentId: "agent",
      sessionId: "session",
      messageId: "m1",
    });

    const remove = await request(
      "/api/agents/agent/cloud/sessions/session/queue/m1",
      "DELETE",
    );
    assert.equal(remove.status, 200);
    assert.deepEqual(await remove.json(), {
      ok: true,
      removed: true,
      item: queued("m1", "edited"),
    });
    const missing = await request(
      "/api/agents/agent/cloud/sessions/session/queue/m1",
      "PATCH",
      { content: "again" },
    );
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: "排队消息不存在（可能已发出）" });
  });
});
