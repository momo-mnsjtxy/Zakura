import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, afterEach, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { registerBuiltinModelAdapters } from "../src/model-router/index.js";
import { setRouteHydrator } from "../src/model-router/oauth-hook.js";
import { RouteResolver } from "../src/model-router/resolver.js";
import { ModelRouterService } from "../src/services/model-router.js";
import {
  ModelUpstreamAuthService,
  type JsonHttp,
} from "../src/services/model-upstream-auth/index.js";
import { encryptTokens } from "../src/services/model-upstream-auth/tokens.js";

registerBuiltinModelAdapters();

describe("stored model route to gateway workflow", () => {
  let root = "";
  let db: import("../src/db/client.js").Db;
  let close: () => Promise<void>;
  let schema: typeof import("../src/db/schema.js");
  const tenantA = "model-workflow-a";
  const tenantB = "model-workflow-b";

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "zakura-model-route-workflow-"));
    const databaseUrl = `pglite:${join(root, "db")}`;
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(databaseUrl);
    const opened = await (await import("../src/db/client.js")).createDb({
      databaseUrl,
      dataDir: root,
    });
    db = opened.db;
    close = opened.close;
    schema = await import("../src/db/schema.js");
    const now = new Date();
    await db.insert(schema.tenants).values([
      { id: tenantA, slug: tenantA, name: "Model A", createdAt: now, updatedAt: now },
      { id: tenantB, slug: tenantB, name: "Model B", createdAt: now, updatedAt: now },
    ]);
  });

  afterEach(() => {
    setRouteHydrator(undefined);
    globalThis.fetch = originalFetch;
  });

  after(async () => {
    await close?.();
    rmSync(root, { recursive: true, force: true });
  });

  const originalFetch = globalThis.fetch;

  async function insertRoute(input: {
    tenantId: string;
    upstreamId: string;
    modelId: string;
    protocol: string;
    config: Record<string, unknown>;
    nativeModel: string;
    canonicalModel: string;
    options?: Record<string, unknown>;
    meta?: Record<string, unknown>;
    isDefault?: boolean;
  }) {
    const now = new Date();
    await db.insert(schema.modelUpstreams).values({
      id: input.upstreamId,
      tenantId: input.tenantId,
      name: input.upstreamId,
      slug: input.upstreamId,
      protocol: input.protocol,
      configJson: JSON.stringify(input.config),
      createdAt: now,
      updatedAt: now,
    });
    await db.insert(schema.upstreamModels).values({
      id: input.modelId,
      tenantId: input.tenantId,
      upstreamId: input.upstreamId,
      nativeModel: input.nativeModel,
      canonicalModel: input.canonicalModel,
      capability: "chat",
      isDefault: input.isDefault ?? false,
      optionsJson: JSON.stringify(input.options ?? {}),
      metaJson: JSON.stringify(input.meta ?? {}),
      createdAt: now,
      updatedAt: now,
    });
  }

  it("resolves tenant-scoped alias/routeId/options and invalidates stored config", async () => {
    await insertRoute({
      tenantId: tenantA,
      upstreamId: "upstream-a",
      modelId: "model-a",
      protocol: "openai",
      config: { baseUrl: "https://old.invalid/v1", apiKey: "a-key" },
      nativeModel: "native-a",
      canonicalModel: "logical-shared",
      isDefault: true,
      options: {
        temperature: 0.2,
        maxTokens: 321,
        reasoning: { effort: "high", summary: "concise" },
      },
      meta: {
        source: "models.dev",
        providerId: "openai",
        providerName: "OpenAI",
        modelId: "native-a",
        name: "Native A",
        capabilities: ["chat"],
        contextLimit: 64_000,
      },
    });
    await insertRoute({
      tenantId: tenantB,
      upstreamId: "upstream-b",
      modelId: "model-b",
      protocol: "openai",
      config: { baseUrl: "https://tenant-b.invalid/v1", apiKey: "b-key" },
      nativeModel: "native-b",
      canonicalModel: "logical-shared",
    });

    const resolver = new RouteResolver(db);
    const a = await resolver.resolveChain(tenantA, {
      capability: "chat",
      alias: "logical-shared",
    });
    assert.equal(a.length, 1);
    assert.equal(a[0]?.model, "native-a");
    assert.equal(a[0]?.upstream.id, "upstream-a");
    assert.deepEqual(a[0]?.options, {
      temperature: 0.2,
      maxTokens: 321,
      reasoning: { effort: "high", summary: "concise" },
    });
    assert.equal(a[0]?.meta?.contextLimit, 64_000);
    assert.equal(
      (await resolver.resolveChain(tenantB, {
        capability: "chat",
        alias: "logical-shared",
      }))[0]?.upstream.id,
      "upstream-b",
    );
    assert.equal(
      (await resolver.resolveChain(tenantA, {
        capability: "chat",
        routeId: "model-a",
      }))[0]?.model,
      "native-a",
    );

    const row = await db.query.modelUpstreams.findFirst({
      where: eq(schema.modelUpstreams.id, "upstream-a"),
    });
    await db.update(schema.modelUpstreams).set({
      configJson: JSON.stringify({
        ...JSON.parse(row!.configJson),
        baseUrl: "https://new.invalid/v1",
      }),
    }).where(eq(schema.modelUpstreams.id, "upstream-a"));
    assert.equal(
      (await resolver.resolveChain(tenantA, {
        capability: "chat",
        alias: "logical-shared",
      }))[0]?.upstream.config.baseUrl,
      "https://old.invalid/v1",
    );
    resolver.invalidateTenant(tenantA);
    assert.equal(
      (await resolver.resolveChain(tenantA, {
        capability: "chat",
        alias: "logical-shared",
      }))[0]?.upstream.config.baseUrl,
      "https://new.invalid/v1",
    );
  });

  it("invalidates login/logout state so the next routed call sees it", async () => {
    await insertRoute({
      tenantId: tenantA,
      upstreamId: "claude-auth-upstream",
      modelId: "claude-auth-model",
      protocol: "claude-code",
      config: { baseUrl: "https://anthropic.invalid/v1" },
      nativeModel: "claude-fake",
      canonicalModel: "claude-auth",
    });
    const resolver = new RouteResolver(db);
    const router = new ModelRouterService(db, resolver);
    const auth = new ModelUpstreamAuthService(
      db,
      "test-secret",
      undefined,
      (tenantId) => router.invalidateCache(tenantId),
    );
    setRouteHydrator((value, options) => auth.hydrateRoute(value, options));

    const cachedBeforeLogin = await resolver.resolveChain(tenantA, {
      capability: "chat",
      alias: "claude-auth",
    });
    assert.equal(cachedBeforeLogin[0]?.upstream.config.oauthEnc, undefined);
    await auth.submit(tenantA, "claude-auth-upstream", {
      setupToken: "sk-ant-oat-test",
    });

    let requests = 0;
    globalThis.fetch = (async (_input, init) => {
      requests += 1;
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer sk-ant-oat-test");
      return new Response([
        'data: {"type":"message_start","message":{"model":"claude-fake"}}',
        'data: {"type":"content_block_start","index":0,"content_block":{"type":"text"}}',
        'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"logged in"}}',
        'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}',
        "data: [DONE]",
        "",
      ].join("\n\n"), { status: 200, headers: { "content-type": "text/event-stream" } });
    }) as typeof fetch;
    const result = await router.chatStream(
      tenantA,
      [{ role: "user", content: "hello" }],
      { capability: "chat", alias: "claude-auth" },
      undefined,
      {},
    );
    assert.equal(result.content, "logged in");
    assert.equal(requests, 1);

    await auth.logout(tenantA, "claude-auth-upstream");
    await assert.rejects(
      router.chatStream(
        tenantA,
        [{ role: "user", content: "hello again" }],
        { capability: "chat", alias: "claude-auth" },
        undefined,
        {},
      ),
      /尚未登录订阅/,
    );
    assert.equal(requests, 1);
  });

  it("persists a rotated refresh token before the next cached route call", async () => {
    const secret = "test-secret";
    const expired = encryptTokens(secret, {
      access_token: "expired-access",
      refresh_token: "old-refresh",
      expires_at: Date.now() - 1,
    });
    await insertRoute({
      tenantId: tenantA,
      upstreamId: "codex-refresh-upstream",
      modelId: "codex-refresh-model",
      protocol: "codex",
      config: { baseUrl: "https://chatgpt.invalid", oauthEnc: expired },
      nativeModel: "gpt-fake",
      canonicalModel: "codex-refresh",
    });
    let refreshes = 0;
    const http: JsonHttp = {
      async postJson(url, body) {
        assert.match(url, /\/oauth\/token$/);
        assert.equal((body as Record<string, unknown>).refresh_token, "old-refresh");
        refreshes += 1;
        return {
          status: 200,
          json: {
            access_token: "fresh-access",
            refresh_token: "rotated-refresh",
            expires_in: 3600,
          },
        };
      },
      async getJson() {
        return { status: 404, json: null };
      },
      async postForm() {
        return { status: 404, json: null };
      },
    };
    const resolver = new RouteResolver(db);
    const router = new ModelRouterService(db, resolver);
    const auth = new ModelUpstreamAuthService(
      db,
      secret,
      http,
      (tenantId) => router.invalidateCache(tenantId),
    );
    setRouteHydrator((value, options) => auth.hydrateRoute(value, options));
    const authorizations: string[] = [];
    globalThis.fetch = (async (_input, init) => {
      authorizations.push(new Headers(init?.headers).get("authorization") ?? "");
      return new Response(JSON.stringify({
        model: "gpt-fake",
        output: [{
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "ok" }],
        }],
      }), { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof fetch;

    for (let index = 0; index < 2; index += 1) {
      const result = await router.chat(
        tenantA,
        [{ role: "user", content: `call ${index}` }],
        { capability: "chat", alias: "codex-refresh" },
      );
      assert.equal(result.content, "ok");
    }
    assert.equal(refreshes, 1);
    assert.deepEqual(authorizations, ["Bearer fresh-access", "Bearer fresh-access"]);
  });
});
