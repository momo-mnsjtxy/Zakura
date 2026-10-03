/**
 * HTTP client for a real mem0 deployment (Platform or self-hosted OSS).
 *
 * Real mem0 ALWAYS needs an embedder + vector store on *its* side
 * (OpenAI embeddings + Qdrant by default). Zakura does not embed locally
 * and does not run a vector DB — we only proxy HTTP.
 *
 * Docs: https://docs.mem0.ai/
 */

export type Mem0ClientConfig = {
  baseUrl: string;
  apiKey?: string;
  defaultUserId?: string;
};

export type Mem0MemoryItem = {
  id?: string;
  memory?: string;
  content?: string;
  score?: number;
  user_id?: string;
  agent_id?: string;
  created_at?: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
};

function root(cfg: Mem0ClientConfig): string {
  return cfg.baseUrl.replace(/\/$/, "");
}

function headers(cfg: Mem0ClientConfig): Record<string, string> {
  const h: Record<string, string> = {
    Accept: "application/json",
    "Content-Type": "application/json",
  };
  if (cfg.apiKey) h.Authorization = `Bearer ${cfg.apiKey}`;
  return h;
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text };
  }
}

function asResults(data: unknown): Mem0MemoryItem[] {
  if (!data || typeof data !== "object") return [];
  const o = data as Record<string, unknown>;
  const list = (o.results ?? o.memories ?? o.data) as unknown;
  if (!Array.isArray(list)) return [];
  return list.filter((x) => x && typeof x === "object") as Mem0MemoryItem[];
}

export class Mem0Client {
  constructor(private readonly cfg: Mem0ClientConfig) {
    if (!cfg.baseUrl?.trim()) throw new Error("mem0 baseUrl is required");
  }

  static fromConfig(config: Record<string, unknown>): Mem0Client {
    const baseUrl = String(config.baseUrl ?? "").trim();
    if (!baseUrl) {
      throw new Error(
        "mem0 需要 baseUrl（指向已部署的 mem0 Platform / OSS）。真正的 mem0 依赖 embedding 与向量库，Zakura 不会在本地模拟。",
      );
    }
    return new Mem0Client({
      baseUrl,
      apiKey: typeof config.apiKey === "string" ? config.apiKey : undefined,
      defaultUserId:
        typeof config.defaultUserId === "string" && config.defaultUserId.trim()
          ? config.defaultUserId.trim()
          : "default",
    });
  }

