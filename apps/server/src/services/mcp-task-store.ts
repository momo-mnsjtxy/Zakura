/**
 * Zakura Agent MCP TaskStore（SDK experimental Tasks + 托管 input_required）
 *
 * - 托管任务：InMemoryTaskStore；可暂停等待 inputResponses（tasks/update）
 * - 代理任务：下游 CreateTaskResult → zp_{slug}__{id}，经 Provider.invokeRaw 转发
 */
import {
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
  type CreateTaskOptions,
  type TaskMessageQueue,
  type TaskStore,
} from "@modelcontextprotocol/sdk/experimental/tasks";
import type {
  Request,
  RequestId,
  Result,
  Task,
} from "@modelcontextprotocol/sdk/types.js";
import { globalRegistry } from "@zakura/core";
import { randomBytes } from "node:crypto";
import type { HostedInputRequest } from "../mcp/agent-capabilities.js";
import type { Orchestrator } from "./orchestrator.js";

export const PROXY_TASK_PREFIX = "zp_";

export type ProxiedTaskRef = {
  publicTaskId: string;
  tenantId: string;
  instanceId: string;
  providerId: string;
  localTaskId: string;
  slug: string;
  /** When known, only this MCP transport session may enumerate/read the task. */
  sessionId?: string;
  registeredAt: number;
  expiresAt: number | null;
};

type HostedPendingInput = {
  inputRequests: Record<string, HostedInputRequest>;
  resolve: (responses: Record<string, unknown>) => void;
  reject: (err: Error) => void;
};

export type TaskView = Task & {
  /** 2026 Tasks 扩展：input_required 时的待处理请求 */
  inputRequests?: Record<string, HostedInputRequest>;
};

function nowIso(): string {
  return new Date().toISOString();
}

export function qualifyProxyTaskId(slug: string, localTaskId: string): string {
  return `${PROXY_TASK_PREFIX}${slug}__${localTaskId}`;
}

export function parseProxyTaskId(
  taskId: string,
): { slug: string; localTaskId: string } | null {
  if (!taskId.startsWith(PROXY_TASK_PREFIX)) return null;
  const rest = taskId.slice(PROXY_TASK_PREFIX.length);
  const idx = rest.indexOf("__");
  if (idx <= 0) return null;
  return {
    slug: rest.slice(0, idx),
    localTaskId: rest.slice(idx + 2),
  };
}

function normalizeUpstreamTask(
  raw: Record<string, unknown>,
  publicTaskId: string,
): Task {
  const statusRaw = typeof raw.status === "string" ? raw.status : "working";
  const status = (
    ["working", "input_required", "completed", "failed", "cancelled"].includes(
      statusRaw,
    )
      ? statusRaw
      : "working"
  ) as Task["status"];
  return {
    taskId: publicTaskId,
    status,
    ttl: typeof raw.ttl === "number" ? raw.ttl : raw.ttl === null ? null : 3_600_000,
    createdAt: typeof raw.createdAt === "string" ? raw.createdAt : nowIso(),
    lastUpdatedAt:
      typeof raw.lastUpdatedAt === "string" ? raw.lastUpdatedAt : nowIso(),
    ...(typeof raw.pollInterval === "number"
      ? { pollInterval: raw.pollInterval }
      : {}),
    ...(typeof raw.statusMessage === "string"
      ? { statusMessage: raw.statusMessage }
      : {}),
  };
}

export class ZakuraTaskStore implements TaskStore {
  private readonly hosted = new InMemoryTaskStore();
  private readonly proxies = new Map<string, ProxiedTaskRef>();
  private readonly proxyCache = new Map<string, Task>();
  private readonly proxyResults = new Map<string, Result>();
  private readonly pendingInputs = new Map<string, HostedPendingInput>();
  private readonly now: () => number;
  private readonly nonce: () => string;
  private readonly maxProxyTasks: number;

