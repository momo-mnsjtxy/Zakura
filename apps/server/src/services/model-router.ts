import type {
  ModelCapability,
  ModelChatInvokeOptions,
  ModelChatMessage,
  ModelChatResult,
  ModelEmbeddingResult,
  ModelEvaluationInput,
  ModelEvaluationResult,
  ModelImageResult,
  ModelRerankResult,
} from "@zakura/shared";
import type { Db } from "../db/client.js";
import {
  executeChat,
  executeChatStream,
  executeEmbed,
  executeEvaluation,
  executeImage,
  executeRerank,
  executeWithFallback,
  isAbortError,
  isRetryableModelError,
  withModelRetries,
  RouteResolver,
  type ChatStreamCallbacks,
  type RouteResolveQuery,
} from "../model-router/index.js";
import {
  ModelRouteChainError,
  type RouteFailure,
} from "../model-router/executor.js";
import type { ResolvedRoute } from "../model-router/types.js";

export type RouteResolveInput = RouteResolveQuery;

/**
 * The stream reached the caller before its provider failed. Replaying it here
 * would duplicate visible text/tool state, so rollback/restart belongs to the
 * run layer that owns the published deltas.
 */
export class ChatStreamPartialError extends Error {
  readonly emitted = true;
  readonly retryable: boolean;

  constructor(message: string, cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ChatStreamPartialError";
    this.retryable = isRetryableModelError(cause);
  }
}

type RoutedResult<T> = T & {
  routeId: string;
  routeSlug: string;
  alias: string;
  upstreamId: string;
};

type ModelRouteResolver = Pick<RouteResolver, "resolveChain" | "invalidateTenant">;

function withRouteIdentity<T extends object>(
  result: T,
  route: ResolvedRoute,
): RoutedResult<T> {
  return {
    ...result,
    routeId: route.routeId,
    routeSlug: route.routeSlug,
    alias: route.alias,
    upstreamId: route.upstream.id,
  };
}

/** Tenant-aware model business service with provider retry/fallback semantics. */
export class ModelRouterService {
  private readonly resolver: ModelRouteResolver;

  constructor(db: Db, resolver?: ModelRouteResolver) {
    this.resolver = resolver ?? new RouteResolver(db);
  }

  invalidateCache(tenantId: string): void {
    this.resolver.invalidateTenant(tenantId);
  }

  async resolveRoute(
    tenantId: string,
    input: RouteResolveInput,
  ): Promise<ResolvedRoute | null> {
    return (await this.resolver.resolveChain(tenantId, input))[0] ?? null;
  }

  private resolveChain(
    tenantId: string,
    input: RouteResolveInput,
  ): Promise<ResolvedRoute[]> {
    return this.resolver.resolveChain(tenantId, {
      strategy: "weighted",
      ...input,
    });
  }

  private async invokeBuffered<T extends object>(
    tenantId: string,
    capability: ModelCapability,
    query: RouteResolveInput,
    invoke: (route: ResolvedRoute) => Promise<T>,
  ): Promise<RoutedResult<T>> {
    const routes = await this.resolveChain(tenantId, query);
    const { result, route } = await executeWithFallback(
      routes,
      capability,
      (_adapter, candidate) => invoke(candidate),
    );
    return withRouteIdentity(result, route);
  }

  chat(
    tenantId: string,
    messages: ModelChatMessage[],
    query: RouteResolveInput,
    options?: ModelChatInvokeOptions,
  ): Promise<RoutedResult<ModelChatResult>> {
    return this.invokeBuffered(tenantId, "chat", query, (route) =>
      executeChat(route, messages, options),
    );
  }

  evaluate(
    tenantId: string,
    input: ModelEvaluationInput,
    query?: { alias?: string; routeId?: string },
  ): Promise<RoutedResult<ModelEvaluationResult>> {
    return this.invokeBuffered(
      tenantId,
      "evaluation",
      { capability: "evaluation", ...query },
      (route) => executeEvaluation(route, input),
    );
  }

  /**
   * Stream with two replay barriers:
   * - before output: retry the current provider, then fail over
   * - after output: stop immediately and surface ChatStreamPartialError
   */
  async chatStream(
    tenantId: string,
    messages: ModelChatMessage[],
    query: RouteResolveInput,
    options: ModelChatInvokeOptions | undefined,
    callbacks: ChatStreamCallbacks,
  ): Promise<RoutedResult<ModelChatResult>> {
    const routes = await this.resolveChain(tenantId, query);
    if (routes.length === 0) throw new Error("未配置 chat 模型路由");
    const failures: RouteFailure[] = [];

    for (const route of routes) {
      let emitted = false;
      const outputGate: ChatStreamCallbacks = {
        signal: callbacks.signal,
        onDelta: (text) => {
          if (text) emitted = true;
          callbacks.onDelta?.(text);
        },
        onReasoningDelta: (text) => {
          if (text) emitted = true;
          callbacks.onReasoningDelta?.(text);
        },
      };

      try {
        const result = await withModelRetries(
          () => executeChatStream(route, messages, options, outputGate),
          {
            attempts: 2,
            signal: callbacks.signal,
            shouldRetry: (error) => !emitted && isRetryableModelError(error),
          },
        );
        return withRouteIdentity(result, route);
      } catch (error) {
        if (isAbortError(error) || callbacks.signal?.aborted) throw error;
        if (emitted) {
          throw new ChatStreamPartialError(
            `${route.routeSlug}: 流式输出中断（${
              error instanceof Error ? error.message : String(error)
            }）`,
            error,
          );
        }
        failures.push({
          routeId: route.routeId,
          routeSlug: route.routeSlug,
          upstreamId: route.upstream.id,
          retryable: isRetryableModelError(error),
          error,
        });
      }
    }
    throw new ModelRouteChainError("chat", failures);
  }

  embed(
    tenantId: string,
    texts: string[],
    query: RouteResolveInput,
  ): Promise<RoutedResult<ModelEmbeddingResult>> {
    return this.invokeBuffered(tenantId, "embedding", query, (route) =>
      executeEmbed(route, texts),
    );
  }

  rerank(
    tenantId: string,
    search: string,
    documents: string[],
    query: RouteResolveInput,
  ): Promise<RoutedResult<ModelRerankResult>> {
    return this.invokeBuffered(tenantId, "rerank", query, (route) =>
      executeRerank(route, search, documents),
    );
  }

  generateImage(
    tenantId: string,
    prompt: string,
    query: RouteResolveInput,
  ): Promise<RoutedResult<ModelImageResult>> {
    return this.invokeBuffered(tenantId, "image", query, (route) =>
      executeImage(route, prompt),
    );
  }
}
