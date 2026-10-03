/**
 * Move settings and workspaces formerly owned by each Agent onto its Space.
 * Both migrations are restart-safe and preserve legacy workspace directories.
 */
import { desc, eq } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import type { AppConfig } from "../config.js";
import type { Db } from "../db/client.js";
import { agents, spaces } from "../db/schema.js";
import {
  parseConfigJson,
  pickSpaceAcp,
  pickSpaceMcp,
  stripSpaceOwnedKeys,
} from "./space-config.js";
import { spaceWorkspaceHostPath } from "./spaces.js";

function orderedMembers<T extends { id: string; updatedAt: Date }>(
  members: T[],
): T[] {
  return [...members].sort(
    (left, right) =>
      right.updatedAt.getTime() - left.updatedAt.getTime() ||
      left.id.localeCompare(right.id),
  );
}

/**
 * Move legacy ACP/MCP selection into each Space.
 *
 * A Space and all of its Agents are locked and updated in one transaction. A
 * concurrent bootstrap therefore observes the committed winner instead of
 * stripping a second copy from stale rows. Existing Space keys always win.
 */
export async function migrateAgentSettingsToSpaces(
  db: Db,
  log: (msg: string) => void,
  options: AgentSettingsMigrationOptions = {},
): Promise<void> {
  let spaceIds: string[];
  try {
    spaceIds = (await db.select({ id: spaces.id }).from(spaces)).map(
      (row) => row.id,
    );
  } catch {
    // Older installations can briefly call this before the Space tables exist.
    return;
  }

  for (const spaceId of spaceIds) {
    const committedMessages = await db.transaction(async (tx) => {
      const [space] = await tx
        .select()
        .from(spaces)
        .where(eq(spaces.id, spaceId))
        .for("update");
      if (!space) return [] as string[];

      const members = orderedMembers(
        await tx
          .select()
          .from(agents)
          .where(eq(agents.spaceId, space.id))
          .orderBy(desc(agents.updatedAt), agents.id)
          .for("update"),
      );
      const memberConfigs = members.map((agent) =>
        parseConfigJson(agent.configJson),
      );
      const spaceConfig = parseConfigJson(space.configJson);
      const messages: string[] = [];
      let spaceDirty = false;

      if (!("acp" in spaceConfig)) {
        const acp = pickSpaceAcp(memberConfigs);
        if (acp !== null) {
          spaceConfig.acp = acp;
          spaceDirty = true;
          messages.push(`acp → space ${space.slug}`);
        }
      }
      if (!("mcp" in spaceConfig)) {
        spaceConfig.mcp = pickSpaceMcp(memberConfigs);
        spaceDirty = true;
      }
      if (spaceDirty) {
        await tx
          .update(spaces)
          .set({
            configJson: JSON.stringify(spaceConfig),
            updatedAt: new Date(),
          })
          .where(eq(spaces.id, space.id));
      }

      for (const agent of members) {
        const stripped = stripSpaceOwnedKeys(parseConfigJson(agent.configJson));
        if (!stripped) continue;
        await options.beforeAgentWrite?.(agent.id);
        await tx
          .update(agents)
          // Preserve legacy recency: the following workspace migration uses it
          // to choose the first-wins merge order.
          .set({ configJson: JSON.stringify(stripped) })
          .where(eq(agents.id, agent.id));
      }
      return messages;
    });

    // A logger failure must not roll back or split the committed migration.
    for (const message of committedMessages) log(message);
  }
}

export type AgentSettingsMigrationOptions = {
  /** Test seam for deterministic transaction rollback checks. */
  beforeAgentWrite?: (agentId: string) => void | Promise<void>;
};

/** Legacy Agent workspace directory, retained after a successful copy. */
function legacyAgentWorkspacePath(config: AppConfig, agentId: string): string {
  return join(config.dataDir, "agents", agentId, "workspace");
}

function hasContent(directory: string): boolean {
  try {
    return existsSync(directory) && readdirSync(directory).length > 0;
  } catch {
    return false;
  }
}

function isPublishConflict(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return error.code === "EEXIST" || error.code === "ENOTEMPTY";
}

function publishWorkspace(staging: string, target: string): boolean {
  try {
    renameSync(staging, target);
    return true;
  } catch (error) {
    if (!isPublishConflict(error)) throw error;
  }

  // A concurrent migration or workspace start won. Never merge over it.
  if (hasContent(target)) return false;
  try {
    rmdirSync(target);
  } catch (error) {
    if (
      !isPublishConflict(error) &&
      (error as NodeJS.ErrnoException).code !== "ENOENT"
    ) {
      throw error;
    }
    if (hasContent(target)) return false;
  }
  try {
    renameSync(staging, target);
    return true;
  } catch (error) {
    if (isPublishConflict(error)) return false;
    throw error;
  }
}

export type SpaceWorkspaceMigrationOptions = {
  /** Test seam for deterministic mid-copy failures. */
  copyDirectory?: (source: string, target: string) => void;
};

/**
 * Merge legacy Agent workspace directories into the Space workspace.
 *
 * Sources are merged newest-Agent-first in a private staging directory. The
 * completed tree is atomically renamed into place, so a crash or copy failure
 * never publishes a partial workspace. Concurrent callers race only at rename;
 * the loser discards its staging tree. Legacy sources are never deleted.
 */
export async function migrateAgentWorkspacesToSpaces(
  db: Db,
  config: AppConfig,
  log: (msg: string) => void,
  options: SpaceWorkspaceMigrationOptions = {},
): Promise<void> {
  let spaceRows;
  try {
    spaceRows = await db.select().from(spaces);
  } catch {
    return;
  }
  if (!spaceRows.length) return;

  let agentRows;
  try {
    agentRows = await db.select().from(agents);
  } catch {
    return;
  }

  const copyDirectory =
    options.copyDirectory ??
    ((source: string, target: string) => {
      cpSync(source, target, {
        recursive: true,
        force: false,
        errorOnExist: false,
      });
    });

  for (const space of spaceRows) {
    const target = spaceWorkspaceHostPath(config, space.id);
    if (hasContent(target)) continue;
    const members = orderedMembers(
      agentRows.filter((agent) => agent.spaceId === space.id),
    );
    const sources = members
      .map((member) => ({
        member,
        path: legacyAgentWorkspacePath(config, member.id),
      }))
      .filter((source) => hasContent(source.path));
    if (!sources.length) continue;

    mkdirSync(dirname(target), { recursive: true });
    const staging = join(
      dirname(target),
      `.workspace-migration-${space.id}-${randomUUID()}`,
    );
    mkdirSync(staging);
    let copied = 0;
    let copyingAgentId = sources[0]!.member.id;
    try {
      for (const source of sources) {
        copyingAgentId = source.member.id;
        copyDirectory(source.path, staging);
        copied += 1;
      }
      if (publishWorkspace(staging, target)) {
        log(`workspace → space ${space.slug} (${copied} agent dirs)`);
      }
    } catch (error) {
      log(
        `workspace copy failed for agent ${copyingAgentId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    } finally {
      // No-op after a successful rename; removes failed/concurrent-loser staging.
      rmSync(staging, { recursive: true, force: true });
    }
  }
}
