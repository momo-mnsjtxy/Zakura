import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RunCancellationRegistry } from "../src/services/run-cancellation.js";
describe("run cancellation registry", () => {
  it("fires once and invokes late subscribers immediately", () => {
    const registry = new RunCancellationRegistry(); let calls = 0;
    registry.subscribe("run", () => calls++); registry.subscribe("run", () => calls++);
    registry.cancel("run"); registry.cancel("run"); registry.subscribe("run", () => calls++);
    assert.equal(calls, 3); assert.equal(registry.isCancelled("run"), true);
  });
  it("isolates errors and supports idempotent unsubscribe and clear", () => {
    const errors: unknown[] = []; const registry = new RunCancellationRegistry((e) => errors.push(e));
    const off = registry.subscribe("run", () => { throw new Error("removed"); }); off(); off();
    registry.subscribe("run", () => { throw new Error("reported"); }); registry.cancel("run");
    assert.equal(errors.length, 1); registry.clear("run"); assert.equal(registry.isCancelled("run"), false);
  });
});
