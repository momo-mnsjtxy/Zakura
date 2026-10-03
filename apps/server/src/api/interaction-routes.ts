import type { Hono } from "hono";
import type { AppVariables } from "./routes.js";
import type { AskUserService } from "../services/ask-user.js";
import type { ToolApprovalService } from "../services/tool-approval.js";

export function registerInteractionRoutes(
  app: Hono<{ Variables: AppVariables }>,
  deps: {
    askUser?: AskUserService | null;
    toolApproval?: ToolApprovalService | null;
    requireAgent: (tenantId: string, agentId: string) => Promise<{ id: string } | null>;
  },
): void {
  app.post("/api/agents/:id/sessions/:sid/ask-user", async (c) => {
    if (!deps.askUser) return c.json({ error: "询问用户未启用" }, 400);
    const session = c.get("session")!;
    const agent = await deps.requireAgent(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const body = await c.req.json<{ requestId?: string; cancelled?: boolean; selected?: unknown; text?: string }>().catch(() => ({} as { requestId?: string; cancelled?: boolean; selected?: unknown; text?: string }));
    const requestId = String(body.requestId ?? "").trim();
    if (!requestId) return c.json({ error: "requestId required" }, 400);
    try {
      await deps.askUser.resolve(session.tenantId, agent.id, c.req.param("sid"), {
        requestId, cancelled: body.cancelled === true, selected: body.selected,
        text: typeof body.text === "string" ? body.text : undefined,
      });
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });

  app.post("/api/agents/:id/sessions/:sid/approvals", async (c) => {
    if (!deps.toolApproval) return c.json({ error: "工具审批未启用" }, 400);
    const session = c.get("session")!;
    const agent = await deps.requireAgent(session.tenantId, c.req.param("id"));
    if (!agent) return c.json({ error: "Agent not found" }, 404);
    const body = await c.req.json<{ requestId?: string; decision?: string; alwaysAllow?: boolean; cancelled?: boolean }>().catch(() => ({} as { requestId?: string; decision?: string; alwaysAllow?: boolean; cancelled?: boolean }));
    const requestId = String(body.requestId ?? "").trim();
    if (!requestId) return c.json({ error: "requestId required" }, 400);
    const decision = body.cancelled === true ? "denied" : body.decision;
    if (decision !== "approved" && decision !== "denied") return c.json({ error: "decision must be approved or denied" }, 400);
    try {
      await deps.toolApproval.resolve(session.tenantId, agent.id, c.req.param("sid"), {
        requestId, decision, alwaysAllow: body.alwaysAllow === true, cancelled: body.cancelled === true,
      });
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
  });
}
