import assert from "node:assert/strict";
import test from "node:test";

import { buildProjectCreateInput, removeProjectFromChatState } from "../src/lib/chat-project-state.js";
import { buildChatSettingsPatch } from "../src/lib/chat-settings-state.js";

test("project form normalizes workspace and git semantics", () => {
  assert.deepEqual(buildProjectCreateInput({ name: "  ", description: "", gitUrl: "", withWorkspace: false }), {
    error: "请填写项目名",
  });
  assert.deepEqual(
    buildProjectCreateInput({
      name: "  Docs ",
      description: "  product docs ",
      gitUrl: " https://example.test/docs.git ",
      withWorkspace: false,
    }),
    {
      value: {
        name: "Docs",
        description: "product docs",
        withWorkspace: true,
        gitUrl: "https://example.test/docs.git",
      },
    },
  );
});

test("deleting the open project unlinks sessions and returns to project list", () => {
  const next = removeProjectFromChatState(
    {
      projects: [{ slug: "docs" }, { slug: "app" }],
      sessions: [{ id: "1", project: "docs" }, { id: "2", project: "app" }],
      activeProject: "docs",
      settingsProject: "docs",
      mainPane: "project-settings",
    },
    "docs",
  );
  assert.deepEqual(next.projects, [{ slug: "app" }]);
  assert.deepEqual(next.sessions, [{ id: "1", project: null }, { id: "2", project: "app" }]);
  assert.equal(next.activeProject, null);
  assert.equal(next.settingsProject, null);
  assert.equal(next.mainPane, "projects");
});

test("settings patch stays sparse and clamps subagent depth", () => {
  assert.deepEqual(buildChatSettingsPatch({ enableTools: false }), { enableTools: false });
  assert.deepEqual(
    buildChatSettingsPatch({ maxSubagentDepth: "99", approvalsPolicy: "ask" }),
    { maxSubagentDepth: 5, approvals: { policy: "ask" } },
  );
  assert.deepEqual(buildChatSettingsPatch({ maxSubagentDepth: "invalid" }), {
    maxSubagentDepth: null,
  });
});
