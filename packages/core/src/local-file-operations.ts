import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export type LocalFileOperations = {
  exists(path: string): boolean;
  mkdir(path: string): void;
  read(path: string): Buffer;
  write(path: string, data: Buffer): void;
  rename(from: string, to: string): void;
  remove(path: string): void;
};

export const nodeLocalFileOperations: LocalFileOperations = {
  exists: existsSync,
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  read: readFileSync,
  write: (path, data) => writeFileSync(path, data),
  rename: renameSync,
  remove: (path) => rmSync(path, { force: true }),
};

export type AtomicWriteOptions = {
  expectedRevision?: string | null;
  revision(data: Buffer): string;
};

/** Serializes same-file mutations and commits via a same-directory rename. */
export class LocalFileMutationLifecycle {
  private readonly tails = new Map<string, Promise<void>>();

  constructor(
    private readonly fs: LocalFileOperations = nodeLocalFileOperations,
    private readonly uniqueName: () => string = randomUUID,
  ) {}

  write(path: string, data: Buffer, options: AtomicWriteOptions): Promise<string> {
    return this.serial(path, async () => {
      if (options.expectedRevision !== undefined && options.expectedRevision !== null) {
        if (!this.fs.exists(path) || options.revision(this.fs.read(path)) !== options.expectedRevision) {
          throw Object.assign(new Error("file changed on disk"), { status: 409 });
        }
      }
      await this.commit(path, data);
      return options.revision(data);
    });
  }

  edit(path: string, transform: (current: string) => string): Promise<void> {
    return this.serial(path, async () => {
      const updated = Buffer.from(transform(this.fs.read(path).toString("utf8")), "utf8");
      await this.commit(path, updated);
    });
  }

  private async commit(path: string, data: Buffer): Promise<void> {
    const parent = dirname(path);
    this.fs.mkdir(parent);
    const temp = join(parent, `.${basename(path)}.zakura-${this.uniqueName()}.tmp`);
    try {
      this.fs.write(temp, data);
      this.fs.rename(temp, path);
    } finally {
      // Rename consumes the temporary path. remove(force) makes both success
      // and partial-failure cleanup safe and repeatable.
      try { this.fs.remove(temp); } catch { /* cleanup must not mask the operation error */ }
    }
  }

  private serial<T>(path: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(path) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(operation);
    const tail = current.then(() => undefined, () => undefined);
    this.tails.set(path, tail);
    void tail.finally(() => {
      if (this.tails.get(path) === tail) this.tails.delete(path);
    });
    return current;
  }
}
