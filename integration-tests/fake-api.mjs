import { createServer } from "node:http";

let enrollmentStartAttempts = 0;
let tenantEnrollmentStartAttempts = 0;
let apiKeyCreateAttempts = 0;

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://fixture").pathname.replace(/\/$/, "") || "/";
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};

  response.setHeader("content-type", "application/json; charset=utf-8");
  if (pathname === "/api/platform") {
    response.end(JSON.stringify({
      edition: "oss",
      passwordLoginEnabled: true,
      registrationEnabled: true,
      oauthProviders: [],
    }));
    return;
  }
  if (pathname === "/api/auth/sso/discover" && request.method === "POST") {
    response.end(JSON.stringify({ sso: false, echoedEmail: body.email }));
    return;
  }
  if (pathname === "/api/auth/login" && request.method === "POST") {
    if (body.email === "enroll@example.test") {
      response.end(JSON.stringify({
        mfaEnrollmentRequired: true,
        mfaEnrollmentTicket: "fixture-enrollment-ticket",
        methods: ["totp"],
        code: "mfa_enrollment_required",
      }));
      return;
    }
    response.end(JSON.stringify({ session: "fixture-session" }));
    return;
  }
  if (pathname === "/api/auth/mfa/enrollment/totp/start" && request.method === "POST") {
    if (body.ticket === "fixture-tenant-enrollment-ticket") {
      tenantEnrollmentStartAttempts += 1;
      if (tenantEnrollmentStartAttempts === 1) {
        response.statusCode = 503;
        response.end(JSON.stringify({ error: "Tenant enrollment temporarily unavailable" }));
        return;
      }
      response.end(JSON.stringify({ secret: "TENANTSECRET123", qrCodeDataUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Crect width='160' height='160' fill='white'/%3E%3C/svg%3E" }));
      return;
    }
    if (body.ticket !== "fixture-enrollment-ticket") {
      response.statusCode = 410;
      response.end(JSON.stringify({ error: "Enrollment ticket expired", code: "ticket_expired" }));
      return;
    }
    enrollmentStartAttempts += 1;
    if (enrollmentStartAttempts === 1) {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: "Authenticator setup temporarily unavailable" }));
      return;
    }
    response.end(JSON.stringify({
      secret: "JBSWY3DPEHPK3PXP",
      qrCodeDataUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Crect width='160' height='160' fill='white'/%3E%3Cpath d='M10 10h60v60H10zM90 10h60v60H90zM10 90h60v60H10z' fill='black'/%3E%3C/svg%3E",
    }));
    return;
  }
  if (pathname === "/api/auth/mfa/enrollment/totp/complete" && request.method === "POST") {
    if (body.ticket === "fixture-tenant-enrollment-ticket" && body.code === "654321") {
      response.end(JSON.stringify({ session: "fixture-switched-session", recoveryCodes: [], tenant: { onboardingCompleted: true } }));
      return;
    }
    if (body.ticket !== "fixture-enrollment-ticket" || body.code !== "123456") {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: "Invalid enrollment code", code: "invalid_code" }));
      return;
    }
    response.end(JSON.stringify({
      session: "fixture-enrollment-session",
      recoveryCodes: ["RECOVERY-ONE", "RECOVERY-TWO"],
      tenant: { onboardingCompleted: true },
    }));
    return;
  }
  if (pathname === "/api/auth/oauth/fixture-mfa/callback" && request.method === "POST") {
    response.end(JSON.stringify({ mfaRequired: true, mfaTicket: "fixture-oauth-mfa-ticket", methods: ["totp"], next: "/dashboard/agents" }));
    return;
  }
  if (pathname === "/api/auth/mfa/complete" && request.method === "POST") {
    if (body.ticket === "fixture-oauth-mfa-ticket" && body.totp === "123456") {
      response.end(JSON.stringify({ session: "fixture-oauth-session" }));
      return;
    }
    response.statusCode = 410;
    response.end(JSON.stringify({ error: "MFA ticket expired", code: "ticket_expired" }));
    return;
  }
  if (pathname === "/api/tenants") {
    response.end(JSON.stringify({ currentTenantId: "fixture-tenant", tenants: [{ tenant: { id: "fixture-tenant", name: "Fixture Team" }, role: "owner" }, { tenant: { id: "tenant-two", name: "Second Team" }, role: "member" }] }));
    return;
  }
  if (pathname === "/api/auth/switch-tenant" && request.method === "POST") {
    response.end(JSON.stringify({ mfaEnrollmentRequired: true, mfaEnrollmentTicket: "fixture-tenant-enrollment-ticket", methods: ["totp"], tenant: { onboardingCompleted: true } }));
    return;
  }
  if (pathname === "/api/tenant/current") {
    response.end(JSON.stringify({ onboardingCompleted: true }));
    return;
  }
  if (pathname === "/api/me") {
    response.end(JSON.stringify({
      user: { id: "fixture-user", name: "Fixture Member", email: "member@example.test" },
      tenant: { id: "fixture-tenant", name: "Fixture Team", onboardingCompleted: true },
      role: "owner",
      isPlatformAdmin: true,
      edition: "oss",
      multiTenant: true,
      canUseLocalRunner: true,
    }));
    return;
  }
  if (pathname === "/api/agents" || pathname === "/api/spaces") {
    response.end("[]");
    return;
  }
  if (pathname === "/api/settings/network/overview") {
    response.end(JSON.stringify({ mesh: { connected: true, displayName: "Fixture Mesh", status: "ready" }, defaultProvider: "cloudflare-quick", exposureEnabled: true, runners: { online: 1, total: 1 }, activeExposures: 0, exposuresToday: 3, auditEventsToday: 4, hostJoinsTailscale: false }));
    return;
  }
  if (pathname === "/api/settings/network/exposure/providers") {
    response.end(JSON.stringify({ providers: [{ id: "provider-1", tenantId: "fixture-tenant", provider: "cloudflare-quick", enabled: true, isDefault: true, config: {}, hasConfig: true, lastTestAt: null, lastTestOk: true, lastError: null, meta: { name: "Cloudflare Quick Tunnel", description: "Fixture public tunnel", requiresConfig: false, publicExposure: true }, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }] }));
    return;
  }
  if (pathname === "/api/runtime-nodes") {
    response.end(JSON.stringify({ nodes: [{ id: "runner-1", name: "Fixture Runner", slug: "fixture-runner", kind: "remote", access: "private", status: "online", endpoint: "https://runner.example.test", labels: {}, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }], canUseLocalRunner: true }));
    return;
  }
  if (pathname === "/api/platform-services") {
    response.end(JSON.stringify({ canManage: true, services: [{ key: "headscale", name: "Headscale", description: "Fixture managed mesh", mapsTo: { kind: "service", id: "headscale" }, mode: "managed", status: "running", healthStatus: "healthy", endpointUrl: "https://mesh.example.test", lastError: null, containers: [], config: { hasApiKey: true, hostPort: 8080, image: "headscale:fixture" }, lifecycle: { state: "running", label: "运行中", detail: "Healthy", tone: "success", busy: false, actions: ["restart", "stop"] }, progress: { running: false, done: true, phase: "ready", message: "Ready", events: [] } }] }));
    return;
  }
  if (pathname === "/api/mcp/policies/bootstrap") {
    response.end(JSON.stringify({ policies: [{ id: "policy-1", apiKeyId: null, apiKey: null, instanceIds: [], toolAllowlist: ["search"], toolDenylist: null, includeBuiltin: true }], apiKeys: [], instances: [] }));
    return;
  }
  if (pathname === "/api/api-keys" && request.method === "GET") {
    response.end(JSON.stringify([{ id: "key-1", name: "fixture", keyPrefix: "zk_fixture", lastUsedAt: null, createdAt: "2026-01-01T00:00:00Z" }]));
    return;
  }
  if (pathname === "/api/api-keys" && request.method === "POST") {
    apiKeyCreateAttempts += 1;
    if (apiKeyCreateAttempts === 1) {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: "Key service temporarily unavailable" }));
      return;
    }
    response.end(JSON.stringify({ rawKey: "zk_fixture_once_only" }));
    return;
  }
  if (pathname === "/api/oauth/clients") {
    response.end(JSON.stringify({ inbound: [{ id: "oauth-1", clientId: "fixture-client", clientName: "Fixture CLI", registrationType: "dynamic", tenantBound: true, createdAt: "2026-01-01T00:00:00Z" }], dcr: [], byo: [] }));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "fixture route not found" }));
});

server.listen(8787, "127.0.0.1", () => {
  process.stdout.write("fake-api-ready\n");
});
