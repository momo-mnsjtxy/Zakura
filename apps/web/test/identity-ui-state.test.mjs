import assert from "node:assert/strict";
import test from "node:test";
import { oauthClientGroups, profilePatch, sessionRecovery, teamDestination } from "../src/lib/identity-ui-state.js";

test("profile and OAuth settings normalize sparse server state", () => {
  assert.deepEqual(profilePatch({ name: " Ada ", title: " Dev ", bio: " hi " }), { name: "Ada", title: "Dev", bio: "hi" });
  assert.deepEqual(oauthClientGroups({ inbound: [{ id: "i" }] }), { inbound: [{ id: "i" }], dcr: [], byo: [] });
});

test("team deletion and stale session recover to bounded destinations", () => {
  assert.equal(teamDestination({ onboardingCompleted: false }), "/onboarding");
  assert.equal(teamDestination({ onboardingCompleted: true }), "/dashboard/agents");
  assert.deepEqual(sessionRecovery(401), { clearSession: true, destination: "/login" });
  assert.equal(sessionRecovery(500), null);
});
