import { customType } from "drizzle-orm/pg-core";

function finiteVector(values: readonly unknown[]): number[] {
  if (values.length === 0) throw new Error("vector must contain at least one value");
  if (values.length > 4_096) throw new Error("vector exceeds 4096 dimensions");
  const parsed = values.map(Number);
  if (!parsed.every(Number.isFinite)) throw new Error("vector contains a non-finite value");
  return parsed;
}

function parseVector(value: unknown): number[] {
  if (Array.isArray(value)) return value.length ? finiteVector(value) : [];
  if (typeof value !== "string") return [];
  const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  return inner ? finiteVector(inner.split(",").map((part) => part.trim())) : [];
}

/** Unbounded pgvector column (works on Postgres + PGlite with vector extension). */
export const vectorColumn = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector";
  },
  toDriver(value: number[]): string {
    return `[${finiteVector(value).join(",")}]`;
  },
  fromDriver(value: unknown): number[] {
    return parseVector(value);
  },
});

export function toVectorLiteral(values: number[]): string {
  return `[${finiteVector(values).join(",")}]`;
}
