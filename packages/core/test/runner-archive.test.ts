import assert from "node:assert/strict";
import test from "node:test";
import { archiveRunnerPaths, extractRunnerArchive, importRunnerArchive, type RunnerArchiveBackend } from "../src/runner-archive.js";

class FakeArchiveBackend implements RunnerArchiveBackend {
  calls: Array<{ method: string; args: unknown[] }> = [];
  execResult = { exitCode: 0, stdout: "", stderr: "" };
  execImpl?: () => Promise<typeof this.execResult>;
  execWorkspace(spaceId: string, command: string[], opts?: { timeoutMs?: number }) {
    this.calls.push({ method: "exec", args: [spaceId, command, opts] });
    return this.execImpl?.() ?? Promise.resolve(this.execResult);
  }
  async downloadBytes(spaceId: string, path: string) { this.calls.push({ method: "download", args: [spaceId, path] }); return { data: Buffer.from([0, 255, 1]), size: 3, name: "archive" }; }
  async uploadBytes(spaceId: string, path: string, data: Buffer) { this.calls.push({ method: "upload", args: [spaceId, path, data] }); return { path, size: data.length }; }
  async delete(spaceId: string, path: string) { this.calls.push({ method: "delete", args: [spaceId, path] }); return { path, ok: true as const }; }
}

const tempPath = (backend: FakeArchiveBackend, method: string) => backend.calls.find((call) => call.method === method)!.args[1] as string;

test("archive uses a jailed temporary file, preserves tar.gz bytes, and cleans up", async () => {
  const backend = new FakeArchiveBackend();
  const result = await archiveRunnerPaths(backend, "space", [".", "/workspace/notes"]);
  assert.deepEqual(result.buffer, Buffer.from([0, 255, 1]));
  assert.equal(result.filename, "archive.tar.gz");
  const command = backend.calls[0]!.args[1] as string[];
  assert.deepEqual(command.slice(0, 3), ["tar", "-czf", command[2]]);
  assert.match(command[2]!, /^\.zakura-archive-[\w-]+\.tar\.gz$/);
  assert.deepEqual(command.slice(3), ["--", ".", "notes"]);
  assert.equal(tempPath(backend, "download"), command[2]);
  assert.equal(tempPath(backend, "delete"), command[2]);
});

test("archive failure and timeout both clean temporary files", async () => {
  for (const mode of ["exit", "timeout"] as const) {
    const backend = new FakeArchiveBackend();
    if (mode === "exit") backend.execResult = { exitCode: 2, stdout: "", stderr: "bad archive" };
    else backend.execImpl = () => new Promise(() => {});
    await assert.rejects(archiveRunnerPaths(backend, "space", ["."], { timeoutMs: 3 }), mode === "exit" ? /bad archive/ : { name: "TimeoutError" });
    assert.equal(backend.calls.filter((call) => call.method === "delete").length, 1);
  }
});

test("cancel returns promptly and eventual operation still cleans up", async () => {
  const backend = new FakeArchiveBackend();
  let release!: () => void;
  backend.execImpl = () => new Promise((resolve) => { release = () => resolve(backend.execResult); });
  const controller = new AbortController();
  const operation = archiveRunnerPaths(backend, "space", ["."], { timeoutMs: 100, signal: controller.signal });
  controller.abort();
  await assert.rejects(operation, { name: "AbortError" });
  release();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(backend.calls.filter((call) => call.method === "delete").length, 1);
});

test("import uploads a unique archive, extracts same tar format, and always deletes", async () => {
  const backend = new FakeArchiveBackend();
  const input = Buffer.from("tar-gzip-bytes");
  const result = await importRunnerArchive(backend, "space", input);
  assert.deepEqual(result, { ok: true, fileCount: 0, workspaceRoot: "/" });
  const upload = backend.calls.find((call) => call.method === "upload")!;
  const path = upload.args[1] as string;
  assert.match(path, /^\.zakura-import-[\w-]+\.tar\.gz$/);
  assert.deepEqual(upload.args[2], input);
  const commands = backend.calls.filter((call) => call.method === "exec").map((call) => call.args[1] as string[]);
  const extract = commands.find((command) => command[0] === "tar")!;
  assert.deepEqual(extract.slice(0, 3), ["tar", "-xzf", path]);
  assert.match(extract[4]!, /^\.zakura-incoming-/);
  assert.ok(commands.some((command) => command[0] === "sh" && command[2]?.includes("cp -a")));
  const deleted = backend.calls.filter((call) => call.method === "delete").map((call) => call.args[1]);
  assert.ok(deleted.includes(path));
  assert.ok(deleted.some((value) => typeof value === "string" && value.startsWith(".zakura-incoming-")));
});

test("all user-controlled archive paths are jailed before fake hub execution", async () => {
  const backend = new FakeArchiveBackend();
  await assert.rejects(archiveRunnerPaths(backend, "space", ["../secret"]), /escapes root/);
  await assert.rejects(extractRunnerArchive(backend, "space", "../archive", "/"), /escapes root/);
  await assert.rejects(extractRunnerArchive(backend, "space", "/archive", "../dest"), /escapes root/);
  assert.equal(backend.calls.length, 0);
});

test("RunnerClient rejects corrupt migration before any fake hub RPC", async () => {
  const calls: string[] = [];
  const client = new (await import("../src/runner-client.js")).RunnerClient({
    workspaceKind: "host",
    hub: { async rpc<T>(method: string): Promise<T> { calls.push(method); return {} as T; } },
  });
  await assert.rejects(client.importMigration("space", Buffer.from("not-a-tar"), { expectedSha256: "0".repeat(64), atomic: true }), /sha256 mismatch/);
  assert.deepEqual(calls, []);
});

test("atomic apply failure exposes rollback and cleans staged artifacts", async () => {
  const backend = new FakeArchiveBackend();
  backend.execImpl = undefined;
  const original = backend.execWorkspace.bind(backend);
  backend.execWorkspace = async (spaceId, command, opts) => {
    const result = await original(spaceId, command, opts);
    return command[0] === "sh" ? { exitCode: 1, stdout: "", stderr: "apply failed" } : result;
  };
  await assert.rejects(importRunnerArchive(backend, "space", Buffer.from("archive"), { atomic: true }), /apply failed/);
  const shell = backend.calls.find((call) => call.method === "exec" && (call.args[1] as string[])[0] === "sh")!.args[1] as string[];
  assert.match(shell[2]!, /backup\/\." \.; exit 1|backup\/\." \.; exit 1|cp -a/);
  assert.match(shell[2]!, /find .*rm -rf/);
  const deleted = backend.calls.filter((call) => call.method === "delete").map((call) => String(call.args[1]));
  assert.ok(deleted.some((value) => value.startsWith(".zakura-incoming-")));
  assert.ok(deleted.some((value) => value.startsWith(".zakura-import-")));
});
