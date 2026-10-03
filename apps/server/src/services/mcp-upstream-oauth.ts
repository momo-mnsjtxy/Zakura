import { createHash, randomBytes } from "node:crypto";
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import type { AppConfig } from "../config.js";

export type UpstreamOauthDiscovery = {
  mcpUrl: string;
  resourceMetadataUrl?: string;
  /** RFC 8707 resource identifier from PRM (prefer over mcpUrl when present) */
  resource?: string;
  authorizationServers: string[];
  authorizationServerMetadata?: Record<string, unknown>;
  scopesSupported?: string[];
  registrationEndpoint?: string;
  authorizationEndpoint?: string;
  tokenEndpoint?: string;
  codeChallengeMethodsSupported?: string[];
};

export type UpstreamOauthTokens = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  tokenType?: string;
  scope?: string;
  clientId?: string;
  clientSecret?: string;
  tokenEndpoint?: string;
};

export type McpUpstreamOauthOptions = {
  fetch?: typeof fetch;
  resolveHost?: (hostname: string) => Promise<Array<{ address: string; family?: number }>>;
  now?: () => number;
  nonce?: () => string;
  signal?: AbortSignal;
  requestTimeoutMs?: number;
  maxRedirects?: number;
  /** Defaults to true only for single-tenant/OSS deployments. */
  allowPrivateNetwork?: boolean;
};

function pkceVerifier(nonce: () => string): string {
  return nonce();
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function isPrivateOrLocalIp(ip: string): boolean {
  const version = isIP(ip);
  if (version === 4) {
    const parts = ip.split(".").map(Number);
    const [a, b] = parts;
    return (
      parts.length !== 4 ||
      parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255) ||
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b! >= 64 && b! <= 127)
    );
  }
  if (version === 6) {
    const lower = ip.toLowerCase();
    if (lower === "::" || lower === "::1") return true;
    if (lower.startsWith("fc") || lower.startsWith("fd") || lower.startsWith("fe80:")) {
      return true;
    }
    if (lower.startsWith("::ffff:")) return isPrivateOrLocalIp(lower.slice(7));
    return false;
  }
  return true;
}

function isBlockedHostname(hostname: string): boolean {
  const value = hostname.toLowerCase().replace(/\.$/, "");
  return (
    value === "localhost" ||
    value.endsWith(".localhost") ||
    value.endsWith(".local") ||
    value.endsWith(".internal") ||
    value === "metadata.google.internal" ||
    (isIP(value) > 0 && isPrivateOrLocalIp(value))
  );
}

