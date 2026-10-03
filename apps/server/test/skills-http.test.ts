import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { fetchSkillSource } from "../src/services/skills/http.js";
import { fetchSkillPackages } from "../src/services/skills/fetch.js";

describe("skill source HTTP boundary", () => {
  let server: Server;
  let baseUrl = "";
  const hits = new Map<string, number>();

  before(async () => {
    server = createServer(async (request, response) => {
      const path = new URL(request.url ?? "/", "http://fake").pathname;
      hits.set(path, (hits.get(path) ?? 0) + 1);
      if (path === "/retry" && hits.get(path)! < 3) {
        response.writeHead(503, { "retry-after": "0" });
        response.end("busy");
        return;
      }
      if (path === "/dedupe" || path === "/slow") {
        await new Promise((resolve) => setTimeout(resolve, path === "/slow" ? 200 : 25));
      }
      response.writeHead(200, { "content-type": "text/markdown" });
      response.end("---\nname: fake\ndescription: fake\n---\n# Fake\n");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()),
    );
  });

  it("retries transient source failures", async () => {
    const response = await fetchSkillSource(`${baseUrl}/retry`, {}, {
      attempts: 3,
      baseDelayMs: 1,
    });
    assert.equal(response.status, 200);
    assert.equal(hits.get("/retry"), 3);
  });

  it("deduplicates concurrent source reads without sharing consumed bodies", async () => {
    const responses = await Promise.all(
      Array.from({ length: 6 }, () => fetchSkillSource(`${baseUrl}/dedupe`)),
    );
    const texts = await Promise.all(responses.map((response) => response.text()));
    assert.ok(texts.every((text) => text.includes("name: fake")));
    assert.equal(hits.get("/dedupe"), 1);
  });

  it("honors caller cancellation without retrying", async () => {
    const controller = new AbortController();
    const pending = fetchSkillSource(`${baseUrl}/slow`, {}, {
      signal: controller.signal,
      attempts: 3,
      baseDelayMs: 1,
    });
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, /请求已取消/);
    assert.equal(hits.get("/slow"), 1);
  });
});

describe("authenticated skill source isolation", () => {
  it("uses GitLab PRIVATE-TOKEN for discovery and file hydration", async () => {
    const originalFetch = globalThis.fetch;
    const seen: Array<{ url: string; token: string | null }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const headers = new Headers(init?.headers);
      seen.push({ url, token: headers.get("private-token") });
      if (url.includes("/repository/tree")) {
        return Response.json([{ path: "skill/SKILL.md", type: "blob", name: "SKILL.md" }]);
      }
      return new Response("---\nname: private-gitlab\ndescription: private\n---\n# Private\n");
    }) as typeof fetch;
    try {
      const result = await fetchSkillPackages(
        { kind: "gitlab", owner: "acme", repo: "private", path: "skill" },
        { gitlabToken: "glpat-private" },
      );
      assert.equal(result.packages[0]?.name, "private-gitlab");
      assert.ok(seen.length >= 2);
      assert.ok(seen.every((request) => request.token === "glpat-private"));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("does not share GitHub tree cache entries across credentials", async () => {
    const originalFetch = globalThis.fetch;
    let treeHits = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const auth = new Headers(init?.headers).get("authorization") ?? "";
      if (url.includes("api.github.com")) {
        treeHits++;
        return Response.json({
          sha: auth.includes("token-a") ? "aaaaaaaaaaaa1111" : "bbbbbbbbbbbb2222",
          tree: [{ path: "SKILL.md", type: "blob", size: 64, sha: "blob" }],
        });
      }
      return new Response("---\nname: credential-cache\ndescription: isolated\n---\n# Cache\n");
    }) as typeof fetch;
    try {
      const source = { kind: "github", owner: "credential-test", repo: "private-cache" } as const;
      const [a, b] = await Promise.all([
        fetchSkillPackages(source, { githubToken: "token-a", manifestOnly: true }),
        fetchSkillPackages(source, { githubToken: "token-b", manifestOnly: true }),
      ]);
      assert.equal(treeHits, 2);
      assert.notEqual(a.packages[0]?.version, b.packages[0]?.version);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
