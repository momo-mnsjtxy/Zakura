import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { drizzle as drizzlePglite } from "drizzle-orm/pglite";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";
import { log } from "@zakura/core";
import { createPglite } from "./pglite.js";
import { resolveDatabaseTarget } from "./location.js";

export type Db =
  | ReturnType<typeof drizzlePglite<typeof schema>>
  | ReturnType<typeof drizzlePg<typeof schema>>;

export type DbKind = "pglite" | "postgres";

export interface DbHandle {
  db: Db;
  kind: DbKind;
  /** Close underlying connections */
  close: () => Promise<void>;
}

/**
 * One schema (PostgreSQL dialect). Two runtimes:
 * - pglite  → self-host, zero external DB (default) — with pgvector
 * - postgres → cloud / multi-tenant / compose — requires CREATE EXTENSION vector
 *
 * DATABASE_URL:
 * - unset | `pglite:` | `pglite:./path` | `file:./path` → PGlite under data dir
 * - `postgresql://...` | `postgres://...` → remote Postgres
 */
export function resolveDbKind(databaseUrl: string): DbKind {
  return resolveDatabaseTarget(databaseUrl, ".").kind;
}

function onceAsync(action: () => Promise<void>): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => (closing ??= action());
}

export async function createDb(opts: {
  databaseUrl: string;
  dataDir: string;
}): Promise<DbHandle> {
  const target = resolveDatabaseTarget(opts.databaseUrl, opts.dataDir);
  const kind = target.kind;

  if (kind === "pglite") {
    const dir = target.dataDir;
    mkdirSync(dirname(dir), { recursive: true });
    mkdirSync(dir, { recursive: true });
    const client = await createPglite(dir);
    const db = drizzlePglite(client, { schema });
    return {
      db,
      kind,
      close: onceAsync(() => client.close()),
    };
  }

  const sql = postgres(target.url, { max: 10, connect_timeout: 10 });
  // Ensure pgvector is available on managed Postgres (no-op if already installed)
  await sql`CREATE EXTENSION IF NOT EXISTS vector`.catch(() => {
    log.warn("db.extension_unavailable", { extension: "vector" });
  });
  const db = drizzlePg(sql, { schema });
  return {
    db,
    kind,
    close: onceAsync(() => sql.end({ timeout: 5 })),
  };
}

export { schema };
