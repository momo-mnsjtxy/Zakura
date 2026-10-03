import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import { newId, securityAuditLogs, settings, tenantMemberships, users } from "../src/db/schema.js";
import * as schema from "../src/db/schema.js";
import { registerIdentityRoutes } from "../src/api/identity-routes.js";
import { registerUsageRoutes } from "../src/api/usage-routes.js";
import { SecurityAuditService } from "../src/services/identity/audit.js";
import { addTenantDomain, maybeAutoJoinTenant, setDomainJoinMode, verifyTenantDomain } from "../src/services/identity/domains.js";
import { TenantAccessError, TenantService } from "../src/services/tenants.js";
import { UserUsageStore } from "../src/services/user-usage.js";
import type { SessionPayload } from "../src/services/auth.js";
import { confirmEmailVerification } from "../src/services/identity/account.js";
import { issueAuthToken } from "../src/services/identity/tokens.js";
import { setTenantMfaPolicy } from "../src/services/identity/mfa.js";
import {
  checkSessionSuspended,
  invalidateAllSuspensions,
} from "../src/services/account-status.js";
import {
  completeOauthLogin,
  saveProviderConfig,
  startOauthLogin,
} from "../../../packages/saas/src/server/oauth-login.js";

describe("enterprise identity and tenancy policy on PGlite", () => {
  let dir: string, db: Db, close: () => Promise<void>, config: AppConfig;
  let tenantsService: TenantService;
  let ownerA: string, ownerB: string, adminA: string, memberA: string, tenantA: string, tenantB: string;

  async function addUser(email: string) {
    const [user] = await db.insert(users).values({ id: newId(), email }).returning();
    return user;
  }

  before(async () => {
    process.env.REDIS_URL = "off";
    dir = mkdtempSync(join(tmpdir(), "zakura-enterprise-policy-"));
    const databaseUrl = `pglite:${join(dir, "db")}`;
    await (await import("../src/db/migrate.js")).runMigrations(databaseUrl);
    const created = await (await import("../src/db/client.js")).createDb({ databaseUrl, dataDir: dir });
    db = created.db; close = created.close;
    config = { dataDir: dir, databaseUrl, secret: "enterprise-policy-secret", publicBaseUrl: "https://api.example.test", webPublicUrl: "https://web.example.test", internalBaseUrl: "http://localhost", multiTenant: true, edition: "saas" } as AppConfig;
    tenantsService = new TenantService(db);
    ownerA = (await addUser("enterprise-owner-a@example.test")).id;
    ownerB = (await addUser("enterprise-owner-b@example.test")).id;
    adminA = (await addUser("enterprise-admin@example.test")).id;
    memberA = (await addUser("enterprise-member@example.test")).id;
    tenantA = (await tenantsService.createTenant({ name: "Enterprise A", slug: "enterprise-a", ownerUserId: ownerA })).tenant.id;
    tenantB = (await tenantsService.createTenant({ name: "Enterprise B", slug: "enterprise-b", ownerUserId: ownerB })).tenant.id;
    const now = new Date();
    await db.insert(tenantMemberships).values([
      { id: newId(), tenantId: tenantA, userId: adminA, role: "admin", status: "active", createdAt: now, updatedAt: now },
      { id: newId(), tenantId: tenantA, userId: memberA, role: "member", status: "active", createdAt: now, updatedAt: now },
    ]);
  });
  after(async () => { await close(); rmSync(dir, { recursive: true, force: true }); });

  it("enforces the role matrix and serializes owner transitions", async () => {
    const member = await db.query.tenantMemberships.findFirst({ where: and(eq(tenantMemberships.tenantId, tenantA), eq(tenantMemberships.userId, memberA)) });
    const originalOwner = await db.query.tenantMemberships.findFirst({ where: and(eq(tenantMemberships.tenantId, tenantA), eq(tenantMemberships.userId, ownerA)) });
    assert.ok(member && originalOwner);
    const promoted = await tenantsService.updateMemberRole(tenantA, member!.id, "owner", ownerA);
    await assert.rejects(tenantsService.updateMemberRole(tenantA, promoted.id, "member", adminA), (error: unknown) => error instanceof TenantAccessError && error.status === 403);
    const transitions = await Promise.allSettled([
      tenantsService.updateMemberRole(tenantA, originalOwner!.id, "member", ownerA),
      tenantsService.updateMemberRole(tenantA, promoted.id, "member", ownerA),
    ]);
    assert.equal(transitions.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(transitions.filter((result) => result.status === "rejected").length, 1);
    const owners = await db.query.tenantMemberships.findMany({ where: and(eq(tenantMemberships.tenantId, tenantA), eq(tenantMemberships.role, "owner"), eq(tenantMemberships.status, "active")) });
    assert.equal(owners.length, 1);
  });

  it("keeps one current invite and never reactivates suspended membership", async () => {
    const inviteActor = await db.query.tenantMemberships.findFirst({ where: and(eq(tenantMemberships.tenantId, tenantA), eq(tenantMemberships.role, "owner"), eq(tenantMemberships.status, "active")) });
    assert.ok(inviteActor);
    const email = `parallel-invite-${newId()}@example.test`;
    const made = await Promise.all([
      tenantsService.createInvite({ tenantId: tenantA, email, role: "admin", invitedByUserId: inviteActor!.userId }),
      tenantsService.createInvite({ tenantId: tenantA, email, role: "member", invitedByUserId: inviteActor!.userId }),
    ]);
    const current = await Promise.all(made.map(({ token }) => tenantsService.getInviteByToken(token)));
    assert.equal(current.filter(Boolean).length, 1);
    assert.equal((await tenantsService.listInvites(tenantA)).filter((invite) => invite.email === email).length, 1);
    const suspendedEmail = `suspended-invite-${newId()}@example.test`;
    const invite = await tenantsService.createInvite({ tenantId: tenantA, email: suspendedEmail, role: "member", invitedByUserId: inviteActor!.userId });
    const suspended = await addUser(suspendedEmail);
    await db.insert(tenantMemberships).values({ id: newId(), tenantId: tenantA, userId: suspended.id, role: "member", status: "suspended", createdAt: new Date(), updatedAt: new Date() });
    await assert.rejects(tenantsService.acceptInvite({ token: invite.token, userId: suspended.id }), (error: unknown) => error instanceof TenantAccessError && error.status === 403);
    assert.equal((await tenantsService.getInviteByToken(invite.token))?.invite.acceptedAt, null);

    const victim = await addUser(`existing-victim-${newId()}@example.test`);
    const victimInvite = await tenantsService.createInvite({
      tenantId: tenantA,
      email: victim.email,
      role: "member",
      invitedByUserId: inviteActor!.userId,
    });
    await assert.rejects(
      tenantsService.acceptInvite({ token: victimInvite.token, email: victim.email }),
      (error: unknown) => error instanceof TenantAccessError && error.status === 401,
    );
    assert.equal(
      await db.query.tenantMemberships.findFirst({
        where: and(eq(tenantMemberships.tenantId, tenantA), eq(tenantMemberships.userId, victim.id)),
      }),
      undefined,
    );
  });

  it("does not auto-link an unverified OAuth email to an existing global account", async () => {
    const victim = await addUser(`oauth-victim-${newId()}@example.test`);
    const deps = {
      db,
      schema,
      secret: "oauth-secret",
      webPublicUrl: "https://web.example.test",
      encryptJson: (_secret: string, value: unknown) => JSON.stringify(value),
      decryptJson: <T,>(_secret: string, value: string) => JSON.parse(value) as T,
    };
    await saveProviderConfig(deps, "google", {
      enabled: true,
      clientId: "client-id",
      clientSecret: "client-secret",
      tokenUrl: "https://oauth.example.test/token",
      userinfoUrl: "https://oauth.example.test/userinfo",
    });
    const start = await startOauthLogin(deps, "google");
    const state = new URL(start.authorizeUrl).searchParams.get("state")!;
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async (input) => {
      const url = String(input);
      if (url.endsWith("/token")) return Response.json({ access_token: "fake-access" });
      if (url.endsWith("/userinfo")) {
        return Response.json({
          sub: `attacker-${newId()}`,
          email: victim.email,
          email_verified: false,
          name: "Attacker",
        });
      }
      throw new Error(`Unexpected URL ${url}`);
    };
    try {
      await assert.rejects(
        completeOauthLogin(deps, "google", { code: "fake-code", state }),
        /Email already registered/,
      );
      assert.equal(
        await db.query.oauthIdentities.findFirst({
          where: eq(schema.oauthIdentities.provider, "google"),
        }),
        undefined,
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("claims domains concurrently, verifies exact TXT and preserves suspension", async () => {
    const domain = `corp-${newId()}.example.test`;
    const [left, right] = await Promise.all([addTenantDomain(db, tenantA, domain), addTenantDomain(db, tenantA, domain)]);
    assert.equal(left.id, right.id);
    await assert.rejects(addTenantDomain(db, tenantB, domain), /其他团队/);
    await assert.rejects(setDomainJoinMode(db, tenantA, left.id, "auto_join"), /必须先验证/);
    await assert.rejects(verifyTenantDomain(db, tenantA, left.id, async () => [[`prefix-${left.txtToken}-suffix`]]), /未找到 TXT/);
    await verifyTenantDomain(db, tenantA, left.id, async () => [[left.txtToken.slice(0, 5), left.txtToken.slice(5)]]);
    await assert.rejects(
      setDomainJoinMode(db, tenantA, left.id, "sso_required"),
      /完成并启用 SSO/,
    );
    await setDomainJoinMode(db, tenantA, left.id, "auto_join");
    const unverified = await addUser(`unverified@${domain}`);
    await maybeAutoJoinTenant(db, {
      userId: unverified.id,
      email: unverified.email,
      emailVerified: false,
    });
    assert.equal(
      await db.query.tenantMemberships.findFirst({
        where: and(eq(tenantMemberships.tenantId, tenantA), eq(tenantMemberships.userId, unverified.id)),
      }),
      undefined,
    );
    const verifyToken = await issueAuthToken(db, { kind: "email_verify", userId: unverified.id });
    assert.equal(await confirmEmailVerification(db, verifyToken), true);
    assert.equal(
      (await db.query.tenantMemberships.findFirst({
        where: and(eq(tenantMemberships.tenantId, tenantA), eq(tenantMemberships.userId, unverified.id)),
      }))?.status,
      "active",
    );
    const autoUser = await addUser(`new@${domain}`);
    await Promise.all([
      maybeAutoJoinTenant(db, { userId: autoUser.id, email: autoUser.email, emailVerified: true }),
      maybeAutoJoinTenant(db, { userId: autoUser.id, email: autoUser.email, emailVerified: true }),
    ]);
    assert.equal((await db.query.tenantMemberships.findMany({ where: eq(tenantMemberships.userId, autoUser.id) })).length, 1);
    const suspended = await addUser(`suspended@${domain}`);
    const [membership] = await db.insert(tenantMemberships).values({ id: newId(), tenantId: tenantA, userId: suspended.id, role: "member", status: "suspended", createdAt: new Date(), updatedAt: new Date() }).returning();
    await maybeAutoJoinTenant(db, { userId: suspended.id, email: suspended.email, emailVerified: true });
    assert.equal((await db.query.tenantMemberships.findFirst({ where: eq(tenantMemberships.id, membership.id) }))?.status, "suspended");
  });

  it("upserts audit retention concurrently and purges per tenant", async () => {
    const audit = new SecurityAuditService(db);
    await assert.rejects(audit.setRetentionDays(tenantA, Number.NaN), /finite/);
    const values = await Promise.all([audit.setRetentionDays(tenantA, 7), audit.setRetentionDays(tenantA, 30)]);
    assert.deepEqual(values.sort((a, b) => a - b), [7, 30]);
    assert.equal((await db.select().from(settings).where(and(eq(settings.ownerKey, `tenant:${tenantA}`), eq(settings.key, "identity.audit")))).length, 1);
    await audit.setRetentionDays(tenantA, 7); await audit.setRetentionDays(tenantB, 365);
    const old = new Date(Date.now() - 10 * 86_400_000);
    await db.insert(securityAuditLogs).values([
      { id: newId(), tenantId: tenantA, actorType: "system", action: "old-a", detailJson: "{}", createdAt: old },
      { id: newId(), tenantId: tenantB, actorType: "system", action: "old-b", detailJson: "{}", createdAt: old },
    ]);
    assert.equal(await audit.purgeExpired(), 1);
    assert.equal(await db.query.securityAuditLogs.findFirst({ where: eq(securityAuditLogs.action, "old-a") }), undefined);
    assert.ok(await db.query.securityAuditLogs.findFirst({ where: eq(securityAuditLogs.action, "old-b") }));
  });

  it("enforces MFA and usage policy through real Hono routes", async () => {
    const audit = new SecurityAuditService(db);
    let session: SessionPayload = { userId: ownerA, tenantId: tenantA, email: "enterprise-owner-a@example.test", role: "owner" };
    const app = new Hono<{ Variables: { session?: SessionPayload } }>();
    app.use("*", async (c, next) => { c.set("session", session); await next(); });
    registerIdentityRoutes(app, { db, config, audit });
    registerUsageRoutes(app as never, { db, usage: new UserUsageStore(db) });
    const policy = await app.request("http://test/api/tenant/identity/mfa", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ policy: "all" }) });
    assert.equal(policy.status, 200, await policy.clone().text());
    session = { userId: memberA, tenantId: tenantA, email: "enterprise-member@example.test", role: "member" };
    const status = await app.request("http://test/api/me/mfa");
    assert.equal(status.status, 200); assert.equal(((await status.json()) as { required: boolean }).required, true);
    const disable = await app.request("http://test/api/me/mfa/totp/disable", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    assert.equal(disable.status, 409);
    await db.insert(tenantMemberships).values({
      id: newId(), tenantId: tenantB, userId: memberA, role: "member", status: "active",
      createdAt: new Date(), updatedAt: new Date(),
    });
    await setTenantMfaPolicy(db, tenantA, "optional");
    await setTenantMfaPolicy(db, tenantB, "all");
    const crossTenantDisable = await app.request("http://test/api/me/mfa/totp/disable", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    assert.equal(crossTenantDisable.status, 409);
    assert.equal((await app.request("http://test/api/usage/me?category=invalid")).status, 400);
    session = { userId: adminA, tenantId: tenantA, email: "enterprise-admin@example.test", role: "admin" };
    assert.equal((await app.request(`http://test/api/usage/users?tenantId=${tenantB}`)).status, 403);
    assert.equal((await app.request("http://test/api/tenant/audit?since=not-a-date")).status, 400);
    session = { ...session, isPlatformAdmin: true };
    const crossTenant = await app.request(`http://test/api/usage/users?tenantId=${tenantB}`);
    assert.equal(crossTenant.status, 200, await crossTenant.clone().text());

    process.env.REDIS_URL = "off";
    invalidateAllSuspensions();
    assert.equal(await checkSessionSuspended(db, { userId: ownerB, tenantId: tenantB }), null);
    await db.update(schema.tenants).set({ suspendedAt: new Date(), suspendedReason: "replica" }).where(eq(schema.tenants.id, tenantB));
    process.env.REDIS_URL = "redis://distributed-cache-enabled.example";
    const distributed = await checkSessionSuspended(db, { userId: ownerB, tenantId: tenantB });
    assert.equal(distributed?.scope, "tenant");
    process.env.REDIS_URL = "off";
    await db.update(schema.tenants).set({ suspendedAt: null, suspendedReason: null }).where(eq(schema.tenants.id, tenantB));
    invalidateAllSuspensions();
  });
});
