import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { after, before, describe, it } from "node:test";
import type { AddressInfo } from "node:net";
import type { InstanceHandle } from "@zakura/core";
import { connectorJson } from "../src/providers/connector-http.js";
import { createOauthRestProvider, restJson } from "../src/providers/oauth-rest.js";

describe("connector HTTP lifecycle", () => {
  let server: Server;
  let baseUrl = "";
  const hits = new Map<string, number>();

  before(async () => {
    server = createServer(async (request, response) => {
      const path = new URL(request.url ?? "/", "http://fake").pathname;
      hits.set(path, (hits.get(path) ?? 0) + 1);
      if (path === "/retry" && hits.get(path) === 1) {
        response.writeHead(503, { "content-type": "application/json", "retry-after": "0" });
        response.end('{"error":"busy"}');
        return;
      }
      if (path === "/always-fails") {
        response.writeHead(503, { "content-type": "application/json" });
        response.end('{"error":"busy"}');
        return;
      }
      if (path === "/slow" || path === "/dedupe") {
        await new Promise((resolve) => setTimeout(resolve, path === "/slow" ? 200 : 30));
      }
      if (path === "/token") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end('{"access_token":"fresh-token","refresh_token":"fresh-refresh","expires_in":3600}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        ok: true,
        authorization: request.headers.authorization ?? null,
        privateToken: request.headers["private-token"] ?? null,
      }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  });

  it("retries a safe transient request and preserves auth", async () => {
    const result = await connectorJson<{ authorization: string }>(`${baseUrl}/retry`, "secret", {
      retry: { attempts: 3, baseDelayMs: 1, maxDelayMs: 2 },
    });
    assert.equal(result.authorization, "Bearer secret");
    assert.equal(hits.get("/retry"), 2);
  });

  it("deduplicates concurrent GETs only within the same credential scope", async () => {
    const first = Array.from({ length: 8 }, () => restJson(`${baseUrl}/dedupe`, "tenant-a"));
    const second = Array.from({ length: 3 }, () => restJson(`${baseUrl}/dedupe`, "tenant-b"));
    await Promise.all([...first, ...second]);
    assert.equal(hits.get("/dedupe"), 2);
  });

  it("does not retry an unsafe mutation without an idempotency key", async () => {
    await assert.rejects(
      connectorJson(`${baseUrl}/always-fails`, "secret", {
        method: "POST",
        json: { value: 1 },
        retry: { attempts: 4, baseDelayMs: 1 },
      }),
      /503/,
    );
    assert.equal(hits.get("/always-fails"), 1);
  });

  it("propagates caller cancellation", async () => {
    const controller = new AbortController();
    const request = connectorJson(`${baseUrl}/slow`, "secret", {
      signal: controller.signal,
      retry: { attempts: 3, baseDelayMs: 1 },
    });
    setTimeout(() => controller.abort(new Error("cancelled by test")), 10);
    await assert.rejects(request, /cancelled by test/);
  });

  it("deduplicates refresh and persists it before connector calls continue", async () => {
    let persistenceWrites = 0;
    const db = {
      update() {
        return {
          set() {
            return {
              async where() {
                persistenceWrites++;
              },
            };
          },
        };
      },
    };
    const factory = createOauthRestProvider({
      id: "fake",
      name: "Fake",
      description: "fake connector",
      products: ["items"],
      toolDefs: { items: [{ name: "read", inputSchema: { type: "object" } }] },
      callTool: async (_product, _name, token) => ({ token, persisted: persistenceWrites }),
    });
    factory.injectRuntime({ secret: "01234567890123456789012345678901" } as never, db);
    const handle: InstanceHandle = {
      id: "instance-1",
      tenantId: "tenant-1",
      providerId: "fake",
      name: "Fake",
      slug: "fake",
      containers: {},
      config: {
        product: "items",
        oauthAccessToken: "expired",
        oauthRefreshToken: "refresh",
        oauthExpiresAt: 1,
        oauthClientId: "client",
        oauthTokenEndpoint: `${baseUrl}/token`,
      },
    };
    const provider = factory.createProvider();
    const [left, right] = await Promise.all([
      provider.callTool(handle, "read", {}),
      provider.callTool(handle, "read", {}),
    ]);
    assert.equal(hits.get("/token"), 1);
    assert.equal(persistenceWrites, 1);
    assert.match(JSON.stringify(left), /fresh-token/);
    assert.match(JSON.stringify(right), /fresh-token/);
  });
});

