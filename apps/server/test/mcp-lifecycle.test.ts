import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { boundedMcpOperation, McpHttpError } from "../src/lib/mcp-http.js";

describe("MCP HTTP lifecycle", () => {
  it("bounds a stalled provider operation and classifies it as network failure", async () => {
    const stalled = new Promise<never>(() => {});
    await assert.rejects(boundedMcpOperation(stalled, 5), (error: unknown) => {
      assert.ok(error instanceof McpHttpError);
      assert.equal(error.kind, "network");
      assert.match(error.message, /timed out/);
      return true;
    });
  });

  it("clears the deadline when provider completes", async () => {
    assert.equal(await boundedMcpOperation(Promise.resolve("healthy"), 100), "healthy");
  });
});
