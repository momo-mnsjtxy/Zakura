import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  GOOGLE_WORKSPACE_MCP_SERVICES,
  makeTestServiceAccount,
  provisionGoogleWorkspaceMcp,
} from "../src/services/google-cloud-provision.js";

describe("Google Workspace provisioning transport lifecycle", () => {
  it("completes service operations through a deterministic fake control plane", async () => {
    const enabled = new Set<string>();
    const operations = new Map<string, string>();
    const seen: string[] = [];
    const sleeps: number[] = [];
    let now = 1_700_000_000_000;
    const fakeFetch: typeof fetch = async (input, init) => {
      const url = String(input);
      seen.push(`${init?.method ?? "GET"} ${url}`);
      if (url === "https://oauth2.googleapis.com/token") {
        return Response.json({ access_token: "fake-access-token" });
      }
      if (url.includes("cloudresourcemanager.googleapis.com")) {
        return Response.json({
          projectId: "fake-project",
          name: "Fake Project",
          projectNumber: "123",
          lifecycleState: "ACTIVE",
        });
      }
      if (url.includes("/operations/")) {
        const operation = url.split("/v1/")[1]!;
        const service = operations.get(operation);
        assert.ok(service);
        enabled.add(service);
        return Response.json({ done: true });
      }
      const match = url.match(/\/services\/([^:]+)(:enable)?$/);
      if (match) {
        const service = decodeURIComponent(match[1]!);
        if ((init?.method ?? "GET") === "POST") {
          const operation = `operations/enable-${operations.size + 1}`;
          operations.set(operation, service);
          return Response.json({ name: operation });
        }
        return Response.json({ state: enabled.has(service) ? "ENABLED" : "DISABLED" });
      }
      throw new Error(`unexpected fake Google request ${url}`);
    };

    const result = await provisionGoogleWorkspaceMcp({
      config: { publicBaseUrl: "https://zakura.test" } as never,
      serviceAccountJson: makeTestServiceAccount("fake-project"),
      transport: {
        fetch: fakeFetch,
        now: () => now,
        sleep: async (ms) => {
          sleeps.push(ms);
          now += ms;
        },
      },
    });

    assert.deepEqual(result.enabled, [...GOOGLE_WORKSPACE_MCP_SERVICES]);
    assert.deepEqual(result.failed, []);
    assert.equal(result.projectInfo?.state, "ACTIVE");
    assert.equal(result.serviceStates?.every((row) => row.state === "ENABLED"), true);
    assert.equal(operations.size, GOOGLE_WORKSPACE_MCP_SERVICES.length);
    assert.deepEqual(sleeps, []);
    assert.ok(seen.every((request) => !request.includes("fake-access-token")));
  });

  it("rejects an aborted provision before making a provider request", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    await assert.rejects(
      () =>
        provisionGoogleWorkspaceMcp({
          config: { publicBaseUrl: "https://zakura.test" } as never,
          serviceAccountJson: makeTestServiceAccount("fake-project"),
          transport: {
            signal: controller.signal,
            fetch: async () => {
              calls += 1;
              throw new Error("unexpected provider request");
            },
          },
        }),
      (err: unknown) => err instanceof Error && err.name === "AbortError",
    );
    assert.equal(calls, 0);
  });
});
