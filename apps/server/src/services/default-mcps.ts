import { and, eq } from "drizzle-orm";
import { decryptJson } from "@zakura/core";
import { DEFAULT_AGENT_AUTO_INSTALL_MCPS } from "@zakura/shared";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { agentBindings, componentInstances, newId } from "../db/schema.js";
import { normalizeMcpHttpUrl } from "../lib/mcp-http.js";
import type { Orchestrator } from "./orchestrator.js";

function normUrl(url: string): string {
  return normalizeMcpHttpUrl(url).replace(/\/$/, "").toLowerCase();
}

function matchesDefaultMcp(
  row: { endpointUrl: string | null; configEnc: string },
  targetUrl: string,
  secret: string,
): boolean {
  const endpoint = (row.endpointUrl ?? "").replace(/\/$/, "").toLowerCase();
  if (endpoint && endpoint === targetUrl) return true;
  try {
    const cfg = decryptJson<{ mcpUrl?: string }>(secret, row.configEnc);
    return Boolean(cfg.mcpUrl && normUrl(cfg.mcpUrl) === targetUrl);
  } catch {
    return false;
  }
}

const ensureFlights = new Map<string, Promise<string[]>>();

/**
 * 确保租户已安装「新建 Agent 默认绑定」的无鉴权 HTTP MCP（如 Grep）。
 * 已存在则复用并尽量保持 running；失败不抛，由调用方决定是否绑定。
 * @returns 可绑定的 instanceId 列表
 */
export async function ensureDefaultAgentMcps(
  db: Db,
  orchestrator: Orchestrator,
  appConfig: AppConfig,
  tenantId: string,
): Promise<string[]> {
  const pending = ensureFlights.get(tenantId);
  if (pending) return pending;
  const run = ensureDefaultAgentMcpsOnce(db, orchestrator, appConfig, tenantId);
  ensureFlights.set(tenantId, run);
  try {
    return await run;
  } finally {
    if (ensureFlights.get(tenantId) === run) ensureFlights.delete(tenantId);
  }
}

async function ensureDefaultAgentMcpsOnce(
  db: Db,
  orchestrator: Orchestrator,
  appConfig: AppConfig,
  tenantId: string,
): Promise<string[]> {
  const instanceIds: string[] = [];

  for (const mcp of DEFAULT_AGENT_AUTO_INSTALL_MCPS) {
    if (mcp.kind !== "http" || !mcp.mcpUrl?.trim()) continue;

    try {
      const targetUrl = normUrl(mcp.mcpUrl);
      const existing = await db
        .select()
        .from(componentInstances)
        .where(
          and(
            eq(componentInstances.tenantId, tenantId),
            eq(componentInstances.providerId, "generic-mcp"),
          ),
        );

      let row =
        existing.find((instance) =>
          matchesDefaultMcp(instance, targetUrl, appConfig.secret),
        ) ?? null;

      if (!row) {
        const slugBase = mcp.id.slice(0, 32) || `mcp-${Date.now().toString(36)}`;
        let slug = slugBase;
        for (let n = 0; n < 20; n++) {
          const candidate = n === 0 ? slugBase : `${slugBase.slice(0, 28)}-${n + 1}`;
          const clash = await db.query.componentInstances.findFirst({
            where: and(
              eq(componentInstances.tenantId, tenantId),
              eq(componentInstances.slug, candidate),
            ),
          });
          if (!clash) {
            slug = candidate;
            break;
          }
        }

        try {
          row = await orchestrator.createInstance({
            tenantId,
            providerId: "generic-mcp",
            name: mcp.name,
            slug,
            config: {
              mcpUrl: normalizeMcpHttpUrl(mcp.mcpUrl),
              apiKey: "",
              headerName: "Authorization",
            },
          });
        } catch (createError) {
          // Another replica may have won the unique tenant+slug insert. Read
          // the durable winner rather than returning an empty/default binding.
          const raced = await db.query.componentInstances.findFirst({
            where: and(
              eq(componentInstances.tenantId, tenantId),
              eq(componentInstances.slug, slug),
            ),
          });
          if (!raced || !matchesDefaultMcp(raced, targetUrl, appConfig.secret)) {
            throw createError;
          }
          row = raced;
        }
      }

      if (row.status !== "running") {
        try {
          await orchestrator.startInstance(tenantId, row.id);
        } catch (err) {
          console.warn(
            `[default-mcps] start ${mcp.id} failed:`,
            err instanceof Error ? err.message : err,
          );
        }
      }

      instanceIds.push(row.id);
    } catch (err) {
      console.warn(
        `[default-mcps] ensure ${mcp.id} failed:`,
        err instanceof Error ? err.message : err,
      );
    }
  }

  return instanceIds;
}

/** 将默认 MCP 绑定到 Space（幂等）；agentId 仅用于保留来源归属 */
export async function bindDefaultMcpsToAgent(
  db: Db,
  tenantId: string,
  spaceId: string,
  instanceIds: string[],
  agentId?: string,
): Promise<void> {
  await bindDefaultMcpsToAgentDetailed(db, tenantId, spaceId, instanceIds, agentId);
}

export async function bindDefaultMcpsToAgentDetailed(
  db: Db,
  tenantId: string,
  spaceId: string,
  instanceIds: string[],
  agentId?: string,
): Promise<{ bound: string[]; failed: Array<{ instanceId: string; error: string }> }> {
  const now = new Date();
  const bound: string[] = [];
  const failed: Array<{ instanceId: string; error: string }> = [];
  for (const instanceId of [...new Set(instanceIds)]) {
    try {
      await db
        .insert(agentBindings)
        .values({
          id: newId(),
          tenantId,
          spaceId,
          agentId: agentId ?? null,
          instanceId,
          createdAt: now,
        })
        .onConflictDoNothing();
      bound.push(instanceId);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      failed.push({ instanceId, error: message });
      console.warn(
        `[default-mcps] bind ${instanceId} -> space ${spaceId} failed:`,
        message,
      );
    }
  }
  return { bound, failed };
}