  async health(): Promise<{ status: "healthy" | "unhealthy"; message: string }> {
    const base = root(this.cfg);
    try {
      const res = await fetch(`${base}/health`, {
        headers: headers(this.cfg),
        signal: AbortSignal.timeout(5000),
      }).catch(async () =>
        fetch(`${base}/`, {
          headers: headers(this.cfg),
          signal: AbortSignal.timeout(5000),
        }),
      );
      return {
        status: res.ok ? "healthy" : "unhealthy",
        message: `HTTP ${res.status}`,
      };
    } catch (err) {
      return {
        status: "unhealthy",
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async search(opts: {
    query: string;
    agentId: string;
    userId?: string;
    limit?: number;
  }): Promise<{ results: Mem0MemoryItem[]; retrievalMode: "mem0_semantic" }> {
    const base = root(this.cfg);
    const res = await fetch(`${base}/v1/memories/search`, {
      method: "POST",
      headers: headers(this.cfg),
      body: JSON.stringify({
        query: opts.query,
        user_id: opts.userId ?? this.cfg.defaultUserId ?? "default",
        agent_id: opts.agentId,
        limit: opts.limit ?? 10,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const data = await readJson(res);
    if (!res.ok) {
      throw new Error(
        `mem0 search failed HTTP ${res.status}: ${JSON.stringify(data).slice(0, 400)}`,
      );
    }
    return { results: asResults(data), retrievalMode: "mem0_semantic" };
  }

  async add(opts: {
    content: string;
    agentId: string;
    userId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Mem0MemoryItem> {
    const base = root(this.cfg);
    const res = await fetch(`${base}/v1/memories`, {
      method: "POST",
      headers: headers(this.cfg),
      body: JSON.stringify({
        messages: [{ role: "user", content: opts.content }],
        user_id: opts.userId ?? this.cfg.defaultUserId ?? "default",
        agent_id: opts.agentId,
        metadata: opts.metadata ?? {},
      }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await readJson(res);
    if (!res.ok) {
      throw new Error(
        `mem0 add failed HTTP ${res.status}: ${JSON.stringify(data).slice(0, 400)}`,
      );
    }
    if (data && typeof data === "object" && !Array.isArray(data)) {
      const o = data as Record<string, unknown>;
      if (Array.isArray(o.results) && o.results[0]) {
        return o.results[0] as Mem0MemoryItem;
      }
      return o as Mem0MemoryItem;
    }
    return { memory: opts.content };
  }

  async list(opts: {
    agentId: string;
    userId?: string;
    limit?: number;
  }): Promise<{ memories: Mem0MemoryItem[] }> {
    const base = root(this.cfg);
    const params = new URLSearchParams({
      user_id: opts.userId ?? this.cfg.defaultUserId ?? "default",
      agent_id: opts.agentId,
      limit: String(opts.limit ?? 50),
    });
    const res = await fetch(`${base}/v1/memories?${params}`, {
      headers: headers(this.cfg),
      signal: AbortSignal.timeout(15000),
    });
    const data = await readJson(res);
    if (!res.ok) {
      throw new Error(
        `mem0 list failed HTTP ${res.status}: ${JSON.stringify(data).slice(0, 400)}`,
      );
    }
    return { memories: asResults(data) };
  }

  async delete(memoryId: string): Promise<void> {
    const base = root(this.cfg);
    const res = await fetch(`${base}/v1/memories/${encodeURIComponent(memoryId)}`, {
      method: "DELETE",
      headers: headers(this.cfg),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok && res.status !== 404) {
      const data = await readJson(res);
      throw new Error(
        `mem0 delete failed HTTP ${res.status}: ${JSON.stringify(data).slice(0, 400)}`,
      );
    }
  }

  /** Idempotently remove every external record owned by one Zakura agent. */
  async purgeAgent(opts: { agentId: string; userId?: string }): Promise<number> {
    // mem0 supports deleting by agent filter. Deliberately omit user_id here:
    // tools may have written memories for caller-supplied users, and tenant
    // deletion must remove all of them rather than only defaultUserId.
    const base = root(this.cfg);
    const bulk = await fetch(
      `${base}/v1/memories/?${new URLSearchParams({ agent_id: opts.agentId })}`,
      {
        method: "DELETE",
        headers: headers(this.cfg),
        signal: AbortSignal.timeout(30_000),
      },
    );
    if (bulk.ok) return 0;
    if (bulk.status !== 404 && bulk.status !== 405) {
      const data = await readJson(bulk);
      throw new Error(
        `mem0 agent purge failed HTTP ${bulk.status}: ${JSON.stringify(data).slice(0, 400)}`,
      );
    }

    // Older deployments may not implement filter deletion. Fall back to the
    // configured user namespace so cleanup remains useful and retryable.
    let removed = 0;
    for (let pass = 0; pass < 100; pass += 1) {
      const { memories } = await this.list({
        agentId: opts.agentId,
        userId: opts.userId,
        limit: 500,
      });
      const ids = [...new Set(
        memories
          .map((memory) => (typeof memory.id === "string" ? memory.id.trim() : ""))
          .filter(Boolean),
      )];
      if (!ids.length) return removed;
      for (const id of ids) {
        await this.delete(id);
        removed += 1;
      }
      if (memories.length < 500) return removed;
    }
    throw new Error(`mem0 purge did not converge for agent ${opts.agentId}`);
  }
}

export function formatMem0Context(items: Mem0MemoryItem[]): string {
  const lines = items
    .map((r) => `- ${r.memory ?? r.content ?? ""}`.trim())
    .filter((l) => l.length > 2);
  return lines.length ? `## mem0 语义记忆\n${lines.join("\n")}` : "";
}
