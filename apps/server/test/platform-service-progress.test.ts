import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  beginPlatformServiceProgress,
  clearPlatformServiceProgress,
  finishPlatformServiceProgress,
  getPlatformServiceProgress,
  logPlatformServiceProgress,
} from "../src/services/platform-service-progress.js";

describe("platform service progress lifecycle", () => {
  beforeEach(() => clearPlatformServiceProgress());
  afterEach(() => clearPlatformServiceProgress());

  it("returns immutable snapshots and bounds the event trail", () => {
    beginPlatformServiceProgress("searxng", "pulling", "start", { now: 1_000 });
    for (let i = 0; i < 450; i += 1) {
      logPlatformServiceProgress("searxng", "pull", `line-${i}`, {
        percent: 200,
        now: 1_001 + i,
      });
    }
    const first = getPlatformServiceProgress("searxng", { now: 2_000 });
    assert.equal(first.events.length, 400);
    assert.equal(first.percent, 100);
    first.events.length = 0;
    first.message = "mutated";
    const second = getPlatformServiceProgress("searxng", { now: 2_000 });
    assert.equal(second.events.length, 400);
    assert.equal(second.message, "line-449");
  });

  it("turns abandoned running progress into an explicit reconciliation error", () => {
    beginPlatformServiceProgress("firecrawl", "creating", "working", { now: 10 });
    const stale = getPlatformServiceProgress("firecrawl", {
      now: 1_010,
      staleAfterMs: 500,
    });
    assert.equal(stale.running, false);
    assert.equal(stale.done, true);
    assert.equal(stale.phase, "error");
    assert.match(stale.error ?? "", /became stale/);
    assert.equal(stale.events.at(-1)?.step, "stale");
  });

  it("bounds retained service keys and supports explicit cleanup", () => {
    for (let i = 0; i < 70; i += 1) {
      const key = `service-${i}`;
      beginPlatformServiceProgress(key, "checking", "start", { now: i * 2 });
      finishPlatformServiceProgress(key, { message: "done", now: i * 2 + 1 });
    }
    assert.equal(getPlatformServiceProgress("service-0", { now: 1_000 }).phase, "idle");
    assert.equal(getPlatformServiceProgress("service-69", { now: 1_000 }).phase, "done");
    clearPlatformServiceProgress("service-69");
    assert.equal(getPlatformServiceProgress("service-69", { now: 1_001 }).phase, "idle");
  });
});
