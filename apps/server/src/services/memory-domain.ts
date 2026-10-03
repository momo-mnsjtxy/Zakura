/** Domain rules shared by the memory store, graph and vector retrieval paths. */
import { createHash } from "node:crypto";

export const MEMORY_LAYERS = [
  "identity",
  "preference",
  "project",
  "fact",
  "episode",
  "note",
] as const;

export type MemoryLayer = (typeof MEMORY_LAYERS)[number];

export function isMemoryLayer(value: string): value is MemoryLayer {
  return (MEMORY_LAYERS as readonly string[]).includes(value);
}

export function clampImportance(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Math.min(5, Math.max(1, Number.isFinite(n) ? n : 3));
}

export function normalizeTags(tags: unknown): string[] {
  if (!Array.isArray(tags)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of tags) {
    const tag = String(value).trim();
    const key = tag.toLocaleLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    result.push(tag.slice(0, 100));
    if (result.length === 64) break;
  }
  return result;
}

export function parseJsonArray(raw: string): string[] {
  try {
    return normalizeTags(JSON.parse(raw));
  } catch {
    return [];
  }
}

export function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
  } catch {
    return {};
  }
}

export function normalizeEmbedding(value: unknown, label = "embedding"): number[] | null {
  if (value == null) return null;
  let parsed: unknown[];
  if (Array.isArray(value)) parsed = value;
  else if (typeof value === "string") {
    const inner = value.trim().replace(/^\[/, "").replace(/\]$/, "");
    parsed = inner ? inner.split(",") : [];
  } else {
    throw new Error(`${label} must be an array`);
  }
  if (parsed.length === 0) return null;
  if (parsed.length > 4_096) throw new Error(`${label} exceeds 4096 dimensions`);
  const numbers = parsed.map(Number);
  if (!numbers.every(Number.isFinite)) throw new Error(`${label} contains a non-finite value`);
  return numbers;
}

export function memoryContentHash(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** English words and CJK bigrams, ordered and de-duplicated. */
export function keywordTokens(query: string): string[] {
  const normalized = query.trim();
  if (!normalized) return [];
  const tokens: string[] = [];
  const seen = new Set<string>();
  const push = (candidate: string) => {
    const value = candidate.trim();
    if (!value || (value.length === 1 && !/[\u4e00-\u9fff]/.test(value))) return;
    const key = value.toLocaleLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    tokens.push(value);
  };
  for (const part of normalized.split(/[\s,，。、；;!?？！]+/)) push(part);
  const cjk = normalized.replace(/[^\u4e00-\u9fff]/g, "");
  if (cjk.length >= 2 && cjk.length <= 32) {
    for (let index = 0; index < cjk.length - 1 && tokens.length < 24; index++) {
      push(cjk.slice(index, index + 2));
    }
  }
  return tokens.slice(0, 16);
}

export function keywordScore(input: {
  content: string;
  query: string;
  tokens: readonly string[];
  pinned: boolean;
  importance: unknown;
}): number {
  const content = input.content.toLocaleLowerCase();
  const query = input.query.trim().toLocaleLowerCase();
  let score = input.pinned ? 0.15 : 0;
  if (query && content.includes(query)) score += 1;
  for (const token of input.tokens) {
    if (content.includes(token.toLocaleLowerCase())) score += 0.25;
  }
  score += clampImportance(input.importance) * 0.05;
  return Math.min(1.5, score);
}

export function fusedScore(input: {
  keyword: number;
  semantic: number;
  pinned: boolean;
}): number {
  const keyword = Number.isFinite(input.keyword) ? Math.max(0, input.keyword) : 0;
  const semantic = Number.isFinite(input.semantic)
    ? Math.max(-1, Math.min(1, input.semantic))
    : 0;
  // A strong result from either retriever must survive. A small contribution from
  // the other retriever produces stable ordering for mixed keyword/vector hits.
  return Math.max(keyword, semantic) + Math.min(keyword, Math.max(0, semantic)) * 0.15 +
    (input.pinned ? 0.05 : 0);
}

export function graphNeighborScore(weight: unknown, seedScore: number): number {
  const parsed = Number(weight);
  const normalizedWeight = Number.isFinite(parsed) ? Math.min(2, Math.max(0, parsed)) : 1;
  return Math.max(0.1, Math.min(0.6, seedScore * 0.35 * normalizedWeight));
}

