import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Hono } from "hono";
import { registerMemoryRoutes } from "../src/api/memory-routes.js";
import { registerSkillRoutes } from "../src/api/skill-routes.js";

function appWithSession(role: string) {
  const app = new Hono();
  app.use("/api/*", async (c, next) => {
    c.set("session" as never, {
      userId: "user-1", tenantId: "tenant-1", email: "user@example.test", role,
    } as never);
    await next();
  });
  return app;
}

describe("content administration route guards", () => {
  it("restricts memory provider mutations and health checks to tenant admins", async () => {
    let creates = 0;
    const memoryProviders = {
      kinds: () => [],
      create: async () => { creates++; return { id: "provider-1" }; },
      update: async () => ({ id: "provider-1" }),
      remove: async () => ({ ok: true }),
      healthCheck: async () => ({ status: "healthy" }),
    };
    const member = appWithSession("member");
    registerMemoryRoutes(member as never, {
      memoryProviders: memoryProviders as never,
      memoryStore: {} as never,
      agentService: {} as never,
    });
    const denied = await member.request("/api/memory-providers", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Local", kind: "builtin" }),
    });
    assert.equal(denied.status, 403);
    assert.equal(creates, 0);
    assert.equal((await member.request("/api/memory-providers/p/health", { method: "POST" })).status, 403);

    const admin = appWithSession("admin");
    registerMemoryRoutes(admin as never, {
      memoryProviders: memoryProviders as never,
      memoryStore: {} as never,
      agentService: {} as never,
    });
    const allowed = await admin.request("/api/memory-providers", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Local", kind: "builtin" }),
    });
    assert.equal(allowed.status, 201);
    assert.equal(creates, 1);
  });

  it("restricts tenant skill token visibility and mutations to tenant admins", async () => {
    let writes = 0;
    const skills = {
      tokenStore: {
        list: async () => [],
        set: async () => { writes++; return { scope: "tenant", provider: "gitlab" }; },
        remove: async () => undefined,
      },
    };
    const member = appWithSession("member");
    registerSkillRoutes(member as never, { skills: skills as never, agentService: {} as never, multiTenant: true });
    assert.equal((await member.request("/api/skills/tokens")).status, 403);
    const denied = await member.request("/api/skills/tokens/gitlab", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "glpat-secret", scope: "tenant" }),
    });
    assert.equal(denied.status, 403);
    assert.equal(writes, 0);

    const owner = appWithSession("owner");
    registerSkillRoutes(owner as never, { skills: skills as never, agentService: {} as never, multiTenant: true });
    const allowed = await owner.request("/api/skills/tokens/gitlab", {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "glpat-secret", scope: "tenant" }),
    });
    assert.equal(allowed.status, 200);
    assert.equal(writes, 1);
  });
});