  constructor(
    private readonly orchestrator: Orchestrator,
    opts: { now?: () => number; nonce?: () => string; maxProxyTasks?: number } = {},
  ) {
    this.now = opts.now ?? Date.now;
    this.nonce = opts.nonce ?? (() => randomBytes(12).toString("base64url"));
    this.maxProxyTasks = Math.max(1, opts.maxProxyTasks ?? 1_024);
  }

  private removeProxy(taskId: string): void {
    this.proxies.delete(taskId);
    this.proxyCache.delete(taskId);
    this.proxyResults.delete(taskId);
  }

  private pruneProxyTasks(): void {
    const now = this.now();
    for (const [taskId, ref] of this.proxies) {
      if (ref.expiresAt !== null && ref.expiresAt <= now) this.removeProxy(taskId);
    }
    if (this.proxies.size <= this.maxProxyTasks) return;
    const oldest = [...this.proxies.values()].sort((a, b) => a.registeredAt - b.registeredAt);
    for (const ref of oldest) {
      if (this.proxies.size <= this.maxProxyTasks) break;
      this.removeProxy(ref.publicTaskId);
    }
  }

  private proxyRef(taskId: string, sessionId?: string): ProxiedTaskRef | null {
    this.pruneProxyTasks();
    const ref = this.proxies.get(taskId);
    if (!ref) return null;
    if (ref.sessionId && ref.sessionId !== sessionId) return null;
    return ref;
  }

  /** 注册下游 CreateTaskResult，返回对外 task 快照 */
  registerProxyTask(opts: {
    tenantId: string;
    instanceId: string;
    providerId: string;
    slug: string;
    upstream: {
      taskId: string;
      status: string;
      ttl: number | null;
      createdAt: string;
      lastUpdatedAt: string;
      pollInterval?: number;
      statusMessage?: string;
    };
    sessionId?: string;
  }): Task {
    this.pruneProxyTasks();
    const existing = [...this.proxies.values()].find(
      (ref) =>
        ref.tenantId === opts.tenantId &&
        ref.instanceId === opts.instanceId &&
        ref.localTaskId === opts.upstream.taskId &&
        ref.sessionId === opts.sessionId,
    );
    if (existing) {
      const refreshedAt = this.now();
      existing.registeredAt = refreshedAt;
      existing.expiresAt =
        typeof opts.upstream.ttl === "number" && opts.upstream.ttl >= 0
          ? refreshedAt + opts.upstream.ttl
          : null;
      const task = normalizeUpstreamTask(
        opts.upstream as unknown as Record<string, unknown>,
        existing.publicTaskId,
      );
      this.proxyCache.set(existing.publicTaskId, task);
      return task;
    }
    let publicTaskId = "";
    do {
      // Preserve the exported qualify/parse format while keeping tenant and
      // upstream ids out of the capability presented to clients.
      publicTaskId = qualifyProxyTaskId(`${opts.slug}-${this.nonce()}`, "task");
    } while (this.proxies.has(publicTaskId));
    const registeredAt = this.now();
    const ttl = opts.upstream.ttl;
    this.proxies.set(publicTaskId, {
      publicTaskId,
      tenantId: opts.tenantId,
      instanceId: opts.instanceId,
      providerId: opts.providerId,
      localTaskId: opts.upstream.taskId,
      slug: opts.slug,
      sessionId: opts.sessionId,
      registeredAt,
      expiresAt: typeof ttl === "number" && ttl >= 0 ? registeredAt + ttl : null,
    });
    const task = normalizeUpstreamTask(
      opts.upstream as unknown as Record<string, unknown>,
      publicTaskId,
    );
    this.proxyCache.set(publicTaskId, task);
    this.pruneProxyTasks();
    return task;
  }

