import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { KeyedLifecycle } from "../src/services/keyed-lifecycle.js";

describe("keyed lifecycle", () => {
  it("coalesces concurrent operations and permits later retry", async () => {
    const lifecycle = new KeyedLifecycle(); let calls = 0; let release!: () => void;
    const operation = () => { calls += 1; return new Promise<string>((resolve) => { release = () => resolve("ok"); }); };
    const first = lifecycle.run("instance", operation);
    const second = lifecycle.run("instance", operation);
    await Promise.resolve();
    assert.equal(calls, 1);
    release();
    assert.deepEqual(await Promise.all([first, second]), ["ok", "ok"]);
    const third = lifecycle.run("instance", async () => { calls += 1; return "again"; });
    assert.equal(await third, "again");
    assert.equal(calls, 2);
  });
});
