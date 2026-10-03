import { resolve } from "node:path";

export type DatabaseTarget =
  | { kind: "pglite"; dataDir: string }
  | { kind: "postgres"; url: string };

/**
 * Parse the database location once for both application startup and migrations.
 * Keeping this policy in one place prevents the two entry points from silently
 * opening different embedded databases for the same DATABASE_URL.
 */
export function resolveDatabaseTarget(
  databaseUrl: string,
  fallbackDataDir: string,
): DatabaseTarget {
  const value = databaseUrl.trim();
  if (/^postgres(ql)?:\/\//i.test(value)) {
    return { kind: "postgres", url: value };
  }

  if (!value || value === "pglite:" || value === "file:" || /:memory:$/i.test(value)) {
    return { kind: "pglite", dataDir: resolve(fallbackDataDir, "pglite") };
  }

  if (/^(pglite|file):/i.test(value)) {
    const path = value.replace(/^(pglite|file):/i, "").replace(/^\/\//, "");
    return { kind: "pglite", dataDir: resolve(path) };
  }

  throw new Error(
    `Unsupported DATABASE_URL. Use pglite:/path, file:/path, or postgresql://... Got: ${value.slice(0, 48)}`,
  );
}