function isRedirect(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function providerHttpError(operation: string, url: URL, status: number): Error {
  return new Error(`${operation} failed: HTTP ${status} from ${url.origin}${url.pathname}`);
}

/** MCP / OAuth 2.0：按规范尝试多种 PRM well-known 路径 */
function prmFallbackUrls(mcpUrl: string): string[] {
  const u = new URL(mcpUrl);
  const path = u.pathname.replace(/\/$/, "") || "";
  const urls = [
    path ? `${u.origin}/.well-known/oauth-protected-resource${path}` : null,
    `${u.origin}/.well-known/oauth-protected-resource`,
    path ? `${u.origin}${path}/.well-known/oauth-protected-resource` : null,
  ];
  return [...new Set(urls.filter(Boolean) as string[])];
}

/**
 * RFC 8414 / MCP：authorization_servers 可能是带路径的 issuer（如 github.com/login/oauth）。
 * 正确探测顺序含「路径插入」：origin/.well-known/.../path
 * （GitHub 需要这个，后缀拼接会 404）
 */
function asMetadataCandidates(asBase: string): string[] {
  if (asBase.includes("/.well-known/")) return [asBase];
  let u: URL;
  try {
    u = new URL(asBase);
  } catch {
    return [`${asBase.replace(/\/$/, "")}/.well-known/oauth-authorization-server`];
  }
  const origin = u.origin;
  const path = u.pathname.replace(/\/$/, "");
  const urls = [
    path ? `${origin}/.well-known/oauth-authorization-server${path}` : null,
    path ? `${origin}/.well-known/openid-configuration${path}` : null,
    `${asBase.replace(/\/$/, "")}/.well-known/oauth-authorization-server`,
    `${asBase.replace(/\/$/, "")}/.well-known/openid-configuration`,
    `${origin}/.well-known/oauth-authorization-server`,
    `${origin}/.well-known/openid-configuration`,
    path ? `${origin}${path}/.well-known/openid-configuration` : null,
  ];
  return [...new Set(urls.filter(Boolean) as string[])];
}

function resolveExpiresAt(expiresIn: unknown, now: () => number): number | undefined {
  const n = typeof expiresIn === "number" ? expiresIn : Number(expiresIn);
  if (!Number.isFinite(n) || n <= 0) return undefined;
  return Math.floor(now() / 1000) + n;
}

/**
 * MCP OAuth 2.1 client helpers (RFC 9728 PRM + RFC 8414 AS metadata + RFC 7591 DCR + PKCE).
 * Used when connecting TO upstream MCP servers that require OAuth.
 */
export class McpUpstreamOauthService {
  private readonly fetchImpl: typeof fetch;
  private readonly resolveHost: NonNullable<McpUpstreamOauthOptions["resolveHost"]>;
  private readonly now: () => number;
  private readonly nonce: () => string;
  private readonly signal?: AbortSignal;
  private readonly requestTimeoutMs: number;
  private readonly maxRedirects: number;
  private readonly allowPrivateNetwork: boolean;

  constructor(
    private readonly config: AppConfig,
    opts: McpUpstreamOauthOptions = {},
  ) {
    this.fetchImpl = opts.fetch ?? globalThis.fetch;
    this.resolveHost =
      opts.resolveHost ??
      (async (hostname) => lookup(hostname, { all: true, verbatim: true }));
    this.now = opts.now ?? Date.now;
    this.nonce = opts.nonce ?? (() => randomBytes(32).toString("base64url"));
    this.signal = opts.signal;
    this.requestTimeoutMs = Math.max(100, opts.requestTimeoutMs ?? 15_000);
    this.maxRedirects = Math.max(0, Math.min(opts.maxRedirects ?? 3, 10));
    this.allowPrivateNetwork = opts.allowPrivateNetwork ?? !config.multiTenant;
  }

  private requestSignal(): AbortSignal {
    if (this.signal?.aborted) {
      throw Object.assign(new Error("MCP OAuth request aborted"), { name: "AbortError" });
    }
    const timeout = AbortSignal.timeout(this.requestTimeoutMs);
    return this.signal ? AbortSignal.any([this.signal, timeout]) : timeout;
  }

  private async assertAllowedUrl(raw: string, label: string): Promise<URL> {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new Error(`${label} is not a valid URL`);
    }
    if (url.username || url.password) throw new Error(`${label} must not contain credentials`);
    if (url.protocol !== "https:" && !(this.allowPrivateNetwork && url.protocol === "http:")) {
      throw new Error(
        this.allowPrivateNetwork
          ? `${label} must use http or https`
          : `${label} must use public https`,
      );
    }
    if (this.allowPrivateNetwork) return url;
    const hostname = url.hostname.replace(/^\[|\]$/g, "");
    if (isBlockedHostname(hostname)) throw new Error(`${label} host is not allowed`);
    const records = await this.resolveHost(hostname);
    if (!records.length) throw new Error(`${label} host could not be resolved`);
    if (records.some((record) => isPrivateOrLocalIp(record.address))) {
      throw new Error(`${label} resolves to a private or local address`);
    }
    return url;
  }

  private async request(
    rawUrl: string,
    init: RequestInit,
    opts: { operation: string; allowRedirects?: boolean } ,
  ): Promise<{ response: Response; url: URL }> {
    let url = await this.assertAllowedUrl(rawUrl, opts.operation);
    let requestInit: RequestInit = { ...init };
    for (let redirect = 0; ; redirect += 1) {
      const response = await this.fetchImpl(url, {
        ...requestInit,
        redirect: "manual",
        signal: this.requestSignal(),
      });
      if (!isRedirect(response.status)) return { response, url };
      if (!opts.allowRedirects || redirect >= this.maxRedirects) {
        throw new Error(`${opts.operation} redirect was rejected`);
      }
      const location = response.headers.get("location");
      if (!location) throw new Error(`${opts.operation} redirect is missing Location`);
      url = await this.assertAllowedUrl(new URL(location, url).toString(), `${opts.operation} redirect`);
      if (response.status === 303 || ((response.status === 301 || response.status === 302) && requestInit.method === "POST")) {
        requestInit = { ...requestInit, method: "GET", body: undefined };
      }
    }
  }

  private async fetchJson(rawUrl: string): Promise<Record<string, unknown>> {
    const { response, url } = await this.request(
      rawUrl,
      { headers: { Accept: "application/json" } },
      { operation: "OAuth metadata", allowRedirects: true },
    );
    if (!response.ok) throw providerHttpError("OAuth metadata", url, response.status);
    const value = (await response.json().catch(() => null)) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`OAuth metadata from ${url.origin} was not a JSON object`);
    }
    return value as Record<string, unknown>;
  }

  private async fetchFirstJson(urls: string[]): Promise<{
    url: string;
    json: Record<string, unknown>;
  } | null> {
    for (const url of urls) {
      try {
        const json = await this.fetchJson(url);
        return { url, json };
      } catch (error) {
        if (this.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
          throw error;
        }
        // Try every spec-defined fallback without exposing provider bodies.
      }
    }
    return null;
  }

  /** Probe 401 WWW-Authenticate / well-known metadata for an upstream MCP URL */
  async discover(mcpUrl: string): Promise<UpstreamOauthDiscovery> {
    const mcpTarget = await this.assertAllowedUrl(mcpUrl, "MCP URL");
    mcpUrl = mcpTarget.toString();
    let resourceMetadataUrl: string | undefined;
    let wwwAuthenticate = "";

    try {
      const { response: probe } = await this.request(
        mcpUrl,
        {
          method: "POST",
          headers: {
            Accept: "application/json, text/event-stream",
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "initialize",
            params: {
              protocolVersion: "2025-11-25",
              capabilities: {},
              clientInfo: { name: "zakura", version: "0.4.0" },
            },
          }),
        },
        { operation: "MCP discovery", allowRedirects: true },
      );
      wwwAuthenticate = probe.headers.get("www-authenticate") ?? "";
      const match = /resource_metadata="([^"]+)"/i.exec(wwwAuthenticate);
      if (match?.[1]) resourceMetadataUrl = new URL(match[1], mcpTarget).toString();
    } catch (error) {
      if (this.signal?.aborted || (error instanceof Error && error.name === "AbortError")) {
        throw error;
      }
      // continue with well-known fallbacks
    }

    let authorizationServers: string[] = [];
    let scopesSupported: string[] | undefined;
    let resource: string | undefined;

    const prmCandidates = resourceMetadataUrl
      ? [resourceMetadataUrl, ...prmFallbackUrls(mcpUrl).filter((u) => u !== resourceMetadataUrl)]
      : prmFallbackUrls(mcpUrl);

    const prmHit = await this.fetchFirstJson(prmCandidates);
    if (prmHit) {
      resourceMetadataUrl = prmHit.url;
      const prm = prmHit.json;
      if (typeof prm.resource === "string" && prm.resource) {
        resource = prm.resource;
      }
      const servers = prm.authorization_servers;
      if (Array.isArray(servers)) {
        authorizationServers = servers
          .filter((server): server is string => typeof server === "string" && !!server.trim())
          .slice(0, 10);
      }
      if (Array.isArray(prm.scopes_supported)) {
        scopesSupported = prm.scopes_supported.filter(
          (scope): scope is string => typeof scope === "string" && !!scope.trim(),
        );
      }
    }

    if (!authorizationServers.length) {
      // 不要静默 fallback 到 mcp.origin（GitHub 会错成 api.githubcopilot.com）
      throw new Error(
        `无法发现 authorization_servers（PRM 失败）。已尝试：${prmCandidates.join(", ")}`,
      );
    }

    const asBase = authorizationServers[0]!;
    await this.assertAllowedUrl(asBase, "authorization server");
    const asHit = await this.fetchFirstJson(asMetadataCandidates(asBase));
    const authorizationServerMetadata = asHit?.json;

    if (!authorizationServerMetadata) {
      throw new Error(
        `无法获取授权服务器元数据。AS=${asBase}；已尝试：${asMetadataCandidates(asBase).join(", ")}`,
      );
    }

    const endpoint = async (key: string): Promise<string | undefined> => {
      const value = authorizationServerMetadata[key];
      if (typeof value !== "string" || !value.trim()) return undefined;
      return (await this.assertAllowedUrl(value, key)).toString();
    };
    const registrationEndpoint = await endpoint("registration_endpoint");
    const authorizationEndpoint = await endpoint("authorization_endpoint");
    const tokenEndpoint = await endpoint("token_endpoint");
    if (!authorizationEndpoint || !tokenEndpoint) {
      throw new Error("授权服务器元数据缺少安全的 authorization_endpoint / token_endpoint");
    }

    return {
      mcpUrl,
      resourceMetadataUrl,
      resource,
      authorizationServers,
      authorizationServerMetadata,
      scopesSupported,
      registrationEndpoint,
      authorizationEndpoint,
      tokenEndpoint,
      codeChallengeMethodsSupported: Array.isArray(
        authorizationServerMetadata.code_challenge_methods_supported,
      )
        ? authorizationServerMetadata.code_challenge_methods_supported.filter(
            (method): method is string => typeof method === "string" && !!method.trim(),
          )
        : undefined,
    };
  }

  /** Prefer PRM scopes; never invent a fake "mcp" scope */
  resolveScope(discovery: UpstreamOauthDiscovery, override?: string): string | undefined {
    if (override?.trim()) return override.trim();
    if (discovery.scopesSupported?.length) return discovery.scopesSupported.join(" ");
    return undefined;
  }

  /** RFC 7591 dynamic client registration against upstream AS */
  async registerClient(discovery: UpstreamOauthDiscovery, opts?: {
    clientName?: string;
    redirectUris?: string[];
  }): Promise<{ clientId: string; clientSecret?: string; raw: Record<string, unknown> }> {
    if (!discovery.registrationEndpoint) {
      throw new Error("上游授权服务器不支持动态客户端注册（缺少 registration_endpoint）");
    }
    const redirectUris = opts?.redirectUris ?? [
      `${this.config.publicBaseUrl}/api/mcp/upstream-oauth/callback`,
    ];
    const { response: res, url } = await this.request(
      discovery.registrationEndpoint,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_name: opts?.clientName ?? "Zakura MCP Gateway",
          redirect_uris: redirectUris,
          grant_types: ["authorization_code", "refresh_token"],
          response_types: ["code"],
          token_endpoint_auth_method: "none",
          client_uri: this.config.webPublicUrl,
        }),
      },
      { operation: "OAuth client registration" },
    );
    const value = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) throw providerHttpError("OAuth client registration", url, res.status);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("DCR response was not a JSON object");
    }
    const raw = value as Record<string, unknown>;
    const clientId = typeof raw.client_id === "string" ? raw.client_id.trim() : "";
    if (!clientId) throw new Error("DCR response missing client_id");
    return {
      clientId,
      clientSecret: typeof raw.client_secret === "string" ? raw.client_secret : undefined,
      raw,
    };
  }

  buildAuthorizeUrl(input: {
    discovery: UpstreamOauthDiscovery;
    clientId: string;
    redirectUri: string;
    state: string;
    scope?: string;
    resource?: string;
    /** 额外查询参数（如 Google access_type=offline） */
    extraParams?: Record<string, string>;
  }): { url: string; codeVerifier: string } {
    if (!input.discovery.authorizationEndpoint) {
      throw new Error("缺少 authorization_endpoint");
    }
    const endpoint = new URL(input.discovery.authorizationEndpoint);
    const hostname = endpoint.hostname.replace(/^\[|\]$/g, "");
    if (
      endpoint.username ||
      endpoint.password ||
      (this.allowPrivateNetwork
        ? endpoint.protocol !== "http:" && endpoint.protocol !== "https:"
        : endpoint.protocol !== "https:" || isBlockedHostname(hostname))
    ) {
      throw new Error("authorization_endpoint is not allowed");
    }
    const codeVerifier = pkceVerifier(this.nonce);
    const challenge = pkceChallenge(codeVerifier);
    const u = endpoint;
    u.searchParams.set("response_type", "code");
    u.searchParams.set("client_id", input.clientId);
    u.searchParams.set("redirect_uri", input.redirectUri);
    u.searchParams.set("state", input.state);
    u.searchParams.set("code_challenge", challenge);
    u.searchParams.set("code_challenge_method", "S256");
    if (input.scope) u.searchParams.set("scope", input.scope);
    if (input.resource) u.searchParams.set("resource", input.resource);
    if (input.extraParams) {
      for (const [k, v] of Object.entries(input.extraParams)) {
        if (v) u.searchParams.set(k, v);
      }
    }
    return { url: u.toString(), codeVerifier };
  }

  async exchangeCode(input: {
    tokenEndpoint: string;
    code: string;
    redirectUri: string;
    clientId: string;
    clientSecret?: string;
    codeVerifier: string;
    resource?: string;
  }): Promise<UpstreamOauthTokens> {
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.codeVerifier,
    });
    if (input.clientSecret) body.set("client_secret", input.clientSecret);
    if (input.resource) body.set("resource", input.resource);

    const { response: res, url } = await this.request(
      input.tokenEndpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
      },
      { operation: "OAuth token exchange" },
    );
    const value = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) throw providerHttpError("OAuth token exchange", url, res.status);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("token response was not a JSON object");
    }
    const raw = value as Record<string, unknown>;
    const accessToken = typeof raw.access_token === "string" ? raw.access_token.trim() : "";
    if (!accessToken) throw new Error("token response missing access_token");
    return {
      accessToken,
      refreshToken: typeof raw.refresh_token === "string" ? raw.refresh_token : undefined,
      expiresAt: resolveExpiresAt(raw.expires_in, this.now),
      tokenType: typeof raw.token_type === "string" ? raw.token_type : "Bearer",
      scope: typeof raw.scope === "string" ? raw.scope : undefined,
      clientId: input.clientId,
      clientSecret: input.clientSecret,
      tokenEndpoint: input.tokenEndpoint,
    };
  }

  async refresh(tokens: UpstreamOauthTokens): Promise<UpstreamOauthTokens> {
    if (!tokens.refreshToken || !tokens.tokenEndpoint || !tokens.clientId) {
      throw new Error("无法刷新：缺少 refresh_token / tokenEndpoint / clientId");
    }
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refreshToken,
      client_id: tokens.clientId,
    });
    if (tokens.clientSecret) body.set("client_secret", tokens.clientSecret);

    const { response: res, url } = await this.request(
      tokens.tokenEndpoint,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Accept: "application/json",
        },
        body,
      },
      { operation: "OAuth token refresh" },
    );
    const value = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) throw providerHttpError("OAuth token refresh", url, res.status);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("refresh response was not a JSON object");
    }
    const raw = value as Record<string, unknown>;
    const accessToken = typeof raw.access_token === "string" ? raw.access_token.trim() : "";
    if (!accessToken) throw new Error("refresh response missing access_token");
    return {
      ...tokens,
      accessToken,
      refreshToken:
        typeof raw.refresh_token === "string" ? raw.refresh_token : tokens.refreshToken,
      expiresAt: resolveExpiresAt(raw.expires_in, this.now) ?? tokens.expiresAt,
      tokenType: typeof raw.token_type === "string" ? raw.token_type : tokens.tokenType,
      scope: typeof raw.scope === "string" ? raw.scope : tokens.scope,
    };
  }
}
