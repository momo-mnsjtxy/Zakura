import assert from "node:assert/strict";
import test from "node:test";
import { BridgeStateStore } from "../src/state.js";

test("pending state and grants are one-time and bounded", () => {
  const store = new BridgeStateStore(100);
  store.putPending("state", { clientRedirectUri: "https://client.example/cb", codeVerifier: "v", createdAt: 1_000 });
  assert.equal(store.takePending("state")?.codeVerifier, "v");
  assert.equal(store.takePending("state"), undefined);

  store.putGrant("fresh", { accessToken: "a", createdAt: 1_050 });
  store.putGrant("old", { accessToken: "b", createdAt: 800 });
  store.purge(1_100);
  assert.equal(store.getGrant("old"), undefined);
  assert.equal(store.getGrant("fresh")?.accessToken, "a");
  store.consumeGrant("fresh");
  assert.equal(store.getGrant("fresh"), undefined);
});
