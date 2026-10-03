import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planProjectWorkspaceReconciliation } from "../src/services/project-reconciliation.js";

describe("project workspace reconciliation", () => {
  it("creates, enables, and disables projects deterministically", () => {
    assert.deepEqual(
      planProjectWorkspaceReconciliation(
        [
          { slug: "gone", hasWorkspace: true },
          { slug: "kept", hasWorkspace: true },
          { slug: "enable", hasWorkspace: false },
          { slug: "metadata-only", hasWorkspace: false },
        ],
        ["new", "kept", "enable", "new"],
      ),
      { create: ["new"], enable: ["enable"], disable: ["gone"] },
    );
  });

  it("ignores invalid directory entries without deleting metadata-only projects", () => {
    assert.deepEqual(
      planProjectWorkspaceReconciliation(
        [{ slug: "metadata-only", hasWorkspace: false }],
        ["../escape", "", ".hidden"],
      ),
      { create: [], enable: [], disable: [] },
    );
  });
});
