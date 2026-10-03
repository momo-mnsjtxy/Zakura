/**
 * 平台 OAuth REST 连接器共用底座：token 刷新和工具分发。
 * 各厂商只声明 product / tools / HTTP 调用。
 */
import type { InstanceHandle, ProviderPlugin } from "@zakura/core";
import { textResult } from "@zakura/core";
import type { McpToolDef, ProviderConfigSchema } from "@zakura/shared";
import { eq } from "drizzle-orm";
import { componentInstances } from "../db/schema.js";
import type { AppConfig } from "../config.js";
import { McpUpstreamOauthService } from "../services/mcp-upstream-oauth.js";
import { applyOauthTokensToConfig } from "./generic-mcp.js";
import { readInstanceToken } from "./credential-config.js";
import {
  connectorJson,
  type ConnectorAuthScheme,
  type ConnectorRequestInit,
} from "./connector-http.js";

export type OauthRestCallTool = (
  product: string,
  toolName: string,
  token: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

export type OauthRestHealth = (token: string) => Promise<void>;

export type OauthRestProviderSpec = {
  id: string;
  name: string;
  description: string;
  products: readonly string[];
  toolDefs: Record<string, McpToolDef[]>;
  callTool: OauthRestCallTool;
  health?: OauthRestHealth;
};

type RuntimeSlot = { config: AppConfig | null; db: unknown };

export function createOauthRestProvider(spec: OauthRestProviderSpec) {
  const runtime: RuntimeSlot = { config: null, db: null };
  const productSet = new Set(spec.products);
  const refreshes = new Map<string, Promise<Record<string, unknown>>>();

  function builtinUrl(product: string): string {
    return `zakura://${spec.id}/${product}`;
  }

  function resolveProduct(value: string): string | null {
    const raw = value.trim().toLowerCase();
    if (productSet.has(raw)) return raw;
    const matched = raw.match(new RegExp(`^zakura:\\/\\/${spec.id}\\/([a-z0-9-]+)$`));
    return matched && productSet.has(matched[1]!) ? matched[1]! : null;
  }

  function parseProduct(config: Record<string, unknown>): string {
    const value =
      typeof config.product === "string"
        ? config.product
        : typeof config.mcpUrl === "string"
          ? config.mcpUrl
          : "";
    const product = resolveProduct(value);
    if (!product) {
      throw new Error(`config.product 须为 ${spec.products.join(" | ")}`);
    }
    return product;
  }

  const configSchema: ProviderConfigSchema = {
    type: "object",
    title: spec.name,
    required: ["product"],
    properties: {
      product: { type: "string", enum: [...spec.products] },
      oauthAccessToken: { type: "string", format: "password" },
      oauthRefreshToken: { type: "string", format: "password" },
      oauthExpiresAt: { type: "number" },
      oauthClientId: { type: "string" },
      oauthClientSecret: { type: "string", format: "password" },
      oauthTokenEndpoint: { type: "string" },
      apiToken: { type: "string", format: "password" },
      authRequired: { type: "boolean" },
    },
  };

  async function refreshAndPersist(
    handle: InstanceHandle,
    current: Record<string, unknown>,
    appConfig: AppConfig,
  ): Promise<Record<string, unknown>> {
    const existing = refreshes.get(handle.id);
    if (existing) return existing;
    const operation = (async () => {
      const tokenEndpoint = String(current.oauthTokenEndpoint ?? "").trim();
      if (!tokenEndpoint) throw new Error(`${spec.name} OAuth 配置缺少 token endpoint`);
      const tokens = await new McpUpstreamOauthService(appConfig).refresh({
        accessToken: String(current.oauthAccessToken ?? ""),
        refreshToken: String(current.oauthRefreshToken),
        expiresAt: Number(current.oauthExpiresAt ?? 0),
        clientId: String(current.oauthClientId),
        clientSecret:
          typeof current.oauthClientSecret === "string" ? current.oauthClientSecret : undefined,
        tokenEndpoint,
      });
      const next = applyOauthTokensToConfig(current, tokens);
      next.authRequired = false;
      if (runtime.db) {
        const { encryptJson } = await import("@zakura/core");
        // Persist before publishing the refreshed value to concurrent tool calls. A
        // failed write therefore cannot create an in-memory-only credential state.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        await (runtime.db as any)
          .update(componentInstances)
          .set({ configEnc: encryptJson(appConfig.secret, next), updatedAt: new Date() })
          .where(eq(componentInstances.id, handle.id));
      }
      handle.config = next;
      return next;
    })().finally(() => {
      if (refreshes.get(handle.id) === operation) refreshes.delete(handle.id);
    });
    refreshes.set(handle.id, operation);
    return operation;
  }

  async function accessToken(handle: InstanceHandle): Promise<string> {
    let current: Record<string, unknown> = { ...handle.config };
    const expiresAt = Number(current.oauthExpiresAt ?? 0);
    const appConfig = runtime.config;
    if (
      (!current.oauthAccessToken || expiresAt <= Math.floor(Date.now() / 1000) + 120) &&
      current.oauthRefreshToken &&
      current.oauthClientId &&
      appConfig
    ) {
      current = await refreshAndPersist(handle, current, appConfig);
    }
    const token = readInstanceToken(current);
    if (!token) throw new Error(`AUTH_REQUIRED: 请先完成 ${spec.name} OAuth 授权`);
    return token;
  }

  function injectRuntime(config: AppConfig, db: unknown): void {
    runtime.config = config;
    runtime.db = db;
  }

  function createProvider(): ProviderPlugin {
    return {
      id: spec.id,
      name: spec.name,
      description: spec.description,
      version: "1.0.0",
      category: "connector",
      capabilities: ["tools", "builtin"],
      configSchema,
      validateConfig(config) {
        const product = parseProduct(config);
        return { ...config, product, mcpUrl: builtinUrl(product) };
      },
      createRuntimeSpec(config) {
        return { containers: [], endpointTemplate: builtinUrl(parseProduct(config)) };
      },
      async healthCheck(handle) {
        try {
          const token = await accessToken(handle);
          if (spec.health) await spec.health(token);
          return { status: "healthy", message: `ok (${parseProduct(handle.config)})` };
        } catch (error) {
          return {
            status: "unhealthy",
            message: error instanceof Error ? error.message : String(error),
          };
        }
      },
      async listTools(handle) {
        return spec.toolDefs[parseProduct(handle.config)] ?? [];
      },
      async callTool(handle, name, args) {
        try {
          const product = parseProduct(handle.config);
          const result = await spec.callTool(product, name, await accessToken(handle), args);
          return textResult(JSON.stringify(result, null, 2));
        } catch (error) {
          return textResult(error instanceof Error ? error.message : String(error), true);
        }
      },
    };
  }

  return { createProvider, injectRuntime, resolveProduct, builtinUrl, parseProduct };
}

export async function restJson<T>(
  url: string,
  token: string,
  init?: RequestInit & {
    json?: unknown;
    authScheme?: ConnectorAuthScheme;
    timeoutMs?: number;
    retry?: ConnectorRequestInit["retry"];
    dedupe?: boolean;
  },
): Promise<T> {
  return connectorJson<T>(url, token, init as ConnectorRequestInit);
}

export function str(args: Record<string, unknown>, key: string): string {
  return typeof args[key] === "string" ? String(args[key]).trim() : "";
}

export function int(args: Record<string, unknown>, key: string, fallback?: number): number | undefined {
  if (typeof args[key] === "number") return args[key] as number;
  if (typeof args[key] === "string" && args[key]) return Number(args[key]);
  return fallback;
}
