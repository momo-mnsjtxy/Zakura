import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { callAgentNativeTool } from "../src/services/agent-tools.js";

describe("agent_info shared Space computer", () => {
  it("reads container state by spaceId rather than agentId", async () => {
    const lookedUp: string[] = [];
    const workspace = {
      getWorkspaceContainer: async (id: string) => {
        lookedUp.push(id);
        return { status: "running", dockerId: "ctr-space", image: "workspace" };
      },
      getDesktopInfo: async () => ({ enabled: true, supported: true }),
    };
    const agent = {
      id: "agent-a",
      tenantId: "tenant",
      spaceId: "space-shared",
      spaceName: "Shared",
      name: "A",
      slug: "a",
      description: "",
      enableComputer: true,
      enableFs: true,
      enableMemory: false,
      runtimeNodeId: "node",
      workspaceKind: "container",
      workspaceStatus: "ready",
      configJson: "{}",
    };
    const result = await callAgentNativeTool(
      agent as never,
      workspace as never,
      "agent_info",
      {},
      null,
      null,
      null,
      null,
      null,
      null,
    );
    assert.notEqual(result.isError, true);
    assert.deepEqual(lookedUp, ["space-shared"]);
    const text = result.content.find((part) => part.type === "text")?.text ?? "{}";
    const info = JSON.parse(text) as { workspace?: { dockerId?: string } };
    assert.equal(info.workspace?.dockerId, "ctr-space");
  });
});
