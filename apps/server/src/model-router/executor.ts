import type {
  ModelCapability,
  ModelChatInvokeOptions,
  ModelChatMessage,
  ModelChatResult,
  ModelEmbeddingResult,
  ModelEvaluationInput,
  ModelEvaluationResult,
  ModelImageResult,
  ModelReasoningOptions,
  ModelRerankResult,
} from "@zakura/shared";
import type { ChatStreamCallbacks, ModelProtocolAdapter } from "./adapter.js";
import {
  isAbortError,
  isRetryableModelError,
  withModelRetries,
} from "./http.js";
import { normalizeToolCallHistory } from "./messages.js";
import { hydrateRoute, isUnauthorizedUpstream } from "./oauth-hook.js";
import { resolveAdapterForCapability } from "./registry.js";
import type { ResolvedRoute } from "./types.js";

function assertCapability(route: ResolvedRoute, expected: ModelCapability): void {
  if (route.capability !== expected) {
    throw new Error(
      `路由 ${route.routeSlug} 能力为 ${route.capability}，无法用于 ${expected}`,
    );
  }
}

/** A serializable account of one exhausted route in a fallback chain. */
export type RouteFailure = {
  routeId: string;
  routeSlug: string;
  upstreamId: string;
  retryable: boolean;
  error: unknown;
};

/** All configured routes failed without caller cancellation. */
export class ModelRouteChainError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly capability: ModelCapability,
    readonly failures: RouteFailure[],
  ) {
    super(
      `所有 ${capability} 路由均失败:\n${failures
        .map((failure) =>
          `${failure.routeSlug}: ${
            failure.error instanceof Error
              ? failure.error.message
              : String(failure.error)
          }`,
        )
        .join("\n")}`,
    );
    this.name = "ModelRouteChainError";
    this.retryable = failures.some((failure) => failure.retryable);
    this.cause = failures.at(-1)?.error;
  }
}

/**
 * Hydrate subscription credentials, select the capability adapter, and retry a
 * 401 once after a forced refresh. This boundary applies uniformly to chat,
 * embedding, rerank, image, and evaluation invocations.
 */
async function invokeOnRoute<T>(
  route: ResolvedRoute,
  capability: ModelCapability,
  operation: (adapter: ModelProtocolAdapter, route: ResolvedRoute) => Promise<T>,
): Promise<T> {
  assertCapability(route, capability);
  let hydrated = await hydrateRoute(route);
  let adapter = resolveAdapterForCapability(hydrated.upstream.protocol, capability);
  try {
    return await operation(adapter, hydrated);
  } catch (error) {
    if (!isUnauthorizedUpstream(error) || isAbortError(error)) throw error;
    hydrated = await hydrateRoute(hydrated, { forceRefresh: true });
    adapter = resolveAdapterForCapability(hydrated.upstream.protocol, capability);
    return operation(adapter, hydrated);
  }
}

function normalizeInvokeReasoning(
  route: ResolvedRoute,
  reasoning: ModelReasoningOptions,
): ModelReasoningOptions | undefined {
  if (route.meta?.reasoning === false) return undefined;
  const levels = route.meta?.reasoningLevels?.map((level) => level.toLowerCase());
  if (!levels) return reasoning;
  if (levels.length === 0) return undefined;
  if (reasoning.enabled === false) {
    return levels.includes("none") ? { enabled: false } : undefined;
  }
  if (reasoning.effort && !levels.includes(reasoning.effort.toLowerCase())) {
    return undefined;
  }
  return reasoning;
}

/** Overlay per-invocation settings without mutating cached route objects. */
export function applyInvokeRouteOptions(
  route: ResolvedRoute,
  invokeOptions?: ModelChatInvokeOptions,
): ResolvedRoute {
  const override = invokeOptions?.routeOptions;
  if (!override || Object.keys(override).length === 0) return route;

  const options = {
    ...route.options,
    ...override,
    extensions: {
      ...(route.options.extensions ?? {}),
      ...(override.extensions ?? {}),
    },
  };
  if (override.reasoning) {
    options.reasoning = normalizeInvokeReasoning(route, override.reasoning);
  }
  return { ...route, options };
}

