import { and, eq, isNull } from "drizzle-orm";
import type { Db } from "../db/client.js";
import {
  agents,
  componentInstances,
  newId,
  settings,
  tenantMemberships,
  tenants,
} from "../db/schema.js";
import { PLATFORM_SERVICE_CATALOG } from "../platform-services/catalog.js";
import type { PlatformServiceKey } from "@zakura/shared";
import { ensureCapabilityInstance } from "./capabilities.js";
import type { Orchestrator } from "./orchestrator.js";
import { parseAgentConfig, type AgentConfigBag } from "./agent-providers.js";

export const AGENT_DEFAULTS_KEY = "agents.web-defaults";

export type AgentWebDefaults = {
  webSearchEnabled: boolean;
  webFetchEnabled: boolean;
  searchEngine: string | null;
  fetchBackend: string | null;
  /** Platform-hosted defaults (at most one search-engine + one fetch-backend). Shown as「Zakura 自动」. */
  autoManagedServices: string[];
};

export const DEFAULT_AGENT_WEB_DEFAULTS: AgentWebDefaults = {
  webSearchEnabled: true,
  webFetchEnabled: true,
  searchEngine: null,
  fetchBackend: null,
  autoManagedServices: [],
};

/** Keep at most one platform service per product kind (search / fetch). */
function normalizeAutoManaged(keys: string[]): string[] {
  let searchKey: string | undefined;
  let fetchKey: string | undefined;
  for (const key of keys) {
    const def = PLATFORM_SERVICE_CATALOG[key as PlatformServiceKey];
    if (!def) continue;
    if (def.mapsTo.kind === "search-engine" && !searchKey) searchKey = key;
    if (def.mapsTo.kind === "fetch-backend" && !fetchKey) fetchKey = key;
  }
  return [searchKey, fetchKey].filter((v): v is string => Boolean(v));
}

function normalize(value: unknown): AgentWebDefaults {
  const raw =
    value && typeof value === "object"
      ? (value as Record<string, unknown>)
      : {};
  const rawAuto = Array.isArray(raw.autoManagedServices)
    ? raw.autoManagedServices.filter(
        (v): v is string => typeof v === "string" && v.length > 0,
      )
    : [];
  return {
    webSearchEnabled: raw.webSearchEnabled !== false,
    webFetchEnabled: raw.webFetchEnabled !== false,
    searchEngine:
      typeof raw.searchEngine === "string" && raw.searchEngine
        ? raw.searchEngine
        : null,
    fetchBackend:
      typeof raw.fetchBackend === "string" && raw.fetchBackend
        ? raw.fetchBackend
        : null,
    autoManagedServices: normalizeAutoManaged(rawAuto),
  };
}

export async function getAgentWebDefaults(db: Db): Promise<AgentWebDefaults> {
  const row = await db.query.settings.findFirst({
    where: and(
      eq(settings.ownerKey, "platform"),
      eq(settings.key, AGENT_DEFAULTS_KEY),
    ),
  });
  if (!row) return { ...DEFAULT_AGENT_WEB_DEFAULTS, autoManagedServices: [] };
  try {
    return normalize(JSON.parse(row.value));
  } catch {
    return { ...DEFAULT_AGENT_WEB_DEFAULTS, autoManagedServices: [] };
  }
}

export async function saveAgentWebDefaults(
  db: Db,
  value: Partial<AgentWebDefaults>,
) {
  return db.transaction(async (tx) => {
    // Seed first so concurrent partial saves have a row to lock even on a fresh
    // deployment. The unique upsert serializes concurrent seed attempts.
    await tx
      .insert(settings)
      .values({
        id: newId(),
        ownerKey: "platform",
        key: AGENT_DEFAULTS_KEY,
        value: JSON.stringify(DEFAULT_AGENT_WEB_DEFAULTS),
      })
      .onConflictDoNothing({ target: [settings.ownerKey, settings.key] });

    const [current] = await tx
      .select()
      .from(settings)
      .where(
        and(
          eq(settings.ownerKey, "platform"),
          eq(settings.key, AGENT_DEFAULTS_KEY),
        ),
      )
      .for("update");
    const base = (() => {
      try {
        return normalize(JSON.parse(current?.value ?? "{}"));
      } catch {
        return { ...DEFAULT_AGENT_WEB_DEFAULTS, autoManagedServices: [] };
      }
    })();
    const normalized = normalize({ ...base, ...value });
    const serialized = JSON.stringify(normalized);
    if (current?.value !== serialized) {
      await tx
        .update(settings)
        .set({ value: serialized })
        .where(
          and(
            eq(settings.ownerKey, "platform"),
            eq(settings.key, AGENT_DEFAULTS_KEY),
          ),
        );
    }
    return normalized;
  });
}

