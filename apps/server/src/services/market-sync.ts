/**
 * 市场定期同步：刷新 MCP 文件缓存 + 插件市场缓存，并重建商店目录索引（名称/描述）。
 * 与 SkillsService 后台刷新并列，互不耦合。
 */
import { recordPlatformFault } from "@zakura/core";
import { BUILTIN_MARKETS, CURATED_OAUTH_MCPS } from "@zakura/shared";
import type { McpStoreService } from "./mcp-store.js";
import type { StoreCatalogService } from "./store-catalog.js";
import type { SkillsService } from "./skills/index.js";

const SYNC_INTERVAL_MS = 60 * 60 * 1000;
const BOOTSTRAP_DELAY_MS = 20_000;

export type MarketSyncScheduler = {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
};

export type MarketSyncOptions = {
  scheduler?: MarketSyncScheduler;
  bootstrapDelayMs?: number;
  intervalMs?: number;
  drainTimeoutMs?: number;
};

const defaultScheduler: MarketSyncScheduler = {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};

export class MarketSyncService {
  private timer: ReturnType<typeof setInterval> | null = null;
  private bootstrapTimer: ReturnType<typeof setTimeout> | null = null;
  private activeTick: Promise<void> | null = null;
  private readonly scheduler: MarketSyncScheduler;
  private readonly bootstrapDelayMs: number;
  private readonly intervalMs: number;
  private readonly drainTimeoutMs: number;

  constructor(
    private readonly mcpStore: McpStoreService,
    private readonly catalog: StoreCatalogService,
    private readonly skills: SkillsService,
    opts: MarketSyncOptions = {},
  ) {
    this.scheduler = opts.scheduler ?? defaultScheduler;
    this.bootstrapDelayMs = opts.bootstrapDelayMs ?? BOOTSTRAP_DELAY_MS;
    this.intervalMs = opts.intervalMs ?? SYNC_INTERVAL_MS;
    this.drainTimeoutMs = opts.drainTimeoutMs ?? 30_000;
  }

