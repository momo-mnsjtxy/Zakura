import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { McpUpstreamOauthService } from "../src/services/mcp-upstream-oauth.js";

const publicDns = async (hostname: string) => {
  if (hostname === "private.test") return [{ address: "169.254.169.254", family: 4 }];
  return [{ address: "203.0.113.10", family: 4 }];
};

function config(multiTenant: boolean) {
  return {
    multiTenant,
    publicBaseUrl: "https://zakura.public.test",
    webPublicUrl: "https://app.public.test",
  } as never;
}

describe("MCP upstream OAuth outbound security", () => {
  it("discovers, registers, exchanges and refreshes through an injected public control plane", async () => {
    const seen: Array<{ url: string; method: string; redirect: RequestRedirect | undefined }> = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      seen.push({ url, method: init?.method ?? "GET", redirect: init?.redirect });
      if (url === "https://mcp.public.test/v1") {
        return new Response("unauthorized", {
          status: 401,
          headers: {
            "www-authenticate":
              'Bearer resource_metadata="https://mcp.public.test/oauth-resource"',
          },
        });
      }
      if (url === "https://mcp.public.test/oauth-resource") {
        return Response.json({
          resource: "https://mcp.public.test/v1",
          authorization_servers: ["https://issuer.public.test/oauth"],
          scopes_supported: ["read", "write"],
        });
      }
      if (url === "https://issuer.public.test/.well-known/oauth-authorization-server/oauth") {
        return Response.json({
          issuer: "https://issuer.public.test/oauth",
          registration_endpoint: "https://issuer.public.test/register",
          authorization_endpoint: "https://issuer.public.test/authorize",
          token_endpoint: "https://issuer.public.test/token",
          code_challenge_methods_supported: ["S256"],
        });
      }
      if (url === "https://issuer.public.test/register") {
        return Response.json({ client_id: "client-1", client_secret: "client-secret" });
      }
      if (url === "https://issuer.public.test/token") {
        const body = String(init?.body ?? "");
        if (body.includes("grant_type=refresh_token")) {
          return Response.json({ access_token: "access-2", expires_in: 120 });
        }
        return Response.json({
          access_token: "access-1",
          refresh_token: "refresh-1",
          expires_in: 60,
          token_type: "Bearer",
          scope: "read write",
        });
      }
      return new Response("missing", { status: 404 });
    };
    const service = new McpUpstreamOauthService(config(true), {
      fetch: fakeFetch,
      resolveHost: publicDns,
      now: () => 1_700_000_000_000,
      nonce: () => "v".repeat(43),
    });

    const discovery = await service.discover("https://mcp.public.test/v1");
    assert.equal(discovery.authorizationEndpoint, "https://issuer.public.test/authorize");
    assert.equal(discovery.tokenEndpoint, "https://issuer.public.test/token");
    assert.deepEqual(discovery.scopesSupported, ["read", "write"]);
    const client = await service.registerClient(discovery);
    assert.deepEqual(client, {
      clientId: "client-1",
      clientSecret: "client-secret",
      raw: { client_id: "client-1", client_secret: "client-secret" },
    });
    const authorize = service.buildAuthorizeUrl({
      discovery,
      clientId: client.clientId,
      redirectUri: "https://zakura.public.test/api/mcp/upstream-oauth/callback",
      state: "state-1",
      scope: service.resolveScope(discovery),
      resource: discovery.resource,
    });
    assert.equal(authorize.codeVerifier, "v".repeat(43));
    assert.match(authorize.url, /code_challenge_method=S256/);
    assert.equal(authorize.url.includes(authorize.codeVerifier), false);
    const exchanged = await service.exchangeCode({
      tokenEndpoint: discovery.tokenEndpoint!,
      code: "code-1",
      redirectUri: "https://zakura.public.test/api/mcp/upstream-oauth/callback",
      clientId: client.clientId,
      clientSecret: client.clientSecret,
      codeVerifier: authorize.codeVerifier,
      resource: discovery.resource,
    });
    assert.equal(exchanged.accessToken, "access-1");
    assert.equal(exchanged.expiresAt, 1_700_000_060);
    const refreshed = await service.refresh(exchanged);
    assert.equal(refreshed.accessToken, "access-2");
    assert.equal(refreshed.refreshToken, "refresh-1");
    assert.ok(seen.every((request) => request.redirect === "manual"));
  });

  it("blocks private DNS targets in multi-tenant mode before fetch", async () => {
    let fetches = 0;
    const service = new McpUpstreamOauthService(config(true), {
      fetch: async () => {
        fetches += 1;
        throw new Error("unexpected fetch");
      },
      resolveHost: async () => [{ address: "10.0.0.10", family: 4 }],
    });
    await assert.rejects(
      () => service.discover("https://private.test/mcp"),
      /private or local/,
    );
    assert.equal(fetches, 0);
  });

  it("rejects private metadata-derived authorization servers", async () => {
    const requested: string[] = [];
    const service = new McpUpstreamOauthService(config(true), {
      resolveHost: publicDns,
      fetch: async (input) => {
        const url = String(input);
        requested.push(url);
        if (url === "https://mcp.public.test/mcp") {
          return new Response(null, {
            status: 401,
            headers: {
              "www-authenticate":
                'Bearer resource_metadata="https://mcp.public.test/resource"',
            },
          });
        }
        if (url === "https://mcp.public.test/resource") {
          return Response.json({
            authorization_servers: ["https://private.test/oauth"],
          });
        }
        return new Response(null, { status: 404 });
      },
    });
    await assert.rejects(
      () => service.discover("https://mcp.public.test/mcp"),
      /authorization server resolves to a private or local address/,
    );
    assert.equal(requested.some((url) => url.includes("private.test")), false);
  });

  it("rejects a sensitive token redirect to a private address and redacts provider bodies", async () => {
    const requested: string[] = [];
    const redirecting = new McpUpstreamOauthService(config(true), {
      resolveHost: publicDns,
      fetch: async (input) => {
        const url = String(input);
        requested.push(url);
        return new Response(null, {
          status: 302,
          headers: { location: "http://169.254.169.254/latest/meta-data" },
        });
      },
    });
    await assert.rejects(
      () =>
        redirecting.exchangeCode({
          tokenEndpoint: "https://issuer.public.test/token",
          code: "secret-code",
          redirectUri: "https://zakura.public.test/callback",
          clientId: "client",
          clientSecret: "super-secret",
          codeVerifier: "v".repeat(43),
        }),
      /redirect was rejected/,
    );
    assert.deepEqual(requested, ["https://issuer.public.test/token"]);

    const failing = new McpUpstreamOauthService(config(true), {
      resolveHost: publicDns,
      fetch: async () =>
        Response.json(
          { error: "invalid_grant", error_description: "leaked-provider-secret" },
          { status: 400 },
        ),
    });
    await assert.rejects(
      () =>
        failing.exchangeCode({
          tokenEndpoint: "https://issuer.public.test/token",
          code: "code",
          redirectUri: "https://zakura.public.test/callback",
          clientId: "client",
          codeVerifier: "v".repeat(43),
        }),
      (error: unknown) =>
        error instanceof Error &&
        /HTTP 400/.test(error.message) &&
        !error.message.includes("leaked-provider-secret"),
    );
  });

  it("preserves explicit local HTTP discovery in single-tenant OSS mode", async () => {
    const service = new McpUpstreamOauthService(config(false), {
      fetch: async (input) => {
        const url = String(input);
        if (url === "http://127.0.0.1:8787/mcp") {
          return new Response(null, {
            status: 401,
            headers: {
              "www-authenticate":
                'Bearer resource_metadata="http://127.0.0.1:8787/resource"',
            },
          });
        }
        if (url === "http://127.0.0.1:8787/resource") {
          return Response.json({ authorization_servers: ["http://127.0.0.1:8787/oauth"] });
        }
        if (url === "http://127.0.0.1:8787/.well-known/oauth-authorization-server/oauth") {
          return Response.json({
            authorization_endpoint: "http://127.0.0.1:8787/authorize",
            token_endpoint: "http://127.0.0.1:8787/token",
          });
        }
        return new Response(null, { status: 404 });
      },
      resolveHost: async () => {
        throw new Error("OSS local mode should not require public DNS");
      },
    });
    const discovery = await service.discover("http://127.0.0.1:8787/mcp");
    assert.equal(discovery.tokenEndpoint, "http://127.0.0.1:8787/token");
  });
});
