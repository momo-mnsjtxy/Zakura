import assert from "node:assert/strict";
import { resolve } from "node:path";
import { describe, it } from "node:test";
import { resolveDatabaseTarget } from "../src/db/location.js";

describe("database location", () => {
  it("uses the same durable fallback for empty and memory-like embedded URLs", () => {
    const fallback = resolve("tmp/data");
    for (const value of ["", "pglite:", "file:", "pglite::memory:", "file::memory:"]) {
      assert.deepEqual(resolveDatabaseTarget(value, fallback), {
        kind: "pglite",
        dataDir: resolve(fallback, "pglite"),
      });
    }
  });

  it("normalizes explicit pglite and file paths", () => {
    assert.deepEqual(resolveDatabaseTarget("pglite:./state", "/unused"), {
      kind: "pglite",
      dataDir: resolve("./state"),
    });
    assert.deepEqual(resolveDatabaseTarget("file://./state", "/unused"), {
      kind: "pglite",
      dataDir: resolve("./state"),
    });
  });

  it("retains postgres URLs verbatim after trimming", () => {
    assert.deepEqual(resolveDatabaseTarget(" postgres://db/app ", "/unused"), {
      kind: "postgres",
      url: "postgres://db/app",
    });
  });

  it("rejects ambiguous database locations", () => {
    assert.throws(() => resolveDatabaseTarget("./database", "/unused"), /Unsupported DATABASE_URL/);
  });
});
