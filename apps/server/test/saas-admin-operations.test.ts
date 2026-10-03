import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { after, before, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import {
  newId,
  oauthAuthCodes,
  oauthClients,
  oauthRefreshTokens,
  tenantMemberships,
  tenants,
  upstreamOauthClients,
  users,
} from "../src/db/schema.js";
import { signSession } from "../src/services/auth.js";
import { verifySession, isSessionAdmin } from "../src/services/auth.js";
import { OauthService } from "../src/services/oauth.js";
import { UpstreamOauthClientStore } from "../src/services/upstream-oauth-clients.js";
import { TenantService } from "../src/services/tenants.js";
import { registerSaasRoutes } from "../../../packages/saas/src/server/routes.js";
import type { SaasSession } from "../../../packages/saas/src/server/types.js";
import * as schema from "../src/db/schema.js";
import { SecurityAuditService } from "../src/services/identity/audit.js";

describe("SaaS platform-admin OAuth client operations", () => {
  let dir: string;
  let db: Db;
  let close: () => Promise<void>;
  let app: { request: (url: string, init?: RequestInit) => Promise<Response> };
  let config: AppConfig;
  let tenantA: string;
  let tenantB: string;
  let adminId: string;
  let memberId: string;

  before(async () => {
    process.env.REDIS_URL = "off";
    process.env.ZAKURA_EDITION = "saas";
    dir = mkdtempSync(join(tmpdir(), "zakura-saas-admin-"));
    const databaseUrl = `pglite:${join(dir, "db")}`;
    await (await import("../src/db/migrate.js")).runMigrations(databaseUrl);
    const created = await (await import("../src/db/client.js")).createDb({ databaseUrl, dataDir: dir });
    db = created.db;
    close = created.close;
    config = {
      dataDir: dir,
      databaseUrl,
      secret: "saas-admin-secret",
      publicBaseUrl: "http://localhost",
      internalBaseUrl: "http://localhost",
      webPublicUrl: "http://localhost:3001",
      multiTenant: true,
      edition: "saas",
    } as AppConfig;
    tenantA = newId();
    tenantB = newId();
    adminId = newId();
    memberId = newId();
    await db.insert(tenants).values([
      { id: tenantA, slug: "saas-admin-a", name: "Admin A" },
      { id: tenantB, slug: "saas-admin-b", name: "Admin B" },
    ]);
    await db.insert(users).values([
      { id: adminId, email: "platform-admin@example.test", isPlatformAdmin: true },
      { id: memberId, email: "ordinary-member@example.test", isPlatformAdmin: false },
    ]);
    await db.insert(tenantMemberships).values([
      { id: newId(), tenantId: tenantA, userId: adminId, role: "owner", status: "active" },
      { id: newId(), tenantId: tenantA, userId: memberId, role: "member", status: "active" },
    ]);

    const hono = new Hono<{ Variables: { session?: SaasSession } }>();
    hono.use("*", async (c, next) => {
      const raw = c.req.header("authorization")?.replace(/^Bearer\s+/i, "") ?? "";
      const session = verifySession(config.secret, raw);
      if (session) c.set("session", session);
      await next();
    });
    const oauth = new OauthService(db, config);
    const upstream = new UpstreamOauthClientStore(db, config);
    const audit = new SecurityAuditService(db);
    registerSaasRoutes(hono, {
      db,
      config: { secret: config.secret, webPublicUrl: config.webPublicUrl, multiTenant: true, edition: "saas" },
      encryptJson: (_secret, value) => JSON.stringify(value),
      decryptJson: <T,>(_secret: string, value: string) => JSON.parse(value) as T,
      tenants: new TenantService(db),
      signSession,
      sessionFromLogin: () => "session",
      switchTenantSession: async () => null,
      isSessionAdmin,
      ensurePlatformMeta: async () => ({ setupCompleted: true, mode: "multi-tenant", version: "test" }),
      appendAudit: (tenantId, action, opts) => audit.append(tenantId, action, {
        actor: { type: "admin", id: opts?.actorId },
        targetType: opts?.targetType,
        targetId: opts?.targetId,
        detail: opts?.detail,
      }),
      schema,
      oauthClientsAdmin: {
        list: async (tenantId) => ({
          inbound: await oauth.listClients(tenantId),
          outbound: await upstream.list(tenantId),
        }),
        revoke: async ({ tenantId, direction, id }) => {
          if (direction === "outbound") {
            const rows = await db.delete(upstreamOauthClients).where(and(eq(upstreamOauthClients.id, id), eq(upstreamOauthClients.tenantId, tenantId))).returning();
            return rows.length > 0;
          }
          const client = await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, id) });
          if (!client) return false;
          if (client.tenantId === tenantId) {
            const rows = await db.delete(oauthClients).where(and(eq(oauthClients.id, id), eq(oauthClients.tenantId, tenantId))).returning();
            return rows.length > 0;
          }
          if (client.tenantId) return false;
          return db.transaction(async (tx) => {
            const refresh = await tx.delete(oauthRefreshTokens).where(and(eq(oauthRefreshTokens.tenantId, tenantId), eq(oauthRefreshTokens.clientId, client.clientId))).returning();
            const codes = await tx.delete(oauthAuthCodes).where(and(eq(oauthAuthCodes.tenantId, tenantId), eq(oauthAuthCodes.clientId, client.clientId))).returning();
            return refresh.length > 0 || codes.length > 0;
          });
        },
      },
    });
    app = hono;

    await db.insert(oauthClients).values([
      {
        id: "owned-row",
        clientId: "owned-client",
        clientName: "Owned client",
        tenantId: tenantA,
      },
      {
        id: "shared-row",
        clientId: "https://client.example/cimd.json",
        clientName: "Shared CIMD",
        registrationType: "cimd",
        tenantId: null,
      },
    ]);
    const future = new Date(Date.now() + 86_400_000);
    await db.insert(oauthRefreshTokens).values([
      { id: newId(), tokenHash: "refresh-a", clientId: "https://client.example/cimd.json", userId: adminId, tenantId: tenantA, expiresAt: future },
      { id: newId(), tokenHash: "refresh-b", clientId: "https://client.example/cimd.json", userId: adminId, tenantId: tenantB, expiresAt: future },
    ]);
    await db.insert(oauthAuthCodes).values([
      {
        id: newId(), codeHash: "code-a", clientId: "https://client.example/cimd.json",
        userId: adminId, tenantId: tenantA, redirectUri: "https://client.example/callback",
        codeChallenge: "challenge-a", expiresAt: future,
      },
      {
        id: newId(), codeHash: "code-b", clientId: "https://client.example/cimd.json",
        userId: adminId, tenantId: tenantB, redirectUri: "https://client.example/callback",
        codeChallenge: "challenge-b", expiresAt: future,
      },
    ]);
    await db.insert(upstreamOauthClients).values([
      { id: "out-a", tenantId: tenantA, mcpUrl: "https://a.example/mcp", host: "a.example", clientId: "out-a-client", clientName: "Outbound A", source: "byo" },
      { id: "out-b", tenantId: tenantB, mcpUrl: "https://b.example/mcp", host: "b.example", clientId: "out-b-client", clientName: "Outbound B", source: "byo" },
    ]);
  });

  after(async () => {
    await close();
    rmSync(dir, { recursive: true, force: true });
    delete process.env.ZAKURA_EDITION;
  });

  function token(userId: string, email: string, isPlatformAdmin: boolean) {
    return signSession(config.secret, {
      userId,
      tenantId: tenantA,
      email,
      role: isPlatformAdmin ? "owner" : "member",
      isPlatformAdmin,
      iat: Math.floor(Date.now() / 1000),
    });
  }

  const request = (path: string, bearer: string, init?: RequestInit) =>
    app.request(`http://localhost${path}`, {
      ...init,
      headers: { ...(init?.headers ?? {}), authorization: `Bearer ${bearer}` },
    });

  it("authorizes, paginates and tenant-qualifies inbound/outbound revocation", async () => {
    const memberToken = token(memberId, "ordinary-member@example.test", false);
    const denied = await request("/api/admin/oauth-clients", memberToken);
    assert.equal(denied.status, 403, await denied.clone().text());

    const adminToken = token(adminId, "platform-admin@example.test", true);
    const list = await request(
      `/api/admin/oauth-clients?tenantId=${tenantA}&page=2&pageSize=1`,
      adminToken,
    );
    assert.equal(list.status, 200, await list.clone().text());
    const listed = await list.json() as { total: number; items: Array<{ id: string }> };
    assert.equal(listed.total, 3);
    assert.equal(listed.items.length, 1);

    const shared = await request(
      `/api/admin/oauth-clients/inbound/shared-row?tenantId=${tenantA}`,
      adminToken,
      { method: "DELETE" },
    );
    assert.equal(shared.status, 200, await shared.clone().text());
    assert.ok(await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, "shared-row") }));
    assert.equal(
      await db.query.oauthRefreshTokens.findFirst({
        where: and(eq(oauthRefreshTokens.tenantId, tenantA), eq(oauthRefreshTokens.clientId, "https://client.example/cimd.json")),
      }),
      undefined,
    );
    assert.ok(await db.query.oauthRefreshTokens.findFirst({ where: eq(oauthRefreshTokens.tenantId, tenantB) }));
    assert.equal(await db.query.oauthAuthCodes.findFirst({ where: eq(oauthAuthCodes.tenantId, tenantA) }), undefined);
    assert.ok(await db.query.oauthAuthCodes.findFirst({ where: eq(oauthAuthCodes.tenantId, tenantB) }));

    assert.equal((await request(
      `/api/admin/oauth-clients/inbound/owned-row?tenantId=${tenantA}`,
      adminToken,
      { method: "DELETE" },
    )).status, 200);
    assert.equal(await db.query.oauthClients.findFirst({ where: eq(oauthClients.id, "owned-row") }), undefined);

    assert.equal((await request(
      `/api/admin/oauth-clients/outbound/out-a?tenantId=${tenantA}`,
      adminToken,
      { method: "DELETE" },
    )).status, 200);
    assert.equal(await db.query.upstreamOauthClients.findFirst({ where: eq(upstreamOauthClients.id, "out-a") }), undefined);
    assert.ok(await db.query.upstreamOauthClients.findFirst({ where: eq(upstreamOauthClients.id, "out-b") }));
    assert.ok(await db.query.securityAuditLogs.findFirst({
      where: and(
        eq(schema.securityAuditLogs.tenantId, tenantA),
        eq(schema.securityAuditLogs.action, "admin.oauth_client_revoke"),
      ),
    }));
  });
});
