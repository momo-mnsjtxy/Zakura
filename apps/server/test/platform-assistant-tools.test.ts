import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isPlatformAssistant } from "../src/services/agent-providers.js";
import {
  isPlatformAssistantToolName,
  listPlatformAssistantTools,
  callPlatformAssistantTool,
} from "../src/services/platform-assistant-tools.js";

describe("platform assistant tools", () => {
  it("isPlatformAssistant reads top-level and cloud flag", () => {
    assert.equal(isPlatformAssistant({ configJson: "{}" }), false);
    assert.equal(
      isPlatformAssistant({ configJson: JSON.stringify({ platformAssistant: true }) }),
      true,
    );
    assert.equal(
      isPlatformAssistant({
        configJson: JSON.stringify({ cloud: { platformAssistant: true } }),
      }),
      true,
    );
    assert.equal(
      isPlatformAssistant({
        configJson: JSON.stringify({ platformAssistant: false, cloud: {} }),
      }),
      false,
    );
  });

  it("lists re_* connection tools", () => {
    const tools = listPlatformAssistantTools();
    const names = tools.map((t) => t.qualifiedName);
    for (const expected of [
      "re_search_connections",
      "re_install_connection",
      "re_list_connections",
      "re_bind_connection",
      "re_set_connector_credentials",
      "re_list_runners",
      "re_migrate_instance",
      "re_fetch_url",
    ]) {
      assert.ok(names.includes(expected), `missing ${expected}`);
    }
    assert.ok(tools.every((t) => t.agentScoped && t.builtin));
    assert.ok(isPlatformAssistantToolName("search_connections"));
    assert.equal(isPlatformAssistantToolName("fs_read"), false);
  });

  it("migrate_instance stubs when service missing", async () => {
    const result = await callPlatformAssistantTool(
      "migrate_instance",
      { instance_id: "abc", target_node_id: "node-1" },
      {
        tenantId: "t1",
        agentId: "a1",
        isPlatformAdmin: true,
        instanceMigrations: null,
      },
    );
    const text =
      result.content.find((c): c is { type: "text"; text: string } => c.type === "text")?.text ??
      "";
    assert.match(text, /not implemented/i);
    assert.equal(result.isError, true);
  });

  it("rejects platform credential writes without explicit platform-admin authorization", async () => {
    let writes = 0;
    const result = await callPlatformAssistantTool(
      "set_connector_credentials",
      { profile: "github", scope: "platform", values: { token: "secret" } },
      {
        tenantId: "tenant",
        agentId: "agent",
        isPlatformAdmin: false,
        integrations: {
          async saveProfile() {
            writes += 1;
            return null;
          },
        } as never,
      },
    );
    assert.equal(result.isError, true);
    assert.equal(writes, 0);
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    assert.match(text, /platform admin/i);
  });

  it("allows an explicitly authorized platform admin to invoke platform tools", async () => {
    let writes = 0;
    const result = await callPlatformAssistantTool(
      "set_connector_credentials",
      { profile: "github", scope: "platform", values: { token: "secret" } },
      {
        tenantId: "tenant",
        agentId: "agent",
        isPlatformAdmin: true,
        integrations: {
          async saveProfile() {
            writes += 1;
            return {
              key: "github",
              enabled: true,
              configuredFields: ["token"],
              connectorRefs: ["github"],
            };
          },
        } as never,
      },
    );
    assert.notEqual(result.isError, true);
    assert.equal(writes, 1);
    const text = result.content.find((part) => part.type === "text")?.text ?? "";
    assert.equal(text.includes("secret"), false);
  });
});
