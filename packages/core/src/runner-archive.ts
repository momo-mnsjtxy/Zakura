import { randomUUID } from "node:crypto";
import { assertRunnerWorkspacePath } from "./runner-workspace-fs.js";
import { deadline } from "./recovering-runtime.js";

export type RunnerArchiveBackend = {
  execWorkspace(spaceId: string, command: string[], opts?: { timeoutMs?: number }): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  downloadBytes(spaceId: string, path: string): Promise<{ data: Buffer; size: number; name: string }>;
  uploadBytes(spaceId: string, path: string, data: Buffer): Promise<{ path: string; size: number }>;
  delete(spaceId: string, path: string, recursive?: boolean): Promise<{ path: string; ok: true }>;
};
export type ArchiveLifecycleOptions = { timeoutMs?: number; signal?: AbortSignal; atomic?: boolean };
const DEFAULT_TIMEOUT = 120_000;

export async function archiveRunnerPaths(
  backend: RunnerArchiveBackend,
  spaceId: string,
  paths: string[],
  options: ArchiveLifecycleOptions = {},
): Promise<{ filename: string; buffer: Buffer }> {
  if (paths.length === 0) return Promise.reject(new Error("At least one workspace path is required"));
  const safePaths = paths.map(assertRunnerWorkspacePath);
  const temp = `.zakura-archive-${randomUUID()}.tar.gz`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  const workflow = (async () => {
    try {
      const result = await deadline(
        backend.execWorkspace(spaceId, ["tar", "-czf", temp, "--", ...safePaths.map(commandPath)], { timeoutMs }),
        timeoutMs,
        "archive workspace",
      );
      assertExecSuccess("archive workspace", result);
      const downloaded = await deadline(backend.downloadBytes(spaceId, temp), timeoutMs, "download archive");
      return { filename: "archive.tar.gz", buffer: downloaded.data };
    } finally {
      await deadline(backend.delete(spaceId, temp), Math.min(timeoutMs, 10_000), "archive cleanup").catch(() => undefined);
    }
  })();
  return await raceAbort(workflow, options.signal);
}

export async function extractRunnerArchive(
  backend: RunnerArchiveBackend,
  spaceId: string,
  archivePath: string,
  destination = "/",
  options: ArchiveLifecycleOptions = {},
): Promise<{ destination: string; ok: true }> {
  const archive = assertRunnerWorkspacePath(archivePath);
  const dest = assertRunnerWorkspacePath(destination);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  const workflow = (async () => {
    const result = await deadline(
      backend.execWorkspace(spaceId, ["tar", "-xzf", commandPath(archive), "-C", commandPath(dest)], { timeoutMs }),
      timeoutMs,
      "extract archive",
    );
    assertExecSuccess("extract archive", result);
    return { destination: dest, ok: true as const };
  })();
  return await raceAbort(workflow, options.signal);
}

export async function importRunnerArchive(
  backend: RunnerArchiveBackend,
  spaceId: string,
  archive: Buffer,
  options: ArchiveLifecycleOptions = {},
): Promise<{ ok: true; fileCount: number; workspaceRoot: string }> {
  const temp = `.zakura-import-${randomUUID()}.tar.gz`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT;
  const workflow = (async () => {
    try {
      await deadline(backend.uploadBytes(spaceId, temp, archive), timeoutMs, "upload archive");
      if (options.atomic === false) {
        await extractRunnerArchive(backend, spaceId, temp, "/", { timeoutMs });
      } else {
        const staging = `.zakura-incoming-${randomUUID()}`;
        try {
          const backup = `.zakura-backup-${randomUUID()}`;
          await backend.execWorkspace(spaceId, ["mkdir", "-p", staging, backup], { timeoutMs });
          await extractRunnerArchive(backend, spaceId, temp, staging, { timeoutMs });
          const script = [
            "set -eu",
            "staging=$1; backup=$2; archive=$3",
            `find . -mindepth 1 -maxdepth 1 ! -name "$staging" ! -name "$backup" ! -name "$archive" -exec mv -- {} "$backup/" \\;`,
            `if cp -a "$staging/." .; then rm -rf -- "$backup"; else`,
            `  find . -mindepth 1 -maxdepth 1 ! -name "$staging" ! -name "$backup" ! -name "$archive" -exec rm -rf -- {} +`,
            `  cp -a "$backup/." .; exit 1`,
            "fi",
          ].join("; ");
          const applied = await backend.execWorkspace(spaceId, ["sh", "-c", script, "sh", staging, backup, temp], { timeoutMs });
          assertExecSuccess("apply atomic import", applied);
          await backend.delete(spaceId, backup, true).catch(() => undefined);
        } finally {
          await backend.delete(spaceId, staging, true).catch(() => undefined);
        }
      }
      return { ok: true as const, fileCount: 0, workspaceRoot: "/" };
    } finally {
      await deadline(backend.delete(spaceId, temp), Math.min(timeoutMs, 10_000), "import cleanup").catch(() => undefined);
    }
  })();
  return await raceAbort(workflow, options.signal);
}

function commandPath(path: string): string {
  const slash = path.replaceAll("\\", "/");
  const relative = slash === "/workspace" ? "." : slash.startsWith("/workspace/") ? slash.slice(11) : slash.replace(/^\/+/, "");
  return relative || ".";
}

function assertExecSuccess(operation: string, result: { exitCode: number; stderr: string }): void {
  if (result.exitCode !== 0) throw new Error(`${operation} failed (${result.exitCode}): ${result.stderr}`);
}

function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError());
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
function abortError(): Error { const error = new Error("Archive operation cancelled"); error.name = "AbortError"; return error; }
