import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import type { InstanceHandle } from "@zakura/core";
import { createGithubProvider } from "../src/providers/github/index.js";
import { createSlackProvider } from "../src/providers/slack/index.js";

function handle(providerId: string, product: string): InstanceHandle {
  return {
    id: `${providerId}-${product}`,
    tenantId: "tenant-fake",
    providerId,
    name: providerId,
    slug: `${providerId}-${product}`,
    containers: {},
    config: { product, oauthAccessToken: `${providerId}-token`, oauthExpiresAt: 4_102_444_800 },
  };
}

function output(result: Awaited<ReturnType<ReturnType<typeof createGithubProvider>["callTool"]>>) {
  const block = result.content[0];
  assert.equal(block?.type, "text");
  return JSON.parse(block.type === "text" ? block.text : "{}") as Record<string, unknown>;
}

describe("provider mappings against local fake transports", () => {
  let server: Server;
  let baseUrl = "";
  let originalFetch: typeof fetch;
  const requests: Array<{ path: string; method: string; auth: string; body: string }> = [];
  let githubListAttempts = 0;

  before(async () => {
    server = createServer(async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body = Buffer.concat(chunks).toString("utf8");
      requests.push({
        path: request.url ?? "",
        method: request.method ?? "GET",
        auth: String(request.headers.authorization ?? ""),
        body,
      });
      if (request.url?.startsWith("/github/user/repos") && ++githubListAttempts === 1) {
        response.writeHead(503, { "content-type": "application/json", "retry-after": "0" });
        response.end('{"message":"busy"}');
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      if (request.url?.startsWith("/slack/")) response.end('{"ok":true,"items":[{"id":"C1"}]}');
      else response.end(JSON.stringify({ ok: true, path: request.url, body: body ? JSON.parse(body) : null }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    originalFetch = globalThis.fetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const original = new URL(input instanceof Request ? input.url : input.toString());
      if (original.hostname === "api.github.com") {
        return originalFetch(`${baseUrl}/github${original.pathname}${original.search}`, init);
      }
      if (original.hostname === "slack.com") {
        return originalFetch(`${baseUrl}/slack${original.pathname}${original.search}`, init);
      }
      throw new Error(`Unexpected external request in provider test: ${original}`);
    }) as typeof fetch;
  });

  after(async () => {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  });

  it("maps GitHub reads and mutations, retrying only the safe read", async () => {
    const provider = createGithubProvider();
    const repos = output(await provider.callTool(handle("github", "repos"), "list_repos", {
      visibility: "private",
      per_page: 5,
    }));
    assert.equal(repos.ok, true);
    assert.equal(githubListAttempts, 2);

    const created = output(await provider.callTool(handle("github", "issues"), "create_issue", {
      owner: "acme",
      repo: "demo",
      title: "Fake issue",
      body: "No external side effect",
    }));
    assert.equal(created.ok, true);
    const mutation = requests.find((request) => request.path === "/github/repos/acme/demo/issues");
    assert.equal(mutation?.method, "POST");
    assert.equal(mutation?.auth, "Bearer github-token");
    assert.deepEqual(JSON.parse(mutation?.body ?? "{}"), {
      title: "Fake issue",
      body: "No external side effect",
    });
  });

  it("maps Slack query and post payloads and checks Slack's logical ok field", async () => {
    const provider = createSlackProvider();
    const channels = output(await provider.callTool(handle("slack", "channels"), "list_channels", {
      types: "public_channel",
      limit: 10,
    }));
    assert.equal(channels.ok, true);
    const listed = requests.find((request) => request.path.includes("/slack/api/conversations.list"));
    assert.match(listed?.path ?? "", /types=public_channel/);
    assert.equal(listed?.auth, "Bearer slack-token");

    const posted = output(await provider.callTool(handle("slack", "messages"), "post_message", {
      channel: "C1",
      text: "local fake only",
      thread_ts: "123.4",
    }));
    assert.equal(posted.ok, true);
    const mutation = requests.find((request) => request.path === "/slack/api/chat.postMessage");
    assert.deepEqual(JSON.parse(mutation?.body ?? "{}"), {
      channel: "C1",
      text: "local fake only",
      thread_ts: "123.4",
    });
  });
});

