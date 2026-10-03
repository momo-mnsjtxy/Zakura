import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { LocalWorkspaceFs } from "../src/local-workspace-fs.js";
import { nodeLocalFileOperations, type LocalFileOperations } from "../src/local-file-operations.js";

const workspace = () => mkdtempSync(join(tmpdir(), "zakura-lfs-atomic-"));
const temps = (root: string) => readdirSync(root, { recursive: true }).map(String).filter((name) => name.includes(".zakura-") && name.endsWith(".tmp"));

test("failed atomic rename preserves prior contents, cleans temp, and permits retry", async () => {
  const root = workspace();
  try {
    let failRename = false;
    const operations: LocalFileOperations = {
      ...nodeLocalFileOperations,
      rename(from, to) {
        if (failRename) throw new Error("simulated rename failure");
        nodeLocalFileOperations.rename(from, to);
      },
    };
    const fs = new LocalWorkspaceFs(root, operations);
    await fs.writeText("state.txt", "before");
    const revision = (await fs.readText("state.txt")).revision;
    failRename = true;
    await assert.rejects(fs.writeText("state.txt", "broken", revision), /simulated rename failure/);
    assert.equal(readFileSync(join(root, "state.txt"), "utf8"), "before");
    assert.deepEqual(temps(root), []);

    failRename = false;
    const result = await fs.writeText("state.txt", "after", revision);
    assert.match(result.revision, /^sha256:/);
    assert.equal(readFileSync(join(root, "state.txt"), "utf8"), "after");
    assert.deepEqual(temps(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("concurrent compare-and-swap writes serialize and reject the stale writer", async () => {
  const root = workspace();
  try {
    const fs = new LocalWorkspaceFs(root);
    await fs.writeText("state.txt", "initial");
    const revision = (await fs.readText("state.txt")).revision;
    const results = await Promise.allSettled([
      fs.writeText("state.txt", "first", revision),
      fs.writeText("state.txt", "second", revision),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    const rejected = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    assert.equal(rejected?.reason?.status, 409);
    assert.ok(["first", "second"].includes(readFileSync(join(root, "state.txt"), "utf8")));
    assert.deepEqual(temps(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("write, edit, writeText, and writeBytes all commit without leaked temporary files", async () => {
  const root = workspace();
  try {
    const fs = new LocalWorkspaceFs(root);
    await fs.write("nested/a.txt", "one");
    await fs.edit("nested/a.txt", "one", "two");
    await fs.writeText("nested/a.txt", "three");
    await fs.writeBytes("nested/b.bin", Buffer.from([0, 255, 1]));
    assert.equal(readFileSync(join(root, "nested/a.txt"), "utf8"), "three");
    assert.deepEqual([...readFileSync(join(root, "nested/b.bin"))], [0, 255, 1]);
    assert.deepEqual(temps(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cleanup failure never masks the primary write failure", async () => {
  const root = workspace();
  try {
    const operations: LocalFileOperations = {
      ...nodeLocalFileOperations,
      write() { throw new Error("primary write failure"); },
      remove() { throw new Error("cleanup failure"); },
    };
    const fs = new LocalWorkspaceFs(root, operations);
    await assert.rejects(fs.writeText("state.txt", "value"), /primary write failure/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
