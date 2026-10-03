import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CloudAgentRuntime } from "../src/services/cloud-agent/runtime.js";

function deps(overrides: Record<string, unknown> = {}) {
  return {
    store: {},
    gateway: {},
    modelRouter: {},
    agentService: {},
    ...overrides,
  } as never;
}

describe("cloud agent execution authorization", () => {
  it("blocks interactive and automation starts for a suspended tenant before mutation", async () => {
    let sessionReads = 0;
    let sessionCreates = 0;
    const runtime = new CloudAgentRuntime(
      deps({
        db: {
          query: {
            tenants: {
              async findFirst() {
                return {
                  id: "suspended-tenant",
                  suspendedAt: new Date("2026-01-01T00:00:00Z"),
                  suspendedReason: "billing hold",
                };
              },
            },
          },
        },
        store: {
          async getSession() {
            sessionReads += 1;
            return null;
          },
          async createSession() {
            sessionCreates += 1;
            return null;
          },
        },
        agentService: {
          async get() {
            throw new Error("must not resolve agents for suspended tenants");
          },
        },
      }),
    );

    for (const action of [
      () =>
        runtime.startTurn({
          tenantId: "suspended-tenant",
          agentId: "agent",
          sessionId: "session",
          content: "hello",
        }),
      () =>
        runtime.startAutomationTurn({
          tenantId: "suspended-tenant",
          agentId: "agent",
          prompt: "scheduled work",
          title: "schedule",
          kind: "schedule",
        }),
    ]) {
      await assert.rejects(action, (error: unknown) => {
        assert.equal((error as { status?: number }).status, 403);
        assert.equal((error as { code?: string }).code, "account_suspended");
        return true;
      });
    }
    assert.equal(sessionReads, 0);
    assert.equal(sessionCreates, 0);
  });

  it("blocks platform-assistant follow-ups without an explicit admin actor", async () => {
    let enqueues = 0;
    const runtime = new CloudAgentRuntime(
      deps({
        store: {
          async getSession() {
            return { activeRunId: "run" };
          },
          async enqueueQueued() {
            enqueues += 1;
            return [];
          },
        },
        agentService: {
          async get() {
            return {
              id: "agent",
              configJson: JSON.stringify({ platformAssistant: true }),
            };
          },
        },
      }),
    );

    await assert.rejects(
      runtime.enqueueFollowUp({
        tenantId: "tenant",
        agentId: "agent",
        sessionId: "session",
        content: "change platform credentials",
      }),
      (error: unknown) => {
        assert.equal((error as { status?: number }).status, 403);
        return true;
      },
    );
    assert.equal(enqueues, 0);

    await runtime.enqueueFollowUp({
      tenantId: "tenant",
      agentId: "agent",
      sessionId: "session",
      content: "change platform credentials",
      platformAdminAuthorized: true,
    });
    assert.equal(enqueues, 1);
  });
});
