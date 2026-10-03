import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { redactAuditDetail } from "../src/services/identity/util.js";
import { auditToCsv, type SecurityAuditLogDto } from "../src/services/identity/audit.js";

describe("identity audit", () => {
  it("append 用的 detail 不含密钥字段", () => {
    const redacted = redactAuditDetail({
      email: "a@b.com",
      token: "atk_secret",
      clientSecret: "shh",
      protocol: "oidc",
    });
    assert.equal(redacted.email, "a@b.com");
    assert.equal(redacted.protocol, "oidc");
    assert.equal("token" in redacted, false);
    assert.equal("clientSecret" in redacted, false);
  });

  it("recursively redacts nested credentials and bounds cyclic detail", () => {
    const cyclic: Record<string, unknown> = { safe: "yes" };
    cyclic.self = cyclic;
    const redacted = redactAuditDetail({
      nested: {
        password: "hidden",
        safe: true,
        rows: [{ accessToken: "hidden", value: "ok" }],
      },
      cyclic,
    });
    assert.deepEqual(redacted.nested, { safe: true, rows: [{ value: "ok" }] });
    assert.deepEqual(redacted.cyclic, { safe: "yes", self: "[circular]" });
  });

  it("neutralizes spreadsheet formulas in CSV without changing columns", () => {
    const row: SecurityAuditLogDto = {
      id: "audit-1",
      tenantId: "tenant-1",
      actorType: "user",
      actorId: "+SUM(1,1)",
      action: "=cmd|' /C calc'!A0",
      targetType: "user",
      targetId: "@malicious",
      detail: { value: "-1+1" },
      ip: null,
      createdAt: "2026-10-03T00:00:00.000Z",
    };
    const csv = auditToCsv([row]);
    assert.match(csv, /'=cmd/);
    assert.match(csv, /'\+SUM/);
    assert.match(csv, /'@malicious/);
  });
});
