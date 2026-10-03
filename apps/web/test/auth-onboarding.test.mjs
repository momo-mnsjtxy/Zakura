import assert from "node:assert/strict";
import test from "node:test";

import {
  createActionLock,
  loginCapabilities,
  readLoginIntent,
  resolveEmailDiscovery,
} from "../src/lib/auth-flow.js";
import { isUnauthorizedOnboardingError, moveOnboarding } from "../src/lib/onboarding-flow.js";

test("login deep links restore safe intent", () => {
  assert.deepEqual(readLoginIntent("?suspended=1&reason=Policy&email=a%40b.test&mode=register"), {
    suspendedReason: "Policy",
    email: "a@b.test",
    mode: "register",
  });
});

test("capabilities and SSO discovery choose the available path", () => {
  const capabilities = loginCapabilities({
    edition: "saas",
    passwordLoginEnabled: false,
    oauthProviders: [{ id: "google", enabled: true }, { id: "off", enabled: false }],
  });
  assert.equal(capabilities.registrationEnabled, false);
  assert.deepEqual(resolveEmailDiscovery(
    { sso: true, protocol: "oidc", tenantSlug: "acme" },
    capabilities,
  ), { action: "sso", hint: { protocol: "oidc", tenantSlug: "acme" } });
  assert.equal(resolveEmailDiscovery({}, capabilities).action, "notice");
});

test("repeated login action is locked until the interrupted request settles", () => {
  const lock = createActionLock();
  assert.equal(lock.acquire(), true);
  assert.equal(lock.acquire(), false);
  lock.release();
  assert.equal(lock.acquire(), true);
});

test("onboarding navigation preserves direction and ignores invalid destinations", () => {
  assert.deepEqual(moveOnboarding({ step: "provider", direction: "forward" }, "connect", "back"), {
    step: "connect",
    direction: "back",
  });
  const current = { step: "choose", direction: "forward" };
  assert.equal(moveOnboarding(current, "missing"), current);
  assert.equal(isUnauthorizedOnboardingError(new Error("HTTP 401")), true);
});
