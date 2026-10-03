import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CloudAgentSessionStore } from "../src/services/cloud-agent-session.js";

describe("Redis delta ordering", () => {
  it("does not resolve a delta append until its pending/event MULTI is committed", async () => {
    const previous = process.env.REDIS_URL;
    process.env.REDIS_URL = "off";
    let release!: () => void;
    const exec = new Promise<void>((resolve) => {
      release = resolve;
    });
    const commands: string[] = [];
    const transaction = {
      rPush() { commands.push("rPush"); return transaction; },
      lTrim() { commands.push("lTrim"); return transaction; },
      expire() { commands.push("expire"); return transaction; },
      publish() { commands.push("publish"); return transaction; },
      async exec() { commands.push("exec"); await exec; return []; },
    };
    const redis = {
      async eval() { return 0; },
      async incr() { return 1; },
      multi() { return transaction; },
    };
    const store = new CloudAgentSessionStore({} as never);
    const internals = store as unknown as {
      sessionMeta: Map<string, { tenantId: string; agentId: string; lastSeq: number; seqSeeded: boolean }>;
      flushTimers: Map<string, ReturnType<typeof setTimeout>>;
      appendEventRedis(redis: unknown, input: unknown): Promise<unknown>;
    };
    internals.sessionMeta.set("session", {
      tenantId: "tenant",
      agentId: "agent",
      lastSeq: 0,
      seqSeeded: true,
    });

    let settled = false;
    const pending = internals
      .appendEventRedis(redis, {
        sessionId: "session",
        type: "assistant_delta",
        runId: "run",
        payload: { messageId: "message", delta: "hello" },
      })
      .then(() => {
        settled = true;
      });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(settled, false);
    assert.deepEqual(commands, ["rPush", "rPush", "lTrim", "expire", "publish", "exec"]);

    release();
    await pending;
    assert.equal(settled, true);
    for (const timer of internals.flushTimers.values()) clearTimeout(timer);
    internals.flushTimers.clear();
    if (previous === undefined) delete process.env.REDIS_URL;
    else process.env.REDIS_URL = previous;
  });
});
