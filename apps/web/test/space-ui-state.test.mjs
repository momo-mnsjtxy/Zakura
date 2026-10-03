import assert from "node:assert/strict";
import test from "node:test";
import { automationPrompt, buildSpaceCreateInput, buildSpaceUpdateInput, filterSpaceAgents } from "../src/lib/space-ui-state.js";

test("space create and settings forms normalize API payloads", () => {
  assert.deepEqual(buildSpaceCreateInput({ name: " ", description: "" }), { error: "请填写名称" });
  assert.deepEqual(buildSpaceCreateInput({ name: " Lab ", description: " shared " }), {
    value: { name: "Lab", description: "shared" },
  });
  assert.deepEqual(buildSpaceUpdateInput({ name: " Lab ", description: "  " }), {
    value: { name: "Lab", description: "" },
  });
});

test("space detail selects only its agents", () => {
  assert.deepEqual(filterSpaceAgents([{ id: "a", spaceId: "1" }, { id: "b", spaceId: "2" }], "2"), [{ id: "b", spaceId: "2" }]);
});

test("automation navigation preserves the requested goal", () => {
  const prompt = automationPrompt("  run backups nightly  ");
  assert.match(prompt, /create_routine/);
  assert.match(prompt, /run backups nightly$/);
});
