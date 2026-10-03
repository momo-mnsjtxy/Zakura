import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CloudflareAdminClient } from "../src/services/cloudflare-admin.js";
import { HeadscaleAdminClient } from "../src/services/headscale-admin.js";
import { TailscaleAdminClient } from "../src/services/tailscale-admin.js";

type SeenRequest = { url: string; method: string; authorization: string | null; body: string };

function bodyText(init?: RequestInit): string {
  if (typeof init?.body === "string") return init.body;
  if (init?.body instanceof URLSearchParams) return init.body.toString();
  return "";
}

function seenRequest(input: string | URL | Request, init?: RequestInit): SeenRequest {
  const headers = new Headers(init?.headers);
  return {
    url: String(input),
    method: init?.method ?? "GET",
    authorization: headers.get("authorization"),
    body: bodyText(init),
  };
}

describe("network provider clients with fake control planes", () => {
  it("isolates Headscale tenant users and handles a create race", async () => {
    const seen: SeenRequest[] = [];
    let listCalls = 0;
    const fakeFetch: typeof fetch = async (input, init) => {
      const req = seenRequest(input, init);
      seen.push(req);
      if (req.method === "GET" && req.url.includes("/user?name=")) {
        listCalls += 1;
        return Response.json(
          listCalls === 1 ? { users: [] } : { users: [{ id: "u-tenant", name: "tenant-acme@" }] },
        );
      }
      if (req.method === "GET" && req.url.endsWith("/user")) {
        return Response.json({ users: [] });
      }
      if (req.method === "POST" && req.url.endsWith("/user")) {
        return Response.json({ message: "already exists" }, { status: 409 });
      }
      if (req.method === "POST" && req.url.endsWith("/preauthkey")) {
        return Response.json({
          preAuthKey: {
            id: "key-1",
            key: "tskey-auth-fake",
            reusable: true,
            ephemeral: false,
            used: false,
            aclTags: [],
          },
        });
      }
      throw new Error(`unexpected Headscale request ${req.method} ${req.url}`);
    };
    const client = new HeadscaleAdminClient({
      url: "https://headscale.test/",
      apiKey: "headscale-secret",
      fetch: fakeFetch,
    });

    const key = await client.createTenantPreAuthKey("Acme");
    assert.equal(key.key, "tskey-auth-fake");
    assert.ok(seen.every((req) => req.authorization === "Bearer headscale-secret"));
    const createKey = seen.find((req) => req.url.endsWith("/preauthkey"));
    assert.deepEqual(JSON.parse(createKey!.body), {
      reusable: true,
      ephemeral: false,
      expiration: JSON.parse(createKey!.body).expiration,
      user: "u-tenant",
    });
  });

  it("refreshes Tailscale OAuth once and sends normalized tags to key creation", async () => {
    const seen: SeenRequest[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const req = seenRequest(input, init);
      seen.push(req);
      if (req.url === "https://control.test/oauth/token") {
        return Response.json({ access_token: "access-fake", expires_in: 3600 });
      }
      if (req.url === "https://control.test/api/tailnet/-/keys") {
        return Response.json({
          id: "key-id",
          key: "tskey-fake",
          created: "2026-01-01T00:00:00Z",
          expires: "2026-02-01T00:00:00Z",
          capabilities: { devices: { create: { reusable: true, ephemeral: false, preauthorized: true, tags: ["tag:runner"] } } },
        });
      }
      throw new Error(`unexpected Tailscale request ${req.method} ${req.url}`);
    };
    const client = new TailscaleAdminClient(
      { clientId: "client", clientSecret: "secret", tags: ["runner", "tag:runner"] },
      {
        fetch: fakeFetch,
        now: () => 1_000_000,
        tokenUrl: "https://control.test/oauth/token",
        apiBase: "https://control.test/api/",
      },
    );

    const first = await client.createAuthKey({ reusable: true });
    const second = await client.createAuthKey({ reusable: true });
    assert.equal(first.key, "tskey-fake");
    assert.equal(second.key, "tskey-fake");
    assert.equal(seen.filter((req) => req.url.endsWith("/oauth/token")).length, 1);
    assert.match(seen[0]!.body, /tags=tag%3Arunner/);
    const keyRequests = seen.filter((req) => req.url.endsWith("/tailnet/-/keys"));
    assert.equal(keyRequests.length, 2);
    assert.ok(keyRequests.every((req) => req.authorization === "Bearer access-fake"));
  });

  it("creates a Cloudflare named tunnel and fetches a missing tunnel token", async () => {
    const seen: SeenRequest[] = [];
    const fakeFetch: typeof fetch = async (input, init) => {
      const req = seenRequest(input, init);
      seen.push(req);
      if (req.method === "POST" && req.url.endsWith("/cfd_tunnel")) {
        return Response.json({ success: true, result: { id: "tunnel-1", name: "zakura" } });
      }
      if (req.method === "GET" && req.url.endsWith("/cfd_tunnel/tunnel-1/token")) {
        return Response.json({ success: true, result: "named-token-fake" });
      }
      throw new Error(`unexpected Cloudflare request ${req.method} ${req.url}`);
    };
    const client = new CloudflareAdminClient(
      { apiToken: "cloudflare-secret", accountId: "account-1" },
      { fetch: fakeFetch, apiBase: "https://cloudflare.test/client/v4/" },
    );

    assert.deepEqual(await client.createTunnel("zakura"), {
      id: "tunnel-1",
      name: "zakura",
      token: "named-token-fake",
    });
    assert.equal(seen.length, 2);
    assert.ok(seen.every((req) => req.authorization === "Bearer cloudflare-secret"));
    assert.deepEqual(JSON.parse(seen[0]!.body), { name: "zakura", config_src: "cloudflare" });
  });
});
