import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { fetchSkillSource } from "../src/services/skills/http.js";

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

