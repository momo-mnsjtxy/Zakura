import type { ProviderPlugin } from "@zakura/core";
import type { McpToolDef } from "@zakura/shared";
import type { AppConfig } from "../../config.js";
import { createOauthRestProvider, restJson } from "../oauth-rest.js";

type GithubProduct = "repos" | "issues" | "pulls" | "search";
const PRODUCTS: GithubProduct[] = ["repos", "issues", "pulls", "search"];

export function githubBuiltinUrl(product: GithubProduct): string {
  return `zakura://github/${product}`;
}

export function resolveGithubProduct(value: string): GithubProduct | null {
  const raw = value.trim().toLowerCase();
  if (PRODUCTS.includes(raw as GithubProduct)) return raw as GithubProduct;
  const matched = raw.match(/^zakura:\/\/github\/(repos|issues|pulls|search)$/);
  return matched ? (matched[1] as GithubProduct) : null;
}

async function ghFetch<T>(
  token: string,
  path: string,
  init?: RequestInit & { json?: unknown },
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/vnd.github+json");
  headers.set("X-GitHub-Api-Version", "2022-11-28");
  return restJson<T>(`https://api.github.com${path}`, token, {
    ...init,
    headers,
    // GitHub's GET/search calls are safe to retry; mutation calls remain one-shot
    // unless a future endpoint explicitly supplies an Idempotency-Key.
    retry: { attempts: 3, baseDelayMs: 200, maxDelayMs: 2_000 },
  });
}

