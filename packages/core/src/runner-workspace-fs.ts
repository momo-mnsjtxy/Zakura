import type { ListDetailedResult, ReadTextResult, WorkspaceFs, WorkspaceFsEntry } from "./workspace-fs.js";

export type RunnerWorkspaceBackend = {
  rpc<T>(method: string, params?: unknown): Promise<T>;
  listDetailed(spaceId: string, path: string): Promise<ListDetailedResult>;
  readText(spaceId: string, path: string): Promise<ReadTextResult>;
  writeText(spaceId: string, path: string, content: string, expectedRevision?: string | null): Promise<{ path: string; ok: true; revision: string }>;
  mkdir(spaceId: string, path: string): Promise<{ path: string; ok: true }>;
  delete(spaceId: string, path: string, recursive?: boolean): Promise<{ path: string; ok: true }>;
  rename(spaceId: string, oldPath: string, newPath: string): Promise<{ ok: true; path: string }>;
  downloadBytes(spaceId: string, path: string): Promise<{ data: Buffer; size: number; name: string }>;
  uploadBytes(spaceId: string, path: string, data: Buffer): Promise<{ path: string; size: number }>;
  archivePaths(spaceId: string, paths: string[]): Promise<{ filename: string; buffer: Buffer }>;
  extractArchive(spaceId: string, archivePath: string, destination?: string): Promise<{ destination: string; ok: true }>;
};

/** Reject traversal before it crosses the runner trust boundary. The Go daemon
 * remains authoritative and performs its own filesystem jail validation. */
export function assertRunnerWorkspacePath(path: string): string {
  if (path.includes("\0")) throw new Error("Workspace path cannot contain NUL");
  const slash = path.replaceAll("\\", "/");
  const relative = slash === "/workspace" ? "" : slash.startsWith("/workspace/") ? slash.slice(11) : slash;
  if (relative.split("/").some((segment) => segment === "..")) {
    throw new Error(`Workspace path escapes root: ${path}`);
  }
  return path;
}

export function createRunnerWorkspaceFs(backend: RunnerWorkspaceBackend, spaceId: string): WorkspaceFs {
  const path = assertRunnerWorkspacePath;
  return {
    async stat(target) {
      const s = await backend.rpc<WorkspaceFsEntry>("host.fs.stat", { spaceId, path: path(target) });
      return { path: s.path, type: s.isDir ? "dir" : "file", size: s.size, mtime: s.modTime };
    },
    statDetailed: (target) => backend.rpc("host.fs.stat", { spaceId, path: path(target) }),
    async list(target) {
      const detail = await backend.listDetailed(spaceId, path(target));
      return { path: detail.path, entries: detail.entries.map((entry) => ({ name: entry.name, type: entry.isDir ? "dir" as const : "file" as const, size: entry.size })), truncated: false };
    },
    listDetailed: (target) => backend.listDetailed(spaceId, path(target)),
    async read(target) {
      const text = await backend.readText(spaceId, path(target));
      return { path: text.path, content: text.content, truncated: false, totalLines: text.content.split("\n").length, startLine: 1 };
    },
    readText: (target) => backend.readText(spaceId, path(target)),
    async write(target, content) {
      const saved = await backend.writeText(spaceId, path(target), content);
      return { path: saved.path, bytes: content.length };
    },
    writeText: (target, content, revision) => backend.writeText(spaceId, path(target), content, revision),
    async edit(target, oldText, newText) {
      const safe = path(target);
      const current = await backend.readText(spaceId, safe);
      if (!current.content.includes(oldText)) throw new Error("oldText 未找到");
      await backend.writeText(spaceId, safe, current.content.replace(oldText, newText));
      return { path: target, ok: true };
    },
    mkdir: (target) => backend.mkdir(spaceId, path(target)),
    mkdirApi: (target) => backend.mkdir(spaceId, path(target)),
    delete: (target, recursive) => backend.delete(spaceId, path(target), recursive),
    deleteApi: (target, recursive) => backend.delete(spaceId, path(target), recursive),
    async move(from, to) { await backend.rename(spaceId, path(from), path(to)); return { from, to }; },
    renameApi: (from, to) => backend.rename(spaceId, path(from), path(to)),
    async exists(target) {
      const safe = path(target);
      try { await backend.rpc("host.fs.stat", { spaceId, path: safe }); return true; } catch { return false; }
    },
    async readBytes(target) { const safe = path(target); const result = await backend.downloadBytes(spaceId, safe); return { path: safe, ...result }; },
    writeBytes: (target, data) => backend.uploadBytes(spaceId, path(target), data),
    archive: (paths) => backend.archivePaths(spaceId, paths.map(path)),
    extract: (archivePath, destination) => backend.extractArchive(spaceId, path(archivePath), destination == null ? undefined : path(destination)),
  };
}
