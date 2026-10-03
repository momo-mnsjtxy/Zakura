import assert from "node:assert/strict";
import test from "node:test";

import {
  buildUpstreamConfig,
  normalizeProtocolCatalog,
  validateUpstreamForm,
} from "../src/lib/model-settings-state.js";
import { legacyConnectionDestination } from "../src/lib/connection-navigation.js";

test("protocol catalog preserves explicit agent fields and always exposes base URL", () => {
  assert.deepEqual(normalizeProtocolCatalog([
    { protocol: "openai" },
    { protocol: "agent", group: "agent", fields: [] },
  ]), [
    { protocol: "openai", fields: ["baseUrl", "apiKey"] },
    { protocol: "agent", group: "agent", fields: ["baseUrl"] },
  ]);
});

test("upstream config is sparse, trimmed and uses protocol defaults", () => {
  assert.deepEqual(buildUpstreamConfig({
    apiKey: " secret ", baseUrl: "", apiVersion: " v1 ",
    anthropicVersion: "", deploymentId: "", rerankBaseUrl: "", region: "cn",
  }, ["apiKey", "baseUrl", "apiVersion"], "https://api.example.test"), {
    apiKey: "secret",
    baseUrl: "https://api.example.test",
    apiVersion: "v1",
  });
});

test("upstream validation distinguishes create from secret-preserving edit", () => {
  const base = {
    name: "Model", protocol: "openai", apiKey: "", baseUrl: "", defaultBaseUrl: "https://api.example.test",
    fields: ["apiKey", "baseUrl"], agent: false,
  };
  assert.equal(validateUpstreamForm({ ...base, editing: false }), "请填写 API Key");
  assert.equal(validateUpstreamForm({ ...base, editing: true }), null);
});

test("legacy connection deep links retain their intended destination", () => {
  assert.equal(legacyConnectionDestination("tab=credentials"), "/dashboard/settings/oauth-clients");
  assert.equal(legacyConnectionDestination("tab=store&source=skill-registry"), "/dashboard/skills");
  assert.equal(legacyConnectionDestination("tab=store&source=mcp-official"), "/dashboard/mcp/store");
  assert.equal(legacyConnectionDestination("tab=store"), "/dashboard/mcp/store?tab=community");
  assert.equal(legacyConnectionDestination(""), "/dashboard/agents");
});
