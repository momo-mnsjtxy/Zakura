import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { InstanceHandle, ProviderPlugin } from "@zakura/core";
import { createGitlabProvider } from "../src/providers/gitlab/index.js";
import { createJiraProvider } from "../src/providers/jira/index.js";
import { createLinearProvider } from "../src/providers/linear/index.js";
import { createNotionProvider } from "../src/providers/notion/index.js";
import { createDiscordProvider } from "../src/providers/discord/index.js";
import { createFeishuProvider } from "../src/providers/feishu/index.js";
import { createGoogleWorkspaceProvider, injectGoogleWorkspaceRuntime } from "../src/providers/google-workspace/index.js";
import { createMicrosoft365Provider, injectMicrosoft365Runtime } from "../src/providers/microsoft-365/index.js";
import { createEmailProvider } from "../src/providers/email/index.js";

type Seen = { url: string; method: string; headers: Headers; body: string };
const seen: Seen[] = [];
const hits = new Map<string, number>();
let originalFetch: typeof fetch;
let persistedRefreshes = 0;
let minimumRefreshesBeforeApi = 0;

function handle(providerId: string, product: string, extra: Record<string, unknown> = {}): InstanceHandle {
  return {
    id: `${providerId}-${product}`, tenantId: "tenant-1", providerId,
    name: product, slug: product,
    config: { product, oauthAccessToken: `${providerId}-token`, oauthExpiresAt: 4_102_444_800, ...extra },
    containers: {},
  };
}

function textOf(result: Awaited<ReturnType<ProviderPlugin["callTool"]>>): string {
  const first = result.content[0];
  return first?.type === "text" ? first.text : "";
}

function jsonOf(result: Awaited<ReturnType<ProviderPlugin["callTool"]>>): unknown {
  return JSON.parse(textOf(result));
}