const toolDefs: Record<GithubProduct, McpToolDef[]> = {
  repos: [
    { name: "list_repos", description: "List repositories for the authenticated user.", inputSchema: { type: "object", properties: { visibility: { type: "string" }, sort: { type: "string" }, per_page: { type: "integer" } } } },
    { name: "get_repo", description: "Get a repository by owner/repo.", inputSchema: { type: "object", required: ["owner", "repo"], properties: { owner: { type: "string" }, repo: { type: "string" } } } },
    { name: "list_branches", description: "List branches in a repository.", inputSchema: { type: "object", required: ["owner", "repo"], properties: { owner: { type: "string" }, repo: { type: "string" }, per_page: { type: "integer" } } } },
  ],
  issues: [
    { name: "list_issues", description: "List issues in a repository.", inputSchema: { type: "object", required: ["owner", "repo"], properties: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string" }, per_page: { type: "integer" } } } },
    { name: "get_issue", description: "Get an issue by number.", inputSchema: { type: "object", required: ["owner", "repo", "issue_number"], properties: { owner: { type: "string" }, repo: { type: "string" }, issue_number: { type: "integer" } } } },
    { name: "create_issue", description: "Create an issue.", inputSchema: { type: "object", required: ["owner", "repo", "title"], properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, body: { type: "string" } } } },
    { name: "create_issue_comment", description: "Comment on an issue.", inputSchema: { type: "object", required: ["owner", "repo", "issue_number", "body"], properties: { owner: { type: "string" }, repo: { type: "string" }, issue_number: { type: "integer" }, body: { type: "string" } } } },
  ],
  pulls: [
    { name: "list_pulls", description: "List pull requests.", inputSchema: { type: "object", required: ["owner", "repo"], properties: { owner: { type: "string" }, repo: { type: "string" }, state: { type: "string" }, per_page: { type: "integer" } } } },
    { name: "get_pull", description: "Get a pull request.", inputSchema: { type: "object", required: ["owner", "repo", "pull_number"], properties: { owner: { type: "string" }, repo: { type: "string" }, pull_number: { type: "integer" } } } },
    { name: "create_pull", description: "Create a pull request.", inputSchema: { type: "object", required: ["owner", "repo", "title", "head", "base"], properties: { owner: { type: "string" }, repo: { type: "string" }, title: { type: "string" }, head: { type: "string" }, base: { type: "string" }, body: { type: "string" } } } },
  ],
  search: [
    { name: "search_repositories", description: "Search repositories.", inputSchema: { type: "object", required: ["q"], properties: { q: { type: "string" }, per_page: { type: "integer" } } } },
    { name: "search_issues", description: "Search issues and pull requests.", inputSchema: { type: "object", required: ["q"], properties: { q: { type: "string" }, per_page: { type: "integer" } } } },
    { name: "search_code", description: "Search code across GitHub.", inputSchema: { type: "object", required: ["q"], properties: { q: { type: "string" }, per_page: { type: "integer" } } } },
  ],
};

function str(input: Record<string, unknown>, key: string): string {
  return typeof input[key] === "string" ? String(input[key]).trim() : "";
}

function int(input: Record<string, unknown>, key: string, fallback?: number): number | undefined {
  if (typeof input[key] === "number") return input[key] as number;
  if (typeof input[key] === "string" && input[key]) return Number(input[key]);
  return fallback;
}

async function callGithubTool(
  token: string,
  product: GithubProduct,
  name: string,
  input: Record<string, unknown>,
) {
  const owner = str(input, "owner");
  const repo = str(input, "repo");
  const perPage = int(input, "per_page", 30);
  if (product === "repos") {
    if (name === "list_repos") {
      const qs = new URLSearchParams();
      if (str(input, "visibility")) qs.set("visibility", str(input, "visibility"));
      if (str(input, "sort")) qs.set("sort", str(input, "sort"));
      if (perPage) qs.set("per_page", String(perPage));
      return ghFetch(token, `/user/repos?${qs}`);
    }
    if (name === "get_repo") return ghFetch(token, `/repos/${owner}/${repo}`);
    if (name === "list_branches") {
      return ghFetch(token, `/repos/${owner}/${repo}/branches?per_page=${perPage ?? 30}`);
    }
  }
  if (product === "issues") {
    if (name === "list_issues") {
      const qs = new URLSearchParams({ state: str(input, "state") || "open" });
      if (perPage) qs.set("per_page", String(perPage));
      return ghFetch(token, `/repos/${owner}/${repo}/issues?${qs}`);
    }
    if (name === "get_issue") {
      return ghFetch(token, `/repos/${owner}/${repo}/issues/${int(input, "issue_number")}`);
    }
    if (name === "create_issue") {
      return ghFetch(token, `/repos/${owner}/${repo}/issues`, {
        method: "POST",
        json: { title: str(input, "title"), body: str(input, "body") || undefined },
      });
    }
    if (name === "create_issue_comment") {
      return ghFetch(
        token,
        `/repos/${owner}/${repo}/issues/${int(input, "issue_number")}/comments`,
        { method: "POST", json: { body: str(input, "body") } },
      );
    }
  }
  if (product === "pulls") {
    if (name === "list_pulls") {
      const qs = new URLSearchParams({ state: str(input, "state") || "open" });
      if (perPage) qs.set("per_page", String(perPage));
      return ghFetch(token, `/repos/${owner}/${repo}/pulls?${qs}`);
    }
    if (name === "get_pull") {
      return ghFetch(token, `/repos/${owner}/${repo}/pulls/${int(input, "pull_number")}`);
    }
    if (name === "create_pull") {
      return ghFetch(token, `/repos/${owner}/${repo}/pulls`, {
        method: "POST",
        json: {
          title: str(input, "title"),
          head: str(input, "head"),
          base: str(input, "base"),
          body: str(input, "body") || undefined,
        },
      });
    }
  }
  if (product === "search") {
    const q = encodeURIComponent(str(input, "q"));
    const page = perPage ? `&per_page=${perPage}` : "";
    if (name === "search_repositories") return ghFetch(token, `/search/repositories?q=${q}${page}`);
    if (name === "search_issues") return ghFetch(token, `/search/issues?q=${q}${page}`);
    if (name === "search_code") return ghFetch(token, `/search/code?q=${q}${page}`);
  }
  throw new Error(`Unknown GitHub tool: ${name}`);
}

const factory = createOauthRestProvider({
  id: "github",
  name: "GitHub",
  description: "平台直接调用 GitHub REST API，提供仓库、Issues、PR 与搜索工具。",
  products: PRODUCTS,
  toolDefs,
  callTool: (product, name, token, args) =>
    callGithubTool(token, product as GithubProduct, name, args),
  health: async (token) => {
    await ghFetch(token, "/user");
  },
});

export function injectGithubRuntime(config: AppConfig, db: unknown): void {
  factory.injectRuntime(config, db);
}

export function createGithubProvider(): ProviderPlugin {
  return factory.createProvider();
}
