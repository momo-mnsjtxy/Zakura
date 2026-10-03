import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { createDb, type Db } from "../src/db/client.js";
import { runMigrations } from "../src/db/migrate.js";
import { agents, agentToolApprovals, agentUserQuestions, spaces, tenants } from "../src/db/schema.js";
import { AskUserService } from "../src/services/ask-user.js";
import { ToolApprovalService } from "../src/services/tool-approval.js";
import { registerInteractionRoutes } from "../src/api/interaction-routes.js";

describe("interaction DB races", () => {
  let dir: string; let db: Db; let close: () => Promise<void>;
  const events: Array<{ type: string; payload: any }> = [];
  const store = { appendEvent: async (event: any) => { events.push(event); }, onRunCancel: () => () => {} } as any;
  let ask: AskUserService; let approval: ToolApprovalService;
  before(async () => {
    process.env.REDIS_URL = "off";
    dir = mkdtempSync(join(tmpdir(), "zakura-interactions-"));
    const url = `pglite:${join(dir, "db")}`; await runMigrations(url);
    const handle = await createDb({ databaseUrl: url, dataDir: dir }); db = handle.db; close = handle.close;
    await db.insert(tenants).values({ id: "t", name: "T", slug: "t" });
    await db.insert(spaces).values({ id: "s", tenantId: "t", name: "S", slug: "s" });
    await db.insert(agents).values({ id: "a", tenantId: "t", spaceId: "s", name: "A", slug: "a" });
    ask = new AskUserService(db, store); approval = new ToolApprovalService(db, store, null);
  });
  after(async () => { await close(); rmSync(dir, { recursive: true, force: true }); });

  it("resolve versus timeout/cancel emits one terminal event and duplicate POST stays 200", async () => {
    await db.insert(agentUserQuestions).values({ id: "q", tenantId: "t", agentId: "a", sessionId: "sid", runId: "run-q", question: "?", optionsJson: '[{"id":"yes","label":"Yes"}]', expiresAt: new Date(Date.now() - 100) });
    await Promise.allSettled([
      ask.resolve("t", "a", "sid", { requestId: "q", selected: ["yes"] }),
      ask.tick(),
    ]);
    assert.equal(events.filter((e) => e.type === "ask_user_resolved" && e.payload.requestId === "q").length, 1);

    await db.insert(agentToolApprovals).values({ id: "p", tenantId: "t", agentId: "a", sessionId: "sid", runId: "run-p", toolName: "shell", qualifiedName: "workspace:shell" });
    await Promise.allSettled([
      approval.resolve("t", "a", "sid", { requestId: "p", decision: "approved" }),
      approval.cancelRun("run-p"),
    ]);
    assert.equal(events.filter((e) => e.type === "tool_approval_resolved" && e.payload.requestId === "p").length, 1);

    const app = new Hono<any>();
    app.use("*", async (c, next) => { c.set("session", { tenantId: "t", userId: "u" }); await next(); });
    registerInteractionRoutes(app, { askUser: ask, toolApproval: approval, requireAgent: async () => ({ id: "a" }) });
    for (const [path, body] of [["ask-user", { requestId: "q", selected: ["yes"] }], ["approvals", { requestId: "p", decision: "approved" }]] as const) {
      const response = await app.request(`/api/agents/a/sessions/sid/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      assert.equal(response.status, 200);
    }
    assert.equal(events.filter((e) => e.payload?.requestId === "q" || e.payload?.requestId === "p").length, 2);
  });

  it("unknown IDs remain errors", async () => {
    await assert.rejects(ask.resolve("t", "a", "sid", { requestId: "missing" }), /没有等待中的询问/);
    await assert.rejects(approval.resolve("t", "a", "sid", { requestId: "missing", decision: "denied" }), /没有等待中的审批/);
  });
});
