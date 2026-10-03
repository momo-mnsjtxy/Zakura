import { Hono } from "hono";
import { createHash, randomBytes } from "node:crypto";
import { BridgeStateStore } from "./state.js";

/**
 * OAuth Bridge — 独立中间件骨架。
 *
 * 对客户端：OAuth 2.1 AS + DCR 门面
 * 对上游：使用预注册 Google（等）client 换 token
 *
 * 生产使用前需：HTTPS、持久化 pending state、完成 Google 验证、租户隔离。
 */

const port = Number(process.env.PORT ?? 8788);
const publicBaseUrl = (process.env.BRIDGE_PUBLIC_URL ?? `http://127.0.0.1:${port}`).replace(
  /\/$/,
  "",
);

type BridgeConfig = {
  googleClientId: string;
  googleClientSecret: string;
  googleScopes: string;
};

function loadConfig(): BridgeConfig {
  return {
    googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET ?? "",
    googleScopes:
      process.env.GOOGLE_SCOPES ??
      "openid email https://www.googleapis.com/auth/drive.readonly",
  };
}

const stateStore = new BridgeStateStore();

function allowedRedirect(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.username || url.password || url.hash) return false;
    if (url.protocol === "https:") return true;
    if (url.protocol !== "http:") return false;
    return url.hostname === "127.0.0.1" || url.hostname === "[::1]" || url.hostname === "localhost";
  } catch {
    return false;
  }
}

function pkceVerifier(): string {
  return randomBytes(32).toString("base64url");
}

function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export const app = new Hono();

app.get("/health", (c) =>
  c.json({
    status: "ok",
    service: "oauth-bridge",
    googleConfigured: !!loadConfig().googleClientId,
  }),
);
app.get("/livez", (c) => c.json({ status: "ok", service: "oauth-bridge" }));

