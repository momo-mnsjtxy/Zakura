/**
 * Background image-update checker: periodically polls every online node (remote
 * Runners over their API, local Docker in-process) to detect whether the images
 * they run have newer versions on the registry. Results are cached in memory and
 * served to the UI.
 *
 * The sweep is deliberately read-only — it never pulls. See
 * `packages/core/src/image-update-check.ts` for why a pulling "check" is a trap.
 */
import { log } from "@zakura/core";
import { eq, inArray } from "drizzle-orm";
import {
  DEFAULT_WORKSPACE_IMAGE,
  type ImageUpdateEntry,
  type ImageUpdateKind,
  type NodeImageUpdateStatus,
} from "@zakura/shared";
import { findAgentBinary } from "./agent-binaries.js";
import type { DockerRuntime } from "../runtime/docker.js";
import type { RuntimeNodeService } from "./runtime-nodes.js";
import type { Db } from "../db/client.js";
import { runtimeNodes, spaces } from "../db/schema.js";

const CHECK_INTERVAL_MS = 10 * 60 * 1000;
const STALE_AFTER_MS = 15 * 60 * 1000;
/** Cap one node's probe so a blackholed registry cannot stall the whole sweep. */
const NODE_PROBE_TIMEOUT_MS = 60_000;

export type { ImageUpdateEntry, NodeImageUpdateStatus };

/**
 * Images worth probing for a node: workspace default plus any per-agent override.
 * Go 代理本身不在这里，由 probeNode 按二进制摘要单独加一条 kind=runner。
 */
export async function collectNodeImages(
  db: Db,
  nodeId: string,
  _opts: { isLocal: boolean; runnerImage?: string | null },
): Promise<Array<{ image: string; kind: ImageUpdateKind }>> {
  const out = new Map<string, ImageUpdateKind>();
  out.set(DEFAULT_WORKSPACE_IMAGE, "workspace");

  const bound = await db
    .select({ workspaceImage: spaces.workspaceImage })
    .from(spaces)
    .where(eq(spaces.runtimeNodeId, nodeId));
  for (const row of bound) {
    const img = row.workspaceImage?.trim();
    if (img && !out.has(img)) out.set(img, "workspace");
  }
  return [...out].map(([image, kind]) => ({ image, kind }));
}

export type ImageUpdateScheduler = {
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
};

export type ImageUpdateCheckerOptions = {
  scheduler?: ImageUpdateScheduler;
  now?: () => number;
  intervalMs?: number;
  bootstrapDelayMs?: number;
  nodeProbeTimeoutMs?: number;
  drainTimeoutMs?: number;
};

