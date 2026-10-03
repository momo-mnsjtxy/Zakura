import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PendingLifecycle } from "../src/services/pending-lifecycle.js";

describe("pending request lifecycle", () => {
  it("settles once and makes duplicate resolution a no-op", async () => {
    const lifecycle = new PendingLifecycle<string>();
    const pending = lifecycle.wait("id", { expiresAt: null, subscribeCancel: () => () => {}, onExpire() {}, onCancel() {} });
    assert.equal(lifecycle.settle("id", "approved"), true);
    assert.equal(lifecycle.settle("id", "denied"), false);
    assert.equal(await pending, "approved");
  });

  it("routes cancellation and timeout through lifecycle callbacks", async () => {
    const lifecycle = new PendingLifecycle<string>();
    let cancel!: () => void;
    const cancelled = lifecycle.wait("cancel", {
      expiresAt: null,
      subscribeCancel: (listener) => { cancel = listener; return () => {}; },
      onCancel: () => lifecycle.settle("cancel", "cancelled"),
      onExpire() {},
    });
    cancel();
    assert.equal(await cancelled, "cancelled");

    const expired = lifecycle.wait("timeout", {
      expiresAt: new Date(Date.now() - 1),
      subscribeCancel: () => () => {},
      onCancel() {},
      onExpire: () => lifecycle.settle("timeout", "timeout"),
    });
    assert.equal(await expired, "timeout");
  });
});