  /**
   * 托管任务进入 input_required，阻塞直到 tasks/update 提交 inputResponses。
   */
  requestHostedInput(
    taskId: string,
    inputRequests: Record<string, HostedInputRequest>,
    statusMessage = "Waiting for user input",
  ): Promise<Record<string, unknown>> {
    this.pruneProxyTasks();
    if (this.proxies.has(taskId)) {
      return Promise.reject(new Error("Cannot request input on proxied upstream task"));
    }
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const previous = this.pendingInputs.get(taskId);
      if (previous) previous.reject(new Error("Input request superseded by a newer request"));
      const pending = { inputRequests, resolve, reject };
      this.pendingInputs.set(taskId, pending);
      void this.hosted
        .updateTaskStatus(taskId, "input_required", statusMessage)
        .catch((error) => {
          if (this.pendingInputs.get(taskId) === pending) this.pendingInputs.delete(taskId);
          reject(error);
        });
    });
  }

  /** 处理 tasks/update（托管）；代理任务尽量转发 tasks/update */
  async applyTaskUpdate(
    taskId: string,
    inputResponses?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<TaskView> {
    const pending = this.pendingInputs.get(taskId);
    if (pending) {
      this.pendingInputs.delete(taskId);
      await this.hosted.updateTaskStatus(taskId, "working", "Resumed after input");
      pending.resolve(inputResponses ?? {});
      const task = await this.hosted.getTask(taskId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      return task;
    }

    const ref = this.proxyRef(taskId, sessionId);
    if (ref) {
      try {
        await this.upstreamRpc(ref, "tasks/update", {
          taskId: ref.localTaskId,
          ...(inputResponses ? { inputResponses } : {}),
        });
      } catch {
        /* 下游可能尚无 tasks/update */
      }
      const task = await this.getTask(taskId, sessionId);
      if (!task) throw new Error(`Task not found: ${taskId}`);
      return task;
    }

    throw new Error(`No pending input for task: ${taskId}`);
  }

  private enrichView(task: Task | null): TaskView | null {
    if (!task) return null;
    const pending = this.pendingInputs.get(task.taskId);
    if (!pending) return task;
    return { ...task, inputRequests: pending.inputRequests };
  }

  private async upstreamRpc(
    ref: ProxiedTaskRef,
    method: string,
    params?: Record<string, unknown>,
  ): Promise<unknown> {
    const handle = await this.orchestrator.toHandle(ref.tenantId, ref.instanceId);
    const plugin = globalRegistry.get(ref.providerId);
    if (typeof plugin.invokeRaw !== "function") {
      throw new Error(`Provider ${ref.providerId} does not support task proxy (${method})`);
    }
    return plugin.invokeRaw(handle, method, params);
  }

  async createTask(
    taskParams: CreateTaskOptions,
    requestId: RequestId,
    request: Request,
    sessionId?: string,
  ): Promise<Task> {
    return this.hosted.createTask(taskParams, requestId, request, sessionId);
  }

  async getTask(taskId: string, sessionId?: string): Promise<TaskView | null> {
    const hosted = await this.hosted.getTask(taskId, sessionId);
    if (hosted) return this.enrichView(hosted);

    const ref = this.proxyRef(taskId, sessionId);
    if (!ref) return null;

    try {
      const raw = (await this.upstreamRpc(ref, "tasks/get", {
        taskId: ref.localTaskId,
      })) as Record<string, unknown>;
      const task = normalizeUpstreamTask(raw, taskId);
      this.proxyCache.set(taskId, task);
      // 透传下游 inputRequests（若有）
      if (raw.inputRequests && typeof raw.inputRequests === "object") {
        return {
          ...task,
          inputRequests: raw.inputRequests as Record<string, HostedInputRequest>,
        };
      }
      return task;
    } catch (err) {
      const cached = this.proxyCache.get(taskId);
      if (cached) {
        return {
          ...cached,
          statusMessage: err instanceof Error ? err.message : String(err),
        };
      }
      throw err;
    }
  }

  async storeTaskResult(
    taskId: string,
    status: "completed" | "failed",
    result: Result,
    sessionId?: string,
  ): Promise<void> {
    const pending = this.pendingInputs.get(taskId);
    if (pending) {
      this.pendingInputs.delete(taskId);
      pending.reject(new Error(`Task ${status} while waiting for input`));
    }
    const ref = this.proxyRef(taskId, sessionId);
    if (ref) {
      this.proxyResults.set(taskId, result);
      const prev = this.proxyCache.get(taskId);
      if (prev) {
        this.proxyCache.set(taskId, {
          ...prev,
          status,
          lastUpdatedAt: nowIso(),
        });
      }
      return;
    }
    return this.hosted.storeTaskResult(taskId, status, result, sessionId);
  }

  async getTaskResult(taskId: string, sessionId?: string): Promise<Result> {
    const ref = this.proxyRef(taskId, sessionId);
    if (ref && this.proxyResults.has(taskId)) {
      return this.proxyResults.get(taskId)!;
    }
    if (ref) {
      const raw = await this.upstreamRpc(ref, "tasks/result", {
        taskId: ref.localTaskId,
      });
      if (raw && typeof raw === "object") {
        this.proxyResults.set(taskId, raw as Result);
        return raw as Result;
      }
      return {
        content: [{ type: "text", text: JSON.stringify(raw ?? null) }],
      } as Result;
    }
    return this.hosted.getTaskResult(taskId, sessionId);
  }

  async updateTaskStatus(
    taskId: string,
    status: Task["status"],
    statusMessage?: string,
    sessionId?: string,
  ): Promise<void> {
    if (status === "cancelled") {
      const pending = this.pendingInputs.get(taskId);
      if (pending) {
        this.pendingInputs.delete(taskId);
        pending.reject(new Error("Task cancelled"));
      }
    }

    const ref = this.proxyRef(taskId, sessionId);
    if (ref) {
      if (status === "cancelled") {
        try {
          await this.upstreamRpc(ref, "tasks/cancel", {
            taskId: ref.localTaskId,
          });
        } catch {
          /* cooperative cancel */
        }
      }
      const prev = this.proxyCache.get(taskId);
      if (prev) {
        this.proxyCache.set(taskId, {
          ...prev,
          status,
          lastUpdatedAt: nowIso(),
          ...(statusMessage ? { statusMessage } : {}),
        });
      }
      return;
    }
    return this.hosted.updateTaskStatus(taskId, status, statusMessage, sessionId);
  }

  async listTasks(
    cursor?: string,
    sessionId?: string,
  ): Promise<{ tasks: Task[]; nextCursor?: string }> {
    const hosted = await this.hosted.listTasks(cursor, sessionId);
    this.pruneProxyTasks();
    const proxied = sessionId
      ? [...this.proxies.values()]
          .filter((ref) => ref.sessionId === sessionId)
          .map((ref) => this.proxyCache.get(ref.publicTaskId))
          .filter((task): task is Task => Boolean(task))
      : [];
    if (!cursor) {
      return {
        tasks: [
          ...hosted.tasks.map((t) => this.enrichView(t)!),
          ...proxied,
        ],
        nextCursor: hosted.nextCursor,
      };
    }
    return hosted;
  }

  cleanup(): void {
    for (const [, p] of this.pendingInputs) {
      p.reject(new Error("Task store cleaned up"));
    }
    this.pendingInputs.clear();
    this.proxies.clear();
    this.proxyCache.clear();
    this.proxyResults.clear();
    this.hosted.cleanup();
  }

  cleanupTenant(tenantId: string): number {
    let removed = 0;
    for (const [taskId, ref] of this.proxies) {
      if (ref.tenantId !== tenantId) continue;
      this.removeProxy(taskId);
      removed += 1;
    }
    return removed;
  }
}

export function createAgentTaskInfrastructure(orchestrator: Orchestrator): {
  taskStore: ZakuraTaskStore;
  taskMessageQueue: TaskMessageQueue;
} {
  return {
    taskStore: new ZakuraTaskStore(orchestrator),
    taskMessageQueue: new InMemoryTaskMessageQueue(),
  };
}
