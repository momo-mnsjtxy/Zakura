import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bindPlatformServiceRuntime,
  consumeManagedUsage,
  getPlatformServiceManager,
  resolveManagedForFetchBackend,
  resolveManagedForSearchEngine,
} from "../src/platform-services/runtime-bind.js";

describe("platform runtime binding generation", () => {
  it("does not return a stale manager result after a rebind", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const oldManager = {
      resolveManaged: async () => {
        await gate;
        return { endpointUrl: "https://old.test", apiKey: "old" };
      },
    };
    const oldUsage = { checkAndIncrement: async () => undefined };
    const disposeOld = bindPlatformServiceRuntime(oldManager as never, oldUsage as never);
    const pending = resolveManagedForSearchEngine("searxng");

    const newManager = {
      resolveManaged: async () => ({ endpointUrl: "https://new.test", apiKey: "new" }),
    };
    const usageCalls: string[] = [];
    const newUsage = {
      checkAndIncrement: async (input: { serviceKey: string }) => {
        usageCalls.push(input.serviceKey);
      },
    };
    const disposeNew = bindPlatformServiceRuntime(newManager as never, newUsage as never);
    release();
    assert.equal(await pending, null);
    assert.equal(getPlatformServiceManager(), newManager);

    disposeOld();
    assert.equal(getPlatformServiceManager(), newManager, "old disposer must not clear new binding");
    assert.deepEqual(await resolveManagedForFetchBackend("firecrawl"), {
      endpointUrl: "https://new.test",
      apiKey: "new",
      serviceKey: "firecrawl",
    });
    await consumeManagedUsage({ tenantId: "tenant", serviceKey: "firecrawl" });
    assert.deepEqual(usageCalls, ["firecrawl"]);

    disposeNew();
    assert.equal(getPlatformServiceManager(), null);
    assert.equal(await resolveManagedForSearchEngine("searxng"), null);
  });
});