export async function executeChat(
  route: ResolvedRoute,
  messages: ModelChatMessage[],
  options?: ModelChatInvokeOptions,
): Promise<ModelChatResult> {
  const history = normalizeToolCallHistory(messages);
  return invokeOnRoute(route, "chat", async (adapter, hydrated) => {
    if (!adapter.chat) throw new Error(`协议 ${adapter.protocol} 未实现 chat`);
    return adapter.chat(applyInvokeRouteOptions(hydrated, options), history, options);
  });
}

export async function executeChatStream(
  route: ResolvedRoute,
  messages: ModelChatMessage[],
  options: ModelChatInvokeOptions | undefined,
  callbacks: ChatStreamCallbacks,
): Promise<ModelChatResult> {
  const history = normalizeToolCallHistory(messages);
  return invokeOnRoute(route, "chat", async (adapter, hydrated) => {
    const configured = applyInvokeRouteOptions(hydrated, options);
    if (adapter.chatStream) {
      return adapter.chatStream(configured, history, options, callbacks);
    }
    if (!adapter.chat) throw new Error(`协议 ${adapter.protocol} 未实现 chat`);
    const result = await adapter.chat(configured, history, options);
    if (result.content) callbacks.onDelta?.(result.content);
    return result;
  });
}

export function executeEmbed(
  route: ResolvedRoute,
  texts: string[],
): Promise<ModelEmbeddingResult> {
  return invokeOnRoute(route, "embedding", (adapter, hydrated) => {
    if (!adapter.embed) throw new Error(`协议 ${adapter.protocol} 未实现 embed`);
    return adapter.embed(hydrated, texts);
  });
}

export function executeRerank(
  route: ResolvedRoute,
  query: string,
  documents: string[],
): Promise<ModelRerankResult> {
  return invokeOnRoute(route, "rerank", (adapter, hydrated) => {
    if (!adapter.rerank) throw new Error(`协议 ${adapter.protocol} 未实现 rerank`);
    return adapter.rerank(hydrated, query, documents);
  });
}

export function executeImage(
  route: ResolvedRoute,
  prompt: string,
): Promise<ModelImageResult> {
  return invokeOnRoute(route, "image", (adapter, hydrated) => {
    if (!adapter.generateImage) {
      throw new Error(`协议 ${adapter.protocol} 未实现 generateImage`);
    }
    return adapter.generateImage(hydrated, prompt);
  });
}

/**
 * Provider-independent route attempt state machine. A transient failure is
 * retried on the same provider before moving to the next configured route.
 * Explicit cancellation is terminal and can never fall through to a provider
 * the user did not intend to call after cancelling.
 */
export async function executeWithFallback<T>(
  routes: ResolvedRoute[],
  capability: ModelCapability,
  operation: (adapter: ModelProtocolAdapter, route: ResolvedRoute) => Promise<T>,
  options?: {
    attemptsPerRoute?: number;
    baseDelayMs?: number;
    signal?: AbortSignal;
  },
): Promise<{ result: T; route: ResolvedRoute }> {
  if (routes.length === 0) throw new Error(`未配置 ${capability} 模型路由`);
  const failures: RouteFailure[] = [];

  for (const route of routes) {
    assertCapability(route, capability);
    const adapter = resolveAdapterForCapability(route.upstream.protocol, capability);
    try {
      const result = await withModelRetries(
        () => operation(adapter, route),
        {
          attempts: options?.attemptsPerRoute ?? 2,
          baseDelayMs: options?.baseDelayMs,
          signal: options?.signal,
        },
      );
      return { result, route };
    } catch (error) {
      if (isAbortError(error) || options?.signal?.aborted) throw error;
      failures.push({
        routeId: route.routeId,
        routeSlug: route.routeSlug,
        upstreamId: route.upstream.id,
        retryable: isRetryableModelError(error),
        error,
      });
    }
  }
  throw new ModelRouteChainError(capability, failures);
}

export function executeEvaluation(
  route: ResolvedRoute,
  input: ModelEvaluationInput,
): Promise<ModelEvaluationResult> {
  return invokeOnRoute(route, "evaluation", (adapter, hydrated) => {
    if (!adapter.evaluate) {
      throw new Error(`协议 ${adapter.protocol} 不支持评估能力`);
    }
    return adapter.evaluate(hydrated, input);
  });
}
