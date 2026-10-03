import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ModelCatalogEntry } from "@zakura/shared";
import type { Db } from "../src/db/client.js";
import {
  ModelCatalogService,
  paginateCatalogEntries,
  parseModelsDevPayload,
} from "../src/services/model-catalog.js";
import { inferCapabilitiesFromModelId } from "../src/services/upstream-models.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function catalogImportHarness() {
  let rows: Array<Record<string, unknown>> = [];
  const transactionDb = {
    delete: () => ({
      where: async () => {
        rows = [];
      },
    }),
    insert: () => ({
      values: async (values: Array<Record<string, unknown>>) => {
        rows.push(...values);
      },
    }),
  };
  const db = {
    transaction: async <T>(callback: (value: unknown) => Promise<T>) => {
      const before = [...rows];
      try {
        return await callback(transactionDb);
      } catch (error) {
        rows = before;
        throw error;
      }
    },
  } as unknown as Db;
  return {
    catalog: new ModelCatalogService(db),
    rows: () => rows,
  };
}

function entry(
  modelId: string,
  capabilities: ModelCatalogEntry["capabilities"],
): ModelCatalogEntry {
  return {
    source: "models.dev",
    providerId: "provider",
    providerName: "Provider",
    modelId,
    name: modelId,
    capabilities,
  };
}

describe("model catalog provider contracts", () => {
  it("classifies TypeSafe JEV models as evaluation rather than chat", () => {
    const parsed = parseModelsDevPayload({
      typesafe: {
        name: "TypeSafe",
        models: {
          "jev-latest": {
            name: "System One JEV",
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    });
    assert.deepEqual(parsed[0]?.capabilities, ["evaluation"]);
    assert.deepEqual(inferCapabilitiesFromModelId("jev-latest"), ["evaluation"]);
    assert.deepEqual(inferCapabilitiesFromModelId("system-one-v2"), ["evaluation"]);
  });

  it("deduplicates a remote snapshot inside one atomic catalog replacement", async () => {
    const harness = catalogImportHarness();
    globalThis.fetch = (async () => new Response(JSON.stringify({
      providers: [{ id: "typesafe", name: "TypeSafe" }],
      models: [
        { provider: "typesafe", id: "jev-latest", name: "JEV" },
        { provider: "typesafe", id: "jev-latest", name: "JEV duplicate" },
      ],
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch;

    const result = await harness.catalog.importFrom("tenant-1", "llm-metadata");
    assert.equal(result.imported, 1);
    assert.equal(harness.rows().length, 1);
    const meta = JSON.parse(String(harness.rows()[0]?.metaJson)) as ModelCatalogEntry;
    assert.deepEqual(meta.capabilities, ["evaluation"]);
  });

  it("applies capability filtering before pagination and reports a filtered total", async () => {
    const result = paginateCatalogEntries(
      [
        entry("chat-1", ["chat"]),
        entry("eval-1", ["evaluation"]),
        entry("eval-2", ["evaluation"]),
      ],
      "evaluation",
      1,
      1,
    );
    assert.equal(result.total, 2);
    assert.equal(result.entries.length, 1);
    assert.equal(result.entries[0]?.modelId, "eval-2");
  });
});
