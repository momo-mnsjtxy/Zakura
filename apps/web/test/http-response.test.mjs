import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeApiResponse,
  isTransientHttpStatus,
} from "../src/lib/http-response.js";

test("decodes JSON API responses", async () => {
  const result = await decodeApiResponse(
    new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json; charset=utf-8" },
    }),
  );
  assert.deepEqual(result, { ok: true });
});

test("accepts successful empty responses", async () => {
  assert.deepEqual(await decodeApiResponse(new Response(null, { status: 204 })), {});
});

test("preserves plain-text proxy errors for retry UI", async () => {
  const result = await decodeApiResponse(
    new Response("runtime is restarting", { status: 503 }),
  );
  assert.deepEqual(result, { error: "runtime is restarting" });
  assert.equal(isTransientHttpStatus(503), true);
  assert.equal(isTransientHttpStatus(404), false);
});
