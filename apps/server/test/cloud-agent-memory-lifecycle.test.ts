import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CloudAgentConfig } from "@zakura/shared";
import type { Agent } from "../src/db/schema.js";
import type { ResolvedMemory } from "../src/services/memory-runtime.js";
import { extractAndSaveMemories } from "../src/services/cloud-agent/memory.js";

const tenantId = "tenant-memory-lifecycle";
const agent = { id: "agent-memory-lifecycle", tenantId } as Agent;
const cloud = { model: "memory-model" } as CloudAgentConfig;

function resolved(
  kind: ResolvedMemory["kind"],
  config: Record<string, unknown> = {},
): ResolvedMemory {
  return {
    provider: { id: `provider-${kind}`, name: kind } as never,
    kind,
    config,
    storesLocally: kind === "builtin" || kind === "traditional",
  };
}

function routerFor(memories: Array<Record<string, unknown>>) {
  const calls: unknown[][] = [];
  return {
    calls,
    router: {
      chat: async (...args: unknown[]) => {
        calls.push(args);
        return { content: JSON.stringify({ memories }) };
      },
    } as never,
  };
}

function input(memory: ResolvedMemory) {
  return {
    tenantId,
    agent,
    cloud,
    resolved: memory,
    userContent: "The user shared durable preferences",
    assistantContent: "Acknowledged",
  };
}

describe("post-run automatic memory persistence", () => {
  it("deduplicates existing and batch-local content while isolating one local write failure", async () => {
    const { router, calls } = routerFor([
      { content: " Existing fact ", layer: "fact" },
      {
        content: "New Preference",
        layer: "preference",
        importance: 4,
        tags: ["ui"],
      },
      { content: " new   preference ", layer: "preference" },
      { content: "Fail once", layer: "episode" },
      { content: "Survives", layer: "project" },
    ]);
    const writes: Array<Record<string, unknown>> = [];
    const store = {
      list: async (
        seenTenant: string,
        seenAgent: string,
        opts: { limit: number },
      ) => {
        assert.equal(seenTenant, tenantId);
        assert.equal(seenAgent, agent.id);
        assert.equal(opts.limit, 500);
        return [{ id: "existing", content: "existing FACT" }];
      },
      add: async (
        seenTenant: string,
        seenAgent: string,
        value: Record<string, unknown>,
      ) => {
        assert.equal(seenTenant, tenantId);
        assert.equal(seenAgent, agent.id);
        writes.push(value);
        if (value.content === "Fail once")
          throw new Error("injected local failure");
        return {
          id: `saved-${writes.length}`,
          content: value.content,
          layer: value.layer,
        };
      },
    };

    const saved = await extractAndSaveMemories(
      { modelRouter: router, memoryStore: store as never },
      input(resolved("builtin")),
    );
    assert.deepEqual(
      writes.map((value) => value.content),
      ["New Preference", "Fail once", "Survives"],
    );
    assert.deepEqual(writes[0], {
      content: "New Preference",
      layer: "preference",
      importance: 4,
      tags: ["ui"],
      source: "auto",
      providerId: "provider-builtin",
    });
    assert.deepEqual(saved, [
      { id: "saved-1", content: "New Preference", layer: "preference" },
      { id: "saved-3", content: "Survives", layer: "project" },
    ]);
    assert.equal(calls.length, 1);
    const [seenTenant, , options] = calls[0]!;
    assert.equal(seenTenant, tenantId);
    assert.deepEqual(options, { capability: "chat", alias: "memory-model" });
  });

  it("reports an all-failed local batch instead of presenting it as an empty extraction", async () => {
    const { router } = routerFor([
      { content: "Cannot persist", layer: "fact" },
    ]);
    const store = {
      list: async () => [],
      add: async () => {
        throw new Error("local store unavailable");
      },
    };
    await assert.rejects(
      extractAndSaveMemories(
        { modelRouter: router, memoryStore: store as never },
        input(resolved("traditional")),
      ),
      (error: unknown) => {
        assert.ok(error instanceof AggregateError);
        assert.equal(error.errors.length, 1);
        assert.match(String(error.errors[0]), /local store unavailable/);
        return true;
      },
    );
  });

  it("uses mem0 list/add only, deduplicates its user namespace, and continues after one HTTP failure", async () => {
    const { router } = routerFor([
      { content: "Existing Remote", layer: "fact" },
      { content: "Remote New", layer: "preference" },
      { content: " remote   new ", layer: "fact" },
      { content: "Remote Fail", layer: "episode" },
      { content: "Remote Survives" },
    ]);
    const originalFetch = globalThis.fetch;
    const posts: Array<Record<string, unknown>> = [];
    let listCalls = 0;
    globalThis.fetch = (async (
      request: string | URL | Request,
      init?: RequestInit,
    ) => {
      const url = String(request);
      const method = String(init?.method ?? "GET").toUpperCase();
      assert.match(url, /^https:\/\/mem0\.example\.test\/v1\/memories/);
      assert.equal(
        (init?.headers as Record<string, string>)?.Authorization,
        "Bearer mem0-token",
      );
      if (method === "GET") {
        listCalls += 1;
        const parsed = new URL(url);
        assert.equal(parsed.searchParams.get("agent_id"), agent.id);
        assert.equal(parsed.searchParams.get("user_id"), "memory-user");
        assert.equal(parsed.searchParams.get("limit"), "500");
        return Response.json({
          results: [{ id: "existing", memory: " existing remote " }],
        });
      }
      const body = JSON.parse(String(init?.body ?? "{}")) as Record<
        string,
        unknown
      >;
      posts.push(body);
      const content =
        (body.messages as Array<{ content: string }>)[0]?.content ?? "";
      if (content === "Remote Fail") {
        return Response.json(
          { error: "injected remote failure" },
          { status: 503 },
        );
      }
      return Response.json({ results: [{ id: `remote-${posts.length}` }] });
    }) as typeof fetch;

    try {
      const saved = await extractAndSaveMemories(
        { modelRouter: router, memoryStore: null },
        input(
          resolved("mem0", {
            baseUrl: "https://mem0.example.test/",
            apiKey: "mem0-token",
            defaultUserId: "memory-user",
          }),
        ),
      );
      assert.equal(listCalls, 1);
      assert.deepEqual(
        posts.map(
          (body) => (body.messages as Array<{ content: string }>)[0]!.content,
        ),
        ["Remote New", "Remote Fail", "Remote Survives"],
      );
      assert.ok(
        posts.every(
          (body) =>
            body.agent_id === agent.id && body.user_id === "memory-user",
        ),
      );
      assert.deepEqual(posts[0]!.metadata, {
        source: "auto",
        layer: "preference",
      });
      assert.deepEqual(saved, [
        { id: "remote-1", content: "Remote New", layer: "preference" },
        { id: "remote-3", content: "Remote Survives", layer: undefined },
      ]);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not spend a model call when the resolved provider has no supported write sink", async () => {
    const { router, calls } = routerFor([{ content: "Should not run" }]);
    assert.deepEqual(
      await extractAndSaveMemories(
        { modelRouter: router, memoryStore: null },
        input(
          resolved("openviking", {
            baseUrl: "https://openviking.example.test",
          }),
        ),
      ),
      [],
    );
    assert.deepEqual(
      await extractAndSaveMemories(
        { modelRouter: router, memoryStore: null },
        input(resolved("builtin")),
      ),
      [],
    );
    assert.equal(calls.length, 0);
  });
});