const defaultScheduler: ImageUpdateScheduler = {
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval,
};

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
  scheduler: ImageUpdateScheduler,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = scheduler.setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    promise.then(
      (v) => {
        scheduler.clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        scheduler.clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export class ImageUpdateChecker {
  private timer: ReturnType<typeof setInterval> | null = null;
  private bootstrapTimer: ReturnType<typeof setTimeout> | null = null;
  /** Re-entrancy guard: a slow sweep must not overlap the next interval. */
  private activeSweep: Promise<void> | null = null;
  private readonly cache = new Map<string, NodeImageUpdateStatus>();
  private readonly inFlight = new Map<string, Promise<NodeImageUpdateStatus>>();
  private readonly scheduler: ImageUpdateScheduler;
  private readonly now: () => number;
  private readonly intervalMs: number;
  private readonly bootstrapDelayMs: number;
  private readonly nodeProbeTimeoutMs: number;
  private readonly drainTimeoutMs: number;

  constructor(
    private readonly db: Db,
    private readonly nodes: RuntimeNodeService,
    _docker?: DockerRuntime,
    opts: ImageUpdateCheckerOptions = {},
  ) {
    void _docker;
    this.scheduler = opts.scheduler ?? defaultScheduler;
    this.now = opts.now ?? Date.now;
    this.intervalMs = opts.intervalMs ?? CHECK_INTERVAL_MS;
    this.bootstrapDelayMs = opts.bootstrapDelayMs ?? 30_000;
    this.nodeProbeTimeoutMs = opts.nodeProbeTimeoutMs ?? NODE_PROBE_TIMEOUT_MS;
    this.drainTimeoutMs = opts.drainTimeoutMs ?? 5_000;
  }

  start(): void {
    if (this.timer || this.bootstrapTimer) return;
    this.timer = this.scheduler.setInterval(() => void this.runOnce(), this.intervalMs);
    this.timer.unref?.();
    // Delay the first sweep so Runners have time to register.
    this.bootstrapTimer = this.scheduler.setTimeout(() => {
      this.bootstrapTimer = null;
      void this.runOnce();
    }, this.bootstrapDelayMs);
    this.bootstrapTimer.unref?.();
    log.info("image_update_checker.started", { interval_ms: this.intervalMs });
  }

  stop(): void {
    if (this.timer) {
      this.scheduler.clearInterval(this.timer);
      this.timer = null;
    }
    // Previously leaked: stopping within 30s of boot still fired one sweep.
    if (this.bootstrapTimer) {
      this.scheduler.clearTimeout(this.bootstrapTimer);
      this.bootstrapTimer = null;
    }
  }

  async stopAndDrain(): Promise<void> {
    this.stop();
    const active = this.activeSweep;
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

  /** Cached status across all nodes, for the global indicator. */
  getAllStatuses(): NodeImageUpdateStatus[] {
    const now = this.now();
    return [...this.cache.values()].filter((e) => now - e.checkedAt <= STALE_AFTER_MS);
  }

  /**
   * Force a refresh for one node (user clicked "check"). This is the only path
   * allowed to fall back to `docker pull` for a digest, and only when asked.
   */
  async checkNode(nodeId: string, opts?: { allowPullFallback?: boolean; runnerOnly?: boolean }): Promise<NodeImageUpdateStatus> {
    const key = `${nodeId}:${Boolean(opts?.runnerOnly)}:${Boolean(opts?.allowPullFallback)}`;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const check = this.probeNode(nodeId, opts).then((status) => {
      const previous = this.cache.get(nodeId);
      if (opts?.runnerOnly && previous && !status.error) {
        const entries = [...status.entries, ...previous.entries.filter((entry) => entry.kind !== "runner")];
        // A fast agent probe must neither erase workspace results nor make old
        // workspace probes look freshly checked.
        this.cache.set(nodeId, { ...status, checkedAt: previous.checkedAt, entries,
          hasUpdates: entries.some((entry) => entry.updateAvailable),
          hasRunningStale: entries.some((entry) => entry.runningStale) });
      } else {
        this.cache.set(nodeId, status);
      }
      return status;
    }).finally(() => { this.inFlight.delete(key); });
    this.inFlight.set(key, check);
    return check;
  }

  async runOnce(): Promise<void> {
    if (this.activeSweep) {
      log.debug("image_update_checker.tick_skipped_overlap");
      return this.activeSweep;
    }
    const sweep = (async () => {
      const nodes = await this.db.query.runtimeNodes.findMany({
        where: inArray(runtimeNodes.kind, ["local", "computer", "server", "runner"]),
      });
      for (const node of nodes) {
        if (node.status !== "online") continue;
        try {
          const status = await withTimeout(
            this.probeNode(node.id),
            this.nodeProbeTimeoutMs,
            `节点 ${node.slug ?? node.id} 镜像探测`,
            this.scheduler,
          );
          this.cache.set(node.id, status);
        } catch (err) {
          this.cache.set(node.id, {
            nodeId: node.id,
            checkedAt: this.now(),
            entries: [],
            hasUpdates: false,
            hasRunningStale: false,
            error: err instanceof Error ? err.message : String(err),
          });
          // warn, not debug: a silently failing probe is indistinguishable from
          // "no updates" in the UI, which is exactly how this stayed unnoticed.
          log.warn("image_update_checker.node_failed", {
            nodeId: node.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    })().catch((err) => {
      log.warn("image_update_checker.tick_failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    });
    this.activeSweep = sweep;
    try {
      await sweep;
    } finally {
      if (this.activeSweep === sweep) this.activeSweep = null;
    }
  }

  private async probeNode(
    nodeId: string,
    opts?: { allowPullFallback?: boolean; runnerOnly?: boolean },
  ): Promise<NodeImageUpdateStatus> {
    try {
      const node = await this.db.query.runtimeNodes.findFirst({
        where: eq(runtimeNodes.id, nodeId),
      });
      if (!node) throw new Error(`runtime node ${nodeId} not found`);

      const isLocal = node.kind === "local";
      const wanted = opts?.runnerOnly ? [] : await collectNodeImages(this.db, nodeId, {
        isLocal,
        runnerImage: (node as { runnerImage?: string | null }).runnerImage ?? null,
      });
      const kindByImage = new Map(wanted.map((w) => [w.image, w.kind]));
      const images = wanted.map((w) => w.image);
      let entries: ImageUpdateEntry[] = [];

      const { client } = await this.nodes.requireRunnerClient(node.tenantId, nodeId, {
        allowOffline: true,
        skipHeartbeatRefresh: true,
      });
      const info = opts?.runnerOnly ? await client.systemVersion() : await client.ping();
      const host = ("hostInfo" in info ? info.hostInfo : undefined) as { platform?: string; arch?: string } | undefined;
      const extra = info as { sha256?: string; goos?: string; goarch?: string };
      const os = extra.goos ?? host?.platform ?? "";
      const arch = extra.goarch ?? host?.arch ?? "";
      const bin = await findAgentBinary(os, arch);
      if (bin && !isLocal) {
        const currentSha = extra.sha256;
        const currentVer = info.version ?? node.agentVersion ?? "";
        const updateAvailable = currentSha
          ? currentSha.toLowerCase() !== bin.sha256.toLowerCase()
          : Boolean(bin.version && currentVer && bin.version !== "dev" && currentVer !== bin.version);
        entries.push({
          image: `zakura-agent:${bin.version}`,
          localId: currentVer || null,
          localDigest: currentSha ?? currentVer ?? null,
          remoteDigest: bin.sha256,
          updateAvailable,
          runningStale: false,
          error: null,
          kind: "runner",
        });
      }

      // A computer without Docker still has a fully updatable host agent.
      const result = opts?.runnerOnly || ("docker" in info && info.docker?.ok === false)
        ? { images: [] }
        : await client.checkImageUpdates({ images, allowPullFallback: opts?.allowPullFallback === true })
          .catch((error: unknown) => ({ images: images.map((image) => ({
            image, localId: null, localDigest: null, remoteDigest: null,
            updateAvailable: false, runningStale: false,
            error: error instanceof Error ? error.message : String(error),
          })) }));
      entries = entries.concat(
        (result.images ?? []).map((e) => ({
          ...e,
          kind: kindByImage.get(e.image) ?? ("workspace" as ImageUpdateKind),
        })),
      );

      return {
        nodeId,
        checkedAt: this.now(),
        entries,
        hasUpdates: entries.some((e) => e.updateAvailable),
        hasRunningStale: entries.some((e) => e.runningStale),
        error: null,
      };
    } catch (err) {
      return {
        nodeId,
        checkedAt: this.now(),
        entries: [],
        hasUpdates: false,
        hasRunningStale: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