/** RFC 8414 Authorization Server Metadata */
app.get("/.well-known/oauth-authorization-server", (c) =>
  c.json({
    issuer: publicBaseUrl,
    authorization_endpoint: `${publicBaseUrl}/authorize`,
    token_endpoint: `${publicBaseUrl}/token`,
    registration_endpoint: `${publicBaseUrl}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
  }),
);

/** RFC 7591 DCR 门面：无真实动态注册，返回公共 bridge client */
app.post("/register", async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as {
    client_name?: string;
    redirect_uris?: string[];
  };
  const redirectUris = body.redirect_uris ?? [];
  if (!redirectUris.length || redirectUris.some((uri) => !allowedRedirect(uri))) {
    return c.json({ error: "invalid_redirect_uri" }, 400);
  }
  return c.json({
    client_id: "zakura-oauth-bridge",
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: body.client_name ?? "Zakura OAuth Bridge Client",
    redirect_uris: redirectUris,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
});

/**
 * 授权入口：把客户端 redirect 编码进 state，再跳转 Google。
 * 查询参数对齐标准 OAuth：client_id, redirect_uri, state, code_challenge, …
 */
app.get("/authorize", (c) => {
  stateStore.purge();
  const cfg = loadConfig();
  if (!cfg.googleClientId) {
    return c.text(
      "GOOGLE_CLIENT_ID 未配置。请使用 BYO 自托管模式配置 Google OAuth App。",
      503,
    );
  }

  const redirectUri = c.req.query("redirect_uri");
  const clientState = c.req.query("state") ?? undefined;
  const downstreamCodeChallenge = c.req.query("code_challenge") ?? undefined;
  const downstreamChallengeMethod = c.req.query("code_challenge_method") ?? undefined;
  if (!redirectUri) return c.text("redirect_uri required", 400);
  if (!allowedRedirect(redirectUri)) return c.text("invalid redirect_uri", 400);
  if (!downstreamCodeChallenge || downstreamChallengeMethod !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(downstreamCodeChallenge)) {
    return c.text("PKCE S256 required", 400);
  }

  const bridgeState = randomBytes(16).toString("hex");
  const codeVerifier = pkceVerifier();
  stateStore.putPending(bridgeState, {
    clientRedirectUri: redirectUri,
    clientState,
    codeVerifier,
    downstreamCodeChallenge,
    createdAt: Date.now(),
  });

  const googleAuth = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  googleAuth.searchParams.set("client_id", cfg.googleClientId);
  googleAuth.searchParams.set("redirect_uri", `${publicBaseUrl}/callback`);
  googleAuth.searchParams.set("response_type", "code");
  googleAuth.searchParams.set("scope", cfg.googleScopes);
  googleAuth.searchParams.set("access_type", "offline");
  googleAuth.searchParams.set("prompt", "consent");
  googleAuth.searchParams.set("state", bridgeState);
  googleAuth.searchParams.set("code_challenge", pkceChallenge(codeVerifier));
  googleAuth.searchParams.set("code_challenge_method", "S256");

  return c.redirect(googleAuth.toString());
});

/** Google 回调 → 换 token → 向客户端发放一次性 code */
app.get("/callback", async (c) => {
  stateStore.purge();
  const cfg = loadConfig();
  const code = c.req.query("code");
  const state = c.req.query("state");
  const err = c.req.query("error");

  if (err || !code || !state) {
    return c.text(`OAuth error: ${err || "missing code/state"}`, 400);
  }
  const pending = stateStore.takePending(state);
  if (!pending) return c.text("invalid or expired state", 400);

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: `${publicBaseUrl}/callback`,
    client_id: cfg.googleClientId,
    client_secret: cfg.googleClientSecret,
    code_verifier: pending.codeVerifier,
  });

  const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  const tokenJson = (await tokenRes.json().catch(() => ({}))) as Record<string, unknown>;
  if (!tokenRes.ok || !tokenJson.access_token) {
    return c.text(`token exchange failed: ${JSON.stringify(tokenJson).slice(0, 300)}`, 400);
  }

  const oneTimeCode = randomBytes(24).toString("base64url");
  const expiresIn =
    typeof tokenJson.expires_in === "number" ? tokenJson.expires_in : Number(tokenJson.expires_in);
  stateStore.putGrant(oneTimeCode, {
    accessToken: String(tokenJson.access_token),
    refreshToken:
      typeof tokenJson.refresh_token === "string" ? tokenJson.refresh_token : undefined,
    expiresAt:
      Number.isFinite(expiresIn) && expiresIn > 0
        ? Math.floor(Date.now() / 1000) + expiresIn
        : undefined,
    createdAt: Date.now(),
    downstreamCodeChallenge: pending.downstreamCodeChallenge,
  });

  const back = new URL(pending.clientRedirectUri);
  back.searchParams.set("code", oneTimeCode);
  if (pending.clientState) back.searchParams.set("state", pending.clientState);
  return c.redirect(back.toString());
});

/** 客户端用 bridge code 换取上游 token（骨架：直接透传 Google token） */
app.post("/token", async (c) => {
  stateStore.purge();
  const contentType = c.req.header("content-type") ?? "";
  let grantType = "";
  let code = "";
  let codeVerifier = "";
  if (contentType.includes("application/x-www-form-urlencoded")) {
    const form = await c.req.parseBody();
    grantType = String(form.grant_type ?? "");
    code = String(form.code ?? "");
    codeVerifier = String(form.code_verifier ?? "");
  } else {
    const json = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    grantType = String(json.grant_type ?? "");
    code = String(json.code ?? "");
    codeVerifier = String(json.code_verifier ?? "");
  }

  if (grantType !== "authorization_code" || !code) {
    return c.json({ error: "unsupported_grant_type" }, 400);
  }
  const stored = stateStore.getGrant(code);
  if (!stored) return c.json({ error: "invalid_grant" }, 400);
  if (!codeVerifier || pkceChallenge(codeVerifier) !== stored.downstreamCodeChallenge) {
    return c.json({ error: "invalid_grant", error_description: "PKCE verification failed" }, 400);
  }
  // Codes are consumed only after all validation succeeds. A typo in a verifier
  // cannot be used to invalidate somebody else's authorization code.
  stateStore.consumeGrant(code);

  return c.json({
    access_token: stored.accessToken,
    token_type: "Bearer",
    expires_in: stored.expiresAt
      ? Math.max(0, stored.expiresAt - Math.floor(Date.now() / 1000))
      : 3600,
    refresh_token: stored.refreshToken,
  });
});


export function bridgeRuntimeInfo() {
  return { port, googleConfigured: !!loadConfig().googleClientId };
}
