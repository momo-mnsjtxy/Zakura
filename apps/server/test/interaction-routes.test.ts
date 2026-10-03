import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { registerInteractionRoutes } from "../src/api/interaction-routes.js";

function appWith(resolve: (kind: "ask" | "approval", requestId: string) => Promise<void>) {
  const app = new Hono<any>();
  app.use("*", async (c, next) => { c.set("session", { tenantId: "t", userId: "u" }); await next(); });
  registerInteractionRoutes(app, {
    requireAgent: async () => ({ id: "a" }),
    askUser: { resolve: async (_t: string, _a: string, _s: string, input: any) => resolve("ask", input.requestId) } as any,
    toolApproval: { resolve: async (_t: string, _a: string, _s: string, input: any) => resolve("approval", input.requestId) } as any,
  });
  return app;
}

describe("interaction endpoint contracts", () => {
  it("preserves idempotent 200 responses for duplicate resolution", async () => {
    const terminal = new Set<string>(); const events: string[] = [];
    const app = appWith(async (kind, id) => { const key = `${kind}:${id}`; if (!terminal.has(key)) { terminal.add(key); events.push(key); } });
    for (const path of ["ask-user", "approvals"]) {
      const body = path === "ask-user" ? { requestId: "r", selected: ["yes"] } : { requestId: "r", decision: "approved" };
      for (let i = 0; i < 2; i++) {
        const response = await app.request(`/api/agents/a/sessions/s/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        assert.equal(response.status, 200);
      }
    }
    assert.deepEqual(events, ["ask:r", "approval:r"]);
  });

  it("returns 400 for unknown request IDs", async () => {
    const app = appWith(async () => { throw new Error("没有等待中的请求"); });
    const response = await app.request("/api/agents/a/sessions/s/ask-user", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: "missing" }) });
    assert.equal(response.status, 400);
  });
});
