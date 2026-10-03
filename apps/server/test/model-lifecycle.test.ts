import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { executeRetryLifecycle, ModelCallAbortedError } from "../src/model-router/lifecycle.js";

describe("model call retry lifecycle", () => {
  it("retries deterministic transient failures", async () => {
    const attempts: number[] = [];
    const result = await executeRetryLifecycle(async (attempt) => {
      attempts.push(attempt);
      if (attempt < 3) throw new Error("transient");
      return "ok";
    }, { attempts: 3, baseDelayMs: 0, shouldRetry: () => true });
    assert.equal(result, "ok");
    assert.deepEqual(attempts, [1, 2, 3]);
  });

  it("cancels during backoff without another provider call", async () => {
    const controller = new AbortController();
    let calls = 0;
    const pending = executeRetryLifecycle(async () => {
      calls += 1;
      throw new Error("transient");
    }, { attempts: 3, baseDelayMs: 10_000, signal: controller.signal, shouldRetry: () => true });
    setTimeout(() => controller.abort(), 5);
    await assert.rejects(pending, ModelCallAbortedError);
    assert.equal(calls, 1);
  });

  it("never retries explicit cancellation even if classifier says yes", async () => {
    let calls = 0;
    await assert.rejects(executeRetryLifecycle(async () => {
      calls += 1;
      throw new ModelCallAbortedError();
    }, { attempts: 3, baseDelayMs: 0, shouldRetry: () => true }), ModelCallAbortedError);
    assert.equal(calls, 1);
  });
});
