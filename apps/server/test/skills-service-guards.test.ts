import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SkillsService } from "../src/services/skills/service.js";

function agent(tenantId: string) {
  return {
    id: "agent-1", tenantId, spaceId: "space-1", runtimeNodeId: null,
    slug: "agent", name: "Agent", configJson: "{}",
  } as never;
}

describe("skills service ownership and reconciliation", () => {
  it("rejects tenant/agent mismatches before touching a workspace", async () => {
    let fsCalls = 0;
    const service = new SkillsService({
      db: {} as never,
      agentService: {} as never,
      fsProvider: { forAgentBinding: async () => { fsCalls++; return {}; } } as never,
      backgroundRefresh: false,
    });
    await assert.rejects(
      () => service.readSkillFile("tenant-a", agent("tenant-b"), "demo"),
      /不属于当前租户/,
    );
    await assert.rejects(
      () => service.registerFromWorkspace("tenant-a", agent("tenant-b"), "/skills/demo"),
      /不属于当前租户/,
    );
    await assert.rejects(
      () => service.discoverUnregistered("tenant-a", agent("tenant-b")),
      /不属于当前租户/,
    );
    assert.equal(fsCalls, 0);
  });

  it("keeps an error installation record when filesystem uninstall fails", async () => {
    const row = {
      id: "install-1", tenantId: "tenant-a", agentId: "agent-1", skillId: "skill-1",
      name: "demo", path: "/skills/demo", version: "1", enabled: true,
      status: "installed", error: null, createdAt: new Date(), updatedAt: new Date(),
    };
    let saved: Record<string, unknown> | null = null;
    let deleted = false;
    const db = {
      query: { agentSkills: { findFirst: async () => row } },
      update: () => ({
        set: (values: Record<string, unknown>) => ({
          where: async () => { saved = values; },
        }),
      }),
      delete: () => ({ where: async () => { deleted = true; } }),
    };
    const service = new SkillsService({
      db: db as never,
      agentService: { get: async () => agent("tenant-a") } as never,
      fsProvider: {
        forAgentBinding: async () => ({
          exists: async () => true,
          delete: async () => { throw new Error("workspace offline"); },
        }),
      } as never,
      backgroundRefresh: false,
    });
    await assert.rejects(
      () => service.uninstall("tenant-a", "agent-1", "demo"),
      /安装记录已保留以便重试/,
    );
    assert.equal(saved?.status, "error");
    assert.match(String(saved?.error), /workspace offline/);
    assert.equal(deleted, false);
  });
});
