import assert from "node:assert/strict";
import test from "node:test";

import {
  agentAfterClose,
  buildAgentCreateInput,
  splitAgentSettingsPatch,
} from "../src/lib/agent-ui-state.js";

test("agent create validates and normalizes navigation payload", () => {
  assert.deepEqual(buildAgentCreateInput({ name: "", spaceId: "s", description: "" }), {
    error: "请填写名称",
  });
  assert.deepEqual(buildAgentCreateInput({ name: " Helper ", spaceId: "s", description: " notes " }), {
    value: { name: "Helper", spaceId: "s", description: "notes", createApiKey: false },
  });
});

test("settings updates are split into agent, provider and cloud contracts", () => {
  assert.deepEqual(splitAgentSettingsPatch({
    name: " Helper ", webSearchEnabled: false, compactKeepRecent: "99", maxSubagentDepth: "9",
  }), {
    agent: { name: "Helper" },
    providers: { webSearch: { enabled: false } },
    cloud: { compactKeepRecent: 64, maxSubagentDepth: 5 },
  });
  assert.deepEqual(splitAgentSettingsPatch({ compactThresholdChars: "7999", maxToolRounds: "" }).cloud, {
    compactThresholdChars: null,
    maxToolRounds: null,
  });
});

test("closing create returns to default space without stale form values", () => {
  assert.deepEqual(agentAfterClose([{ id: "a" }, { id: "b", isDefault: true }]), {
    name: "",
    description: "",
    spaceId: "b",
  });
});
