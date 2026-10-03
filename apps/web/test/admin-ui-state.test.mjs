import assert from "node:assert/strict";
import test from "node:test";
import { adminFilterIntent, auditExportMeta, enabledManagedServices, normalizeRetentionDays, unsuspendUserRow } from "../src/lib/admin-ui-state.js";

test("admin deep links and suspension recovery normalize state", () => {
  assert.deepEqual(adminFilterIntent("?status=suspended"), { status: "suspended" });
  assert.deepEqual(unsuspendUserRow({ id: "u", suspended: true, suspendedAt: "x", suspendedReason: "r" }), {
    id: "u", suspended: false, suspendedAt: null, suspendedReason: null,
  });
});

test("audit export reports truncated CSV instead of silently treating it as complete", () => {
  const headers = new Headers({ "x-audit-total": "1200", "x-audit-exported": "1000", "x-audit-truncated": "true" });
  assert.deepEqual(auditExportMeta(headers), { total: 1200, exported: 1000, truncated: true });
});

test("audit retention and managed defaults are bounded", () => {
  assert.equal(normalizeRetentionDays(0), 1);
  assert.equal(normalizeRetentionDays(9999), 3650);
  assert.deepEqual(enabledManagedServices([{ key: "a", mode: "disabled" }, { key: "b", mode: "managed" }]), [{ key: "b", mode: "managed" }]);
});
