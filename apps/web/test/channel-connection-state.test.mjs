import assert from "node:assert/strict";
import test from "node:test";
import {
  connectorOauthResult,
  createChannelConnectionController,
  reconcileChannelBinding,
  removeChannelBinding,
} from "../src/lib/channel-connection-state.js";

test("stale catalog and channel loads cannot replace a newer screen", () => {
  const state = createChannelConnectionController();
  const oldLoad = state.beginLoad();
  const newLoad = state.beginLoad();
  assert.equal(oldLoad.current(), false);
  assert.equal(newLoad.current(), true);
  state.invalidate();
  assert.equal(newLoad.current(), false);
});

test("independent catalog and webhook loads do not invalidate each other", () => {
  const state = createChannelConnectionController();
  const catalog = state.beginLoad("catalog");
  const webhook = state.beginLoad("webhook");
  assert.equal(catalog.current(), true);
  assert.equal(webhook.current(), true);
  state.beginLoad("catalog");
  assert.equal(catalog.current(), false);
  assert.equal(webhook.current(), true);
});

test("repeated installs and channel mutations share one in-flight request and unlock on error", async () => {
  const state = createChannelConnectionController();
  let calls = 0;
  const operation = async () => { calls += 1; throw new Error("offline"); };
  const first = state.runOnce("install:slack", operation);
  const second = state.runOnce("install:slack", operation);
  assert.equal(first, second);
  await assert.rejects(first, /offline/);
  await state.runOnce("install:slack", async () => { calls += 1; return "ok"; });
  assert.equal(calls, 2);
});

test("binding responses reconcile without duplicates and delete is repeat safe", () => {
  const updated = reconcileChannelBinding([{ id: "b", label: "old" }], { id: "b", label: "new" });
  assert.deepEqual(updated, [{ id: "b", label: "new" }]);
  assert.deepEqual(removeChannelBinding(removeChannelBinding(updated, "b"), "b"), []);
});

test("OAuth returns distinguish success, cancellation and provider errors", () => {
  assert.deepEqual(connectorOauthResult("?oauth=1"), { ok: true, message: "授权已完成" });
  assert.deepEqual(connectorOauthResult("?oauth=cancelled"), { ok: false, message: "授权未完成，请重试" });
  assert.deepEqual(connectorOauthResult("?oauth=error&error_description=denied"), { ok: false, message: "denied" });
  assert.equal(connectorOauthResult(""), null);
});
