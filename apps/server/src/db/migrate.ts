import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import postgres from "postgres";
import { drizzle as drizzlePg } from "drizzle-orm/postgres-js";
import { migrate as migratePg } from "drizzle-orm/postgres-js/migrator";
import { log } from "@zakura/core";
import { createPglite } from "./pglite.js";
import { resolveDatabaseTarget } from "./location.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const migrationsFolder = resolve(root, "drizzle");

export async function runMigrations(databaseUrl: string): Promise<void> {
  const target = resolveDatabaseTarget(databaseUrl, resolve(root, "../../data"));
  const kind = target.kind;
  log.info("db.migrate_start", { db_kind: kind });

  if (kind === "pglite") {
    const dir = target.dataDir;
    mkdirSync(dir, { recursive: true });
    const client = await createPglite(dir);
    try {
      const db = drizzle(client);
      await migrate(db, { migrationsFolder });
    } finally {
      await client.close();
    }
  } else {
    const sql = postgres(target.url, { max: 1 });
    try {
      await sql`CREATE EXTENSION IF NOT EXISTS vector`.catch(() => {
        log.warn("db.extension_unavailable", { extension: "vector" });
      });
      // 会话标题模糊搜索用；装不上（托管库未提供 / 权限不足）时搜索自动回退 ILIKE
      await sql`CREATE EXTENSION IF NOT EXISTS pg_trgm`.catch(() => {
        log.warn("db.extension_unavailable", { extension: "pg_trgm" });
      });
      const db = drizzlePg(sql);
      await migratePg(db, { migrationsFolder });
    } finally {
      await sql.end({ timeout: 5 });
    }
  }

  log.info("db.migrate_ok", { db_kind: kind });
}

const isCli =
  process.argv[1] &&
  (process.argv[1].endsWith("migrate.ts") || process.argv[1].endsWith("migrate.js"));

if (isCli) {
  const databaseUrl =
    process.env.DATABASE_URL ?? `pglite:${resolve(root, "../../data/pglite")}`;
  runMigrations(databaseUrl).catch((err) => {
    log.fatal("db.migrate_fatal", { err });
    process.exit(1);
  });
}
