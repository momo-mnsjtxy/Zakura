import assert from "node:assert/strict";
import test from "node:test";
import { authCallbackResult, createCallbackAttemptGate, enrollmentCompletionResult } from "../src/lib/auth-callback-state.js";

test("SSO callback transitions to MFA without accepting a premature session", () => {
  assert.deepEqual(authCallbackResult({ mfaRequired: true, mfaTicket: "t", methods: ["totp"] }), { kind: "mfa", ticket: "t", methods: ["totp"] });
  assert.deepEqual(authCallbackResult({ session: "s" }), { kind: "session", session: "s" });
  assert.equal(authCallbackResult({}).kind, "error");
});

test("restricted enrollment ticket takes precedence over session transition", () => {
  assert.deepEqual(authCallbackResult({ mfaEnrollmentRequired: true, mfaEnrollmentTicket: "enroll", methods: ["totp"] }), { kind: "enrollment", ticket: "enroll", methods: ["totp"] });
});

test("enrollment completion displays unique recovery codes before session transition", () => {
  assert.deepEqual(enrollmentCompletionResult({ session: "s", recoveryCodes: ["a", "a", "b"] }), { kind: "recovery", session: "s", recoveryCodes: ["a", "b"], tenant: undefined });
  assert.deepEqual(enrollmentCompletionResult({ session: "s", recoveryCodes: [] }), { kind: "session", session: "s", tenant: undefined });
  assert.equal(enrollmentCompletionResult({ code: "expired" }).kind, "error");
});

test("expired or replayed callback attempts can retry without stale completion", () => {
  const gate = createCallbackAttemptGate();
  const expired = gate.begin();
  const retry = gate.begin();
  assert.equal(expired(), false);
  assert.equal(retry(), true);
  gate.invalidate();
  assert.equal(retry(), false);
});