describe("remaining connector providers against deterministic fake transports", () => {
  before(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = String(init?.method ?? "GET").toUpperCase();
      const headers = new Headers(init?.headers);
      const body = typeof init?.body === "string" ? init.body : init?.body instanceof URLSearchParams ? init.body.toString() : "";
      seen.push({ url, method, headers, body });
      const key = `${method} ${url}`;
      hits.set(key, (hits.get(key) ?? 0) + 1);

      if (url.includes("oauth2.test/token")) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        return Response.json({ access_token: "refreshed-token", refresh_token: "next-refresh", expires_in: 3600 });
      }

      if (url.endsWith("/oauth/token/accessible-resources")) {
        return Response.json([{ id: "cloud-1", url: "https://acme.atlassian.net" }]);
      }
      if (url.includes("api.atlassian.com/ex/jira/cloud-1/")) return Response.json({ ok: true, url });
      if (url.includes("api.linear.app/graphql")) {
        const parsed = JSON.parse(body) as { variables?: { input?: { title?: string } } };
        if (parsed.variables?.input?.title === "fail") {
          return Response.json({ errors: [{ message: "validation failed" }] });
        }
        return Response.json({ data: { ok: true } });
      }
      if (url.includes("open.feishu.cn")) {
        if (body.includes("bad")) return Response.json({ code: 230001, msg: "permission denied" });
        return Response.json({ code: 0, data: { message_id: "m-1" } });
      }
      if (url.includes("people.googleapis.com")) {
        if (persistedRefreshes < minimumRefreshesBeforeApi) throw new Error("Google API used before refresh persistence");
        return Response.json({ names: [{ displayName: "Ada" }], emailAddresses: [{ value: "ada@example.test" }] });
      }
      if (url.includes("graph.microsoft.com")) {
        if (persistedRefreshes < minimumRefreshesBeforeApi) throw new Error("Graph API used before refresh persistence");
        return Response.json({ id: "graph-1", value: [] });
      }
      if (url.includes("api.resend.test")) return Response.json({ id: "email-1" });
      return Response.json({ ok: true, url, method, body: body ? JSON.parse(body) : undefined });
    }) as typeof fetch;
  });

  after(() => { globalThis.fetch = originalFetch; });

  it("maps GitLab mutations with encoded project paths and bearer auth", async () => {
    const result = await createGitlabProvider().callTool(
      handle("gitlab", "issues"), "create_issue",
      { project_id: "org/private repo", title: "Bug", description: "Details" },
    );
    assert.equal(result.isError, false);
    const request = seen.at(-1)!;
    assert.match(request.url, /projects\/org%2Fprivate%20repo\/issues$/);
    assert.equal(request.method, "POST");
    assert.equal(request.headers.get("authorization"), "Bearer gitlab-token");
    assert.equal((JSON.parse(request.body) as { title: string }).title, "Bug");
  });

  it("coalesces Jira cloud discovery per credential", async () => {
    const provider = createJiraProvider();
    const token = "jira-breadth-unique";
    const [projects, myself] = await Promise.all([
      provider.callTool(handle("jira", "projects", { oauthAccessToken: token }), "list_projects", {}),
      provider.callTool(handle("jira", "projects", { oauthAccessToken: token }), "get_myself", {}),
    ]);
    assert.equal(projects.isError, false);
    assert.equal(myself.isError, false);
    const resourceHits = [...hits.entries()].filter(([key]) => key.includes("accessible-resources"));
    assert.equal(resourceHits.reduce((sum, [, count]) => sum + count, 0), 1);
  });

  it("turns Linear HTTP-200 GraphQL errors into tool errors", async () => {
    const provider = createLinearProvider();
    const failed = await provider.callTool(
      handle("linear", "issues"), "create_issue", { title: "fail", teamId: "team-1" },
    );
    assert.equal(failed.isError, true);
    assert.match(textOf(failed), /validation failed/);
    const ok = await provider.callTool(handle("linear", "teams"), "viewer", {});
    assert.deepEqual(jsonOf(ok), { data: { ok: true } });
  });

  it("preserves Notion version headers and request bodies", async () => {
    const result = await createNotionProvider().callTool(
      handle("notion", "pages"), "search", { query: "roadmap", page_size: 7 },
    );
    assert.equal(result.isError, false);
    const request = seen.at(-1)!;
    assert.equal(request.headers.get("notion-version"), "2022-06-28");
    assert.deepEqual(JSON.parse(request.body), { query: "roadmap", page_size: 7 });
  });

  it("bounds Discord list calls and authenticates user requests", async () => {
    const result = await createDiscordProvider().callTool(
      handle("discord", "guilds"), "list_guilds", { limit: "invalid" },
    );
    assert.equal(result.isError, false);
    const request = seen.at(-1)!;
    assert.match(request.url, /limit=100$/);
    assert.equal(request.headers.get("authorization"), "Bearer discord-token");
  });

  it("turns Feishu logical errors into tool errors and encodes messages", async () => {
    const provider = createFeishuProvider();
    const failed = await provider.callTool(
      handle("feishu", "im"), "send_message", { receive_id: "chat-1", text: "bad" },
    );
    assert.equal(failed.isError, true);
    assert.match(textOf(failed), /230001/);
    const ok = await provider.callTool(
      handle("feishu", "im"), "send_message", { receive_id: "chat-1", text: "hello" },
    );
    assert.equal(ok.isError, false);
    const payload = JSON.parse(seen.at(-1)!.body) as { content: string };
    assert.deepEqual(JSON.parse(payload.content), { text: "hello" });
  });

  it("maps Google Workspace and Microsoft Graph reads without leaking tokens", async () => {
    const google = await createGoogleWorkspaceProvider().callTool(
      handle("google-workspace", "people"), "get_user_profile", {},
    );
    assert.deepEqual(jsonOf(google), { name: "Ada", emailAddress: "ada@example.test" });
    const microsoft = await createMicrosoft365Provider().callTool(
      handle("microsoft-365", "directory"), "get_my_profile", {},
    );
    assert.deepEqual(jsonOf(microsoft), { id: "graph-1", value: [] });
    assert.equal(seen.some((request) => request.url.includes("google-workspace-token")), false);
    assert.equal(seen.some((request) => request.url.includes("microsoft-365-token")), false);
  });

  it("coalesces Google and Microsoft refreshes and persists before API use", async () => {
    persistedRefreshes = 0;
    const db = {
      update: () => ({
        set: () => ({ where: async () => { persistedRefreshes++; } }),
      }),
    };
    const appConfig = { secret: "provider-refresh-secret", dataDir: "/tmp" } as never;
    injectGoogleWorkspaceRuntime(appConfig, db);
    injectMicrosoft365Runtime(appConfig, db);

    const googleHandle = handle("google-workspace", "people", {
      oauthAccessToken: "", oauthRefreshToken: "google-refresh", oauthClientId: "google-client",
      oauthTokenEndpoint: "https://oauth2.test/token/google", oauthExpiresAt: 0,
    });
    const googleProvider = createGoogleWorkspaceProvider();
    minimumRefreshesBeforeApi = 1;
    const googleTokenBefore = [...hits.entries()].filter(([key]) => key.includes("/token/google"))
      .reduce((sum, [, count]) => sum + count, 0);
    const googleResults = await Promise.all([
      googleProvider.callTool(googleHandle, "get_user_profile", {}),
      googleProvider.callTool(googleHandle, "get_user_profile", {}),
    ]);
    assert.ok(googleResults.every((result) => !result.isError));
    const googleTokenAfter = [...hits.entries()].filter(([key]) => key.includes("/token/google"))
      .reduce((sum, [, count]) => sum + count, 0);
    assert.equal(googleTokenAfter - googleTokenBefore, 1);

    const microsoftHandle = handle("microsoft-365", "directory", {
      oauthAccessToken: "", oauthRefreshToken: "microsoft-refresh", oauthClientId: "microsoft-client",
      oauthTokenEndpoint: "https://oauth2.test/token/microsoft", oauthExpiresAt: 0,
    });
    const microsoftProvider = createMicrosoft365Provider();
    minimumRefreshesBeforeApi = 2;
    const microsoftTokenBefore = [...hits.entries()].filter(([key]) => key.includes("/token/microsoft"))
      .reduce((sum, [, count]) => sum + count, 0);
    const microsoftResults = await Promise.all([
      microsoftProvider.callTool(microsoftHandle, "get_my_profile", {}),
      microsoftProvider.callTool(microsoftHandle, "get_my_profile", {}),
    ]);
    assert.ok(microsoftResults.every((result) => !result.isError));
    const microsoftTokenAfter = [...hits.entries()].filter(([key]) => key.includes("/token/microsoft"))
      .reduce((sum, [, count]) => sum + count, 0);
    assert.equal(microsoftTokenAfter - microsoftTokenBefore, 1);
    assert.equal(persistedRefreshes, 2);
    assert.equal(googleHandle.config.oauthAccessToken, "refreshed-token");
    assert.equal(microsoftHandle.config.oauthAccessToken, "refreshed-token");
    minimumRefreshesBeforeApi = 0;
  });

  it("maps Resend payloads through the shared mutation transport", async () => {
    const email = createEmailProvider();
    const result = await email.callTool(
      handle("email", "resendapi", {
        apiToken: "resend-secret", baseUrl: "https://api.resend.test/emails",
        fromEmail: "bot@example.test",
      }),
      "send_email",
      { to: ["person@example.test"], subject: "Hello", text: "Body" },
    );
    assert.deepEqual(jsonOf(result), { id: "email-1" });
    const request = seen.at(-1)!;
    assert.equal(request.method, "POST");
    assert.equal(request.headers.get("authorization"), "Bearer resend-secret");
    assert.equal((JSON.parse(request.body) as { from: string }).from, "bot@example.test");
  });
});
