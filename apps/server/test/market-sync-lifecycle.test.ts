import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MarketSyncService, type MarketSyncScheduler } from "../src/services/market-sync.js";

function fakeScheduler() {
  const timeouts = new Map<object, () => void>();
  const intervals = new Map<object, () => void>();
  const scheduler: MarketSyncScheduler = {
    setTimeout: ((fn: () => void) => {
      const handle = { unref() {} };
      timeouts.set(handle, fn);
      return handle;
    }) as typeof setTimeout,
    clearTimeout: ((handle: object) => {
      timeouts.delete(handle);
    }) as typeof clearTimeout,
    setInterval: ((fn: () => void) => {
      const handle = { unref() {} };
      intervals.set(handle, fn);
      return handle;
    }) as typeof setInterval,
    clearInterval: ((handle: object) => {
      intervals.delete(handle);
    }) as typeof clearInterval,
  };
  return { scheduler, timeouts, intervals };
}

function makeService(opts: {
  scheduler?: MarketSyncScheduler;
  sync?: () => Promise<{ results: Array<{ storeId: string; error?: string }> }>;
  replaceSource?: (source: string) => Promise<void>;
  listRepos?: () => Promise<unknown[]>;
}) {
  const calls = { sync: 0, replace: [] as string[], repos: 0 };
  const mcpStore = {
    sync: async () => {
      calls.sync += 1;
      return opts.sync?.() ?? { results: [] };
    },
    search: async () => ({ items: [] }),
    ensurePluginMarket: async () => [],
  };
  const catalog = {
    replaceSource: async (source: string) => {
      calls.replace.push(source);
      await opts.replaceSource?.(source);
    },
  };
  const skills = {
    listRepos: async () => {
      calls.repos += 1;
      return (await opts.listRepos?.()) ?? [];
    },
    search: async () => ({ items: [] }),
  };
  return {
    calls,
    service: new MarketSyncService(mcpStore as never, catalog as never, skills as never, {
      scheduler: opts.scheduler,
      bootstrapDelayMs: 10,
      intervalMs: 100,
    }),
  };
}

describe("market sync lifecycle", () => {
  it("cancels both bootstrap and recurring timers on stop", () => {
    const scheduled = fakeScheduler();
    const { service } = makeService({ scheduler: scheduled.scheduler });
    service.start();
    service.start();
    assert.equal(scheduled.timeouts.size, 1);
    assert.equal(scheduled.intervals.size, 1);
    service.stop();
    assert.equal(scheduled.timeouts.size, 0);
    assert.equal(scheduled.intervals.size, 0);
  });

  it("isolates source failures so later indexes still refresh", async () => {
    const { service, calls } = makeService({
      sync: async () => {
        throw new Error("fake store outage");
      },
    });
    await service.tick();
    assert.ok(calls.replace.includes("mcp-official"));
    assert.equal(calls.repos, 1);
  });

  it("coalesces overlapping ticks and stopAndDrain waits for the active tick", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { service, calls } = makeService({
      sync: async () => {
        await gate;
        return { results: [] };
      },
    });
    const first = service.tick();
    const second = service.tick();
    let drained = false;
    const drain = service.stopAndDrain().then(() => {
      drained = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(calls.sync, 1);
    assert.equal(drained, false);
    release();
    await Promise.all([first, second, drain]);
    assert.equal(drained, true);
  });
});