/** Undefined agent values inherit platform defaults; explicit false/values remain overrides. */
export function effectiveAgentWebDefaults(
  config: AgentConfigBag,
  platform: AgentWebDefaults,
) {
  return {
    webSearchEnabled:
      config.providers?.webSearch?.enabled ?? platform.webSearchEnabled,
    webFetchEnabled:
      config.providers?.webFetch?.enabled ?? platform.webFetchEnabled,
    searchEngine:
      config.providers?.webSearch?.defaultEngine ?? platform.searchEngine,
    fetchBackend:
      config.providers?.webFetch?.defaultBackend ?? platform.fetchBackend,
  };
}

export async function enableWebForUserAgents(
  db: Db,
  orchestrator: Orchestrator,
  userId: string,
  options: EnableWebForUserAgentsOptions = {},
) {
  const memberships = await db
    .select({ tenantId: tenantMemberships.tenantId })
    .from(tenantMemberships)
    .innerJoin(tenants, eq(tenantMemberships.tenantId, tenants.id))
    .where(
      and(
        eq(tenantMemberships.userId, userId),
        eq(tenantMemberships.status, "active"),
        isNull(tenants.suspendedAt),
      ),
    )
    .orderBy(tenantMemberships.tenantId);
  let updated = 0;
  for (const membership of memberships) {
    // Capability rows must exist before Agents advertise the tools. A failed
    // provider admission therefore leaves every Agent untouched.
    await ensureCapabilityWithDuplicateRecovery(
      db,
      orchestrator,
      membership.tenantId,
      "web-search",
    );
    await ensureCapabilityWithDuplicateRecovery(
      db,
      orchestrator,
      membership.tenantId,
      "web-fetch",
    );

    updated += await db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(agents)
        .where(eq(agents.tenantId, membership.tenantId))
        .for("update");
      let changed = 0;
      for (const agent of rows) {
        const bag = parseAgentConfig(agent);
        const providers = {
          ...bag.providers,
          webSearch: { ...bag.providers?.webSearch, enabled: true },
          webFetch: { ...bag.providers?.webFetch, enabled: true },
        };
        const configJson = JSON.stringify({ ...bag, providers });
        if (configJson === agent.configJson) continue;
        await options.beforeAgentWrite?.(membership.tenantId, agent.id);
        await tx
          .update(agents)
          .set({ configJson, updatedAt: new Date() })
          .where(
            and(
              eq(agents.id, agent.id),
              eq(agents.tenantId, membership.tenantId),
            ),
          );
        changed += 1;
      }
      return changed;
    });
  }
  return { updated, tenants: memberships.length };
}

export type EnableWebForUserAgentsOptions = {
  /** Test seam for deterministic transaction rollback checks. */
  beforeAgentWrite?: (
    tenantId: string,
    agentId: string,
  ) => void | Promise<void>;
};

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; cause?: unknown };
  if (value.code === "23505") return true;
  return value.cause !== error && isUniqueViolation(value.cause);
}

async function ensureCapabilityWithDuplicateRecovery(
  db: Db,
  orchestrator: Orchestrator,
  tenantId: string,
  kind: "web-search" | "web-fetch",
): Promise<void> {
  try {
    await ensureCapabilityInstance(db, orchestrator, tenantId, kind, {
      start: true,
    });
    return;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }

  // Another replica inserted the tenant/slug winner. Read it back and complete
  // the same start semantics instead of failing the whole bulk mutation.
  const existing = await db.query.componentInstances.findFirst({
    where: and(
      eq(componentInstances.tenantId, tenantId),
      eq(componentInstances.providerId, kind),
      eq(componentInstances.slug, kind),
    ),
  });
  if (!existing)
    throw new Error(`Capability ${kind} disappeared after concurrent creation`);
  if (existing.status !== "running") {
    try {
      await orchestrator.startInstance(tenantId, existing.id);
    } catch {
      // Match ensureCapabilityInstance: retain the configured row and let its
      // lifecycle status expose a start failure to operators.
    }
  }
}
