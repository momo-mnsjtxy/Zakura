import assert from "node:assert/strict";
import test from "node:test";

import {
  createActionLock,
  loginCapabilities,
  loginReturnHref,
  inviteState,
  readLoginIntent,
  registrationRedirect,
  tokenState,
  resolveEmailDiscovery,
} from "../src/lib/auth-flow.js";
import { isUnauthorizedOnboardingError, moveOnboarding } from "../src/lib/onboarding-flow.js";

test("login deep links restore safe intent", () => {
  assert.deepEqual(readLoginIntent("?suspended=1&reason=Policy&email=a%40b.test&mode=register"), {
    suspendedReason: "Policy",
    email: "a@b.test",
    mode: "register",
  });
  assert.equal(registrationRedirect("?email=a%2Bb%40example.test"), "/login?mode=register&email=a%2Bb%40example.test");
  assert.equal(loginReturnHref("  a+b@example.test "), "/login?email=a%2Bb%40example.test");
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

test("invite and reset tokens recover from expiry, mismatch and missing input", () => {
  const info = { email: "a@example.test", expiresAt: "2026-01-02T00:00:00.000Z" };
  assert.equal(inviteState(info, null, Date.parse("2026-01-01T00:00:00.000Z")).canAccept, true);
  assert.equal(inviteState(info, "b@example.test", Date.parse("2026-01-01T00:00:00.000Z")).status, "mismatch");
  assert.equal(inviteState(info, null, Date.parse("2026-01-03T00:00:00.000Z")).status, "expired");
  assert.deepEqual(tokenState("  token "), { valid: true, token: "token" });
  assert.equal(tokenState("").valid, false);
});
