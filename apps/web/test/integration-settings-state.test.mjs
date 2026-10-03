import assert from "node:assert/strict";
import test from "node:test";
import { buildMcpBindingPatch, createOauthResultGate, deriveMcpBinding, filterCustomSkillSources } from "../src/lib/integration-settings-state.js";

test("MCP binding state dedupes selected instances and preserves exposure", () => {
  const options = { mcp: { mode: "selected", exposeWorkspaceFs: false, instances: [{ id: "a", bound: true }, { id: "b", bound: false }] } };
  assert.deepEqual(deriveMcpBinding(options), { mode: "selected", selected: ["a"], exposeFs: false });
  assert.deepEqual(buildMcpBindingPatch({ mode: "selected", selected: [], exposeFs: true }, { selected: ["a", "a"] }), {
    mcp: { mode: "selected", instanceIds: ["a"], exposeWorkspaceFs: true },
  });
});

test("skill sources keep only configurable compatible markets", () => {
  assert.deepEqual(filterCustomSkillSources([
    { id: "builtin", format: "mcp" }, { id: "custom:x", format: "mcp" }, { id: "codex", format: "codex" },
  ]).map((source) => source.id), ["custom:x", "codex"]);
});

test("OAuth callback gate accepts only the first return channel", () => {
  const gate = createOauthResultGate();
  assert.equal(gate.accept(), true);
  assert.equal(gate.accept(), false);
});
