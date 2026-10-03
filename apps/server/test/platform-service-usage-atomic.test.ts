import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import {
  PLATFORM_QUOTA_TOTAL_USER,
  PlatformServiceUsageService,
  QuotaExceededError,
} from "../src/services/platform-service-usage.js";

describe("platform usage atomic quotas", () => {
  let dataDir = "";
  let db: import("../src/db/client.js").Db;
  let close: () => Promise<void>;
  let tenantId = "";

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "zakura-quota-atomic-"));
    const databaseUrl = `pglite:${join(dataDir, "db")}`;
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(databaseUrl);
    const opened = await (await import("../src/db/client.js")).createDb({ databaseUrl, dataDir });
    db = opened.db;
    close = opened.close;
    const { newId, tenants } = await import("../src/db/schema.js");
    tenantId = newId();
    await db.insert(tenants).values({
      id: tenantId, slug: `quota-${tenantId}`, name: "Quota", isDefault: false,
      createdAt: new Date(), updatedAt: new Date(),
    });
  });

  after(async () => {
    await close?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("admits exactly the limit under concurrent users and increments both periods atomically", async () => {
    const config = { multiTenant: true } as never;
    const left = new PlatformServiceUsageService(db, config);
    const right = new PlatformServiceUsageService(db, config);
    await left.upsertQuota({
      scopeKey: tenantId,
      serviceKey: "searxng",
      monthlyLimit: 5,
      dailyLimit: 5,
    });

    const results = await Promise.allSettled(
      Array.from({ length: 24 }, (_, index) =>
        (index % 2 ? left : right).checkAndIncrement({
          tenantId,
          userId: `user-${index}`,
          serviceKey: "searxng",
        }),
      ),
    );
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 5);
    assert.ok(
      results
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .every((result) => result.reason instanceof QuotaExceededError),
    );

    const { platformServiceUsage } = await import("../src/db/schema.js");
    const aggregate = await db
      .select()
      .from(platformServiceUsage)
      .where(and(
        eq(platformServiceUsage.tenantId, tenantId),
        eq(platformServiceUsage.userId, PLATFORM_QUOTA_TOTAL_USER),
        eq(platformServiceUsage.serviceKey, "searxng"),
      ));
    assert.equal(aggregate.length, 2);
    assert.deepEqual(aggregate.map((row) => row.requestCount).sort(), [5, 5]);

    const visible = await left.usageSummary({ tenantId, serviceKey: "searxng" });
    assert.equal(visible.reduce((sum, row) => sum + row.requestCount, 0), 10);
    assert.equal(visible.some((row) => row.userId === PLATFORM_QUOTA_TOTAL_USER), false);
  });
});
