import assert from "node:assert/strict";
import test from "node:test";
import { RunnerClient } from "../src/runner-client.js";
import { assertRunnerWorkspacePath } from "../src/runner-workspace-fs.js";

class FsHub {
  calls: Array<{ method: string; params: any }> = [];
  files = new Map<string, string | Buffer>([["/notes.txt", "hello world"]]);
  async rpc<T>(method: string, params: any = {}): Promise<T> {
    this.calls.push({ method, params });
    const path = params.path as string;
    if (method === "host.fs.stat") {
      if (!this.files.has(path) && path !== "/") throw new Error("not found");
      return { path, name: path.split("/").pop() || "", isDir: path === "/", size: this.files.get(path)?.length ?? 0, modTime: 1 } as T;
    }
    if (method === "host.fs.list") return { path, entries: [{ name: "notes.txt", path: "/notes.txt", isDir: false, size: 11, modTime: 1 }] } as T;
    if (method === "host.fs.read") {
      const content = this.files.get(path);
      if (content == null) throw new Error("not found");
      return (params.max ? { path, base64: Buffer.from(content).toString("base64"), size: Buffer.byteLength(content) } : { path, content: content.toString() }) as T;
    }
    if (method === "host.fs.write") {
      const content = params.base64 ? Buffer.from(params.base64, "base64") : params.content;
      this.files.set(path, content);
      return { path, ok: true, revision: "" } as T;
    }
    if (method === "host.fs.rename") {
      const value = this.files.get(params.oldPath)!;
      this.files.delete(params.oldPath); this.files.set(params.newPath, value);
      return { ok: true, path: params.newPath } as T;
    }
    if (method === "host.fs.mkdir" || method === "host.fs.remove") return { path, ok: true } as T;
    throw new Error(`unexpected ${method}`);
  }
}

test("workspace adapter preserves jailed RPC wire contract across read/edit/move", async () => {
  const hub = new FsHub();
  const fs = new RunnerClient({ hub, workspaceKind: "host" }).workspaceFs("space-1");
  assert.equal((await fs.read("/notes.txt")).totalLines, 1);
  await fs.edit("/notes.txt", "world", "runner");
  assert.equal((await fs.readText("/notes.txt")).content, "hello runner");
  await fs.move("/notes.txt", "/moved.txt");
  assert.equal(await fs.exists("/notes.txt"), false);
  assert.equal(await fs.exists("/moved.txt"), true);
  assert.deepEqual(hub.calls[0], { method: "host.fs.read", params: { spaceId: "space-1", path: "/notes.txt" } });
  assert.ok(hub.calls.every((call) => call.params.spaceId === "space-1"));
});

test("workspace adapter rejects traversal and NUL before fake hub invocation", async () => {
  const hub = new FsHub();
  const fs = new RunnerClient({ hub, workspaceKind: "host" }).workspaceFs("space-1");
  await assert.rejects(fs.read("/workspace/../secret"), /escapes root/);
  await assert.rejects(fs.write("bad\0name", "x"), /NUL/);
  await assert.rejects(fs.move("safe", "../outside"), /escapes root/);
  await assert.rejects(fs.exists("../outside"), /escapes root/);
  assert.equal(hub.calls.length, 0);
});

test("path validation accepts public aliases without rewriting the wire value", () => {
  for (const path of ["notes/a.txt", "/notes/a.txt", "/workspace/notes/a.txt", "notes\\a.txt"]) {
    assert.equal(assertRunnerWorkspacePath(path), path);
  }
});

test("binary read/write remain byte-safe through base64 runner RPC", async () => {
  const hub = new FsHub();
  const fs = new RunnerClient({ hub, workspaceKind: "host" }).workspaceFs("space-1");
  const bytes = Buffer.from([0, 255, 1]);
  await fs.writeBytes("/blob.bin", bytes);
  const read = await fs.readBytes("/blob.bin");
  assert.deepEqual(read.data, bytes);
  const write = hub.calls.find((call) => call.method === "host.fs.write")!;
  assert.equal(write.params.base64, "AP8B");
});