  start(): void {
    if (this.timer || this.bootstrapTimer) return;
    this.bootstrapTimer = this.scheduler.setTimeout(() => {
      this.bootstrapTimer = null;
      void this.tick();
    }, this.bootstrapDelayMs);
    this.bootstrapTimer.unref?.();
    this.timer = this.scheduler.setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) this.scheduler.clearInterval(this.timer);
    this.timer = null;
    if (this.bootstrapTimer) this.scheduler.clearTimeout(this.bootstrapTimer);
    this.bootstrapTimer = null;
  }

  async stopAndDrain(): Promise<void> {
    this.stop();
    const active = this.activeTick;
    if (!active) return;
    await new Promise<void>((resolve) => {
      const timer = this.scheduler.setTimeout(resolve, this.drainTimeoutMs);
      timer.unref?.();
      void active.finally(() => {
        this.scheduler.clearTimeout(timer);
        resolve();
      });
    });
  }

  async tick(): Promise<void> {
    if (this.activeTick) return this.activeTick;
    const run = (async () => {
      await this.runStep("stores", () => this.syncMcpStores());
      await this.runStep("curated", () => this.indexCurated());
      await this.runStep("skills", () => this.indexSkillRepos());
      // 插件市场：每轮最多同步一个，避免打爆 git
      await this.runStep("plugin", () => this.syncOnePluginMarket());
    })();
    this.activeTick = run;
    try {
      await run;
    } finally {
      if (this.activeTick === run) this.activeTick = null;
    }
  }

  private async runStep(name: string, step: () => Promise<void>): Promise<void> {
    try {
      await step();
    } catch (err) {
      // Preserve the existing metric/log kind; include stage in the error text.
      const message = err instanceof Error ? err.message : String(err);
      recordPlatformFault("market_sync.tick", new Error(`${name}: ${message}`), {
        subsystem: "market_sync",
      });
    }
  }

  private async syncMcpStores(): Promise<void> {
    const result = await this.mcpStore.sync({ force: false });
    for (const row of result.results) {
      if (row.error) {
        recordPlatformFault("market_sync.store", row.error, { subsystem: "market_sync" });
        continue;
      }
      await this.indexMcpStore(row.storeId);
    }
  }

  private async indexMcpStore(storeId: string): Promise<void> {
    const result = await this.mcpStore.search({
      tenantId: "__platform__",
      store: storeId as never,
      limit: 5000,
      offset: 0,
    });
    await this.catalog.replaceSource(
      storeId,
      result.items
        .filter((s) => !s.isPlugin)
        .map((s) => ({
          kind: "mcp" as const,
          ref: `mcp:${s.storeId}:${s.name}`,
          name: s.title || s.name,
          description: s.description,
          meta: {
            detailId: `mcp:${s.storeId}:${s.name}`,
            installRef: `mcp:${s.storeId}:${s.name}`,
            needsRunner: s.installKinds.some((k) => k.startsWith("stdio")) || !!s.packages?.length,
            version: s.version,
          },
        })),
      null,
    );
  }

  private async indexCurated(): Promise<void> {
    await this.catalog.replaceSource(
      "mcp-official",
      CURATED_OAUTH_MCPS.map((m) => ({
        kind: "curated" as const,
        ref: `curated:${m.id}`,
        name: m.name,
        description: m.description ?? "",
        meta: {
          detailId: `curated:${m.id}`,
          installRef: `curated:${m.id}`,
          icon: m.icon,
        },
      })),
      null,
    );
  }

  private async indexSkillRepos(): Promise<void> {
    const repos = await this.skills.listRepos();
    for (const repo of repos) {
      if (!repo.skillCount) continue;
      // 不把 SKILL.md 正文写入索引；仅名称描述。
      // tenantId 用平台哨兵：只读商店目录、不写 skills 表（syncBuiltins 会跳过）。
      const page = await this.skills.search("__platform__", {
        query: "",
        store: "curated",
        repoSlug: repo.slug,
        limit: 500,
        offset: 0,
      }).catch(() => null);
      if (!page?.items.length) continue;
      await this.catalog.replaceSource(
        `skill-repo:${repo.slug}`,
        page.items.map((item) => ({
          kind: "skill" as const,
          ref: `skill:curated:${item.installSpec || item.source}`,
          name: item.title || item.name,
          description: item.description ?? "",
          meta: {
            detailId: `skill:curated:${item.installSpec || item.source}`,
            installRef: item.installSpec || item.source,
            publisher: item.publisher,
          },
        })),
        null,
      );
    }
  }

  private pluginCursor = 0;

  private async syncOnePluginMarket(): Promise<void> {
    const markets = BUILTIN_MARKETS.filter((m) => m.kind === "plugin-repo" && m.repository);
    if (!markets.length) return;
    const market = markets[this.pluginCursor % markets.length]!;
    this.pluginCursor += 1;
    try {
      const servers = await this.mcpStore.ensurePluginMarket(market.id, market.repository!);
      const groups = new Map<string, (typeof servers)[0][]>();
      for (const s of servers) {
        const key = s.pluginName || s.title || s.name;
        const list = groups.get(key) ?? [];
        list.push(s);
        groups.set(key, list);
      }
      await this.catalog.replaceSource(
        market.id,
        [...groups.entries()].map(([name, list]) => {
          const primary = list[0]!;
          return {
            kind: "plugin" as const,
            ref: `plugin:market:${market.id}:${name}`,
            name,
            description: primary.description ?? "",
            meta: {
              detailId: `plugin:market:${market.id}:${name}`,
              installRef: `plugin:market:${market.id}:${name}`,
              publisher: market.publisher,
            },
          };
        }),
        null,
      );
    } catch (err) {
      recordPlatformFault("market_sync.plugin", err, { subsystem: "market_sync" });
    }
  }
}
