import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../src/db/client.js";
import {
  newId,
  oauthIdentities,
  scimUserMappings,
  securityAuditLogs,
  ssoLoginStates,
  tenantMemberships,
  users,
} from "../src/db/schema.js";
import { registerScimRoutes } from "../src/api/scim-routes.js";
import { SecurityAuditService } from "../src/services/identity/audit.js";
import {
  createScimToken,
  revokeScimToken,
} from "../src/services/identity/scim.js";
import {
  claimSsoState,
  completeOidcSso,
  startOidcSso,
  upsertTenantSso,
} from "../src/services/identity/sso.js";
import { TenantAccessError, TenantService } from "../src/services/tenants.js";
import { AdminMembershipService, SaasAdminError } from "../../../packages/saas/src/server/admin-memberships.js";
import { RegisterError, registerSaasUser } from "../../../packages/saas/src/server/register-user.js";
import { registerSaasRoutes } from "../../../packages/saas/src/server/routes.js";
import type { SaasHostDeps, SaasSession } from "../../../packages/saas/src/server/types.js";
import * as schema from "../src/db/schema.js";

describe("identity tenancy lifecycle on PGlite", () => {
  let dir: string;
  let db: Db;
  let close: () => Promise<void>;
  let ownerA: string;
  let ownerB: string;
  let tenantA: string;
  let tenantB: string;
  let service: TenantService;

  async function addUser(email: string) {
    const [user] = await db
      .insert(users)
      .values({ id: newId(), email, name: email.split("@")[0] })
      .returning();
    return user;
  }

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), "zakura-identity-lifecycle-"));
    const databaseUrl = `pglite:${join(dir, "db")}`;
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(databaseUrl);
    const created = await (await import("../src/db/client.js")).createDb({ databaseUrl, dataDir: dir });
    db = created.db;
    close = created.close;
    service = new TenantService(db);

    ownerA = (await addUser("owner-a@example.test")).id;
    ownerB = (await addUser("owner-b@example.test")).id;
    tenantA = (await service.createTenant({ name: "Acme A", slug: "acme-a", ownerUserId: ownerA })).tenant.id;
    tenantB = (await service.createTenant({ name: "Acme B", slug: "acme-b", ownerUserId: ownerB })).tenant.id;
  });

  after(async () => {
    await close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("qualifies member and invite mutations by tenant and role", async () => {
    const member = await addUser("member@example.test");
    const now = new Date();
    const [membershipA] = await db
      .insert(tenantMemberships)
      .values({
        id: newId(), tenantId: tenantA, userId: member.id, role: "member", status: "active", createdAt: now, updatedAt: now,
      })
      .returning();
    const [membershipB] = await db
      .insert(tenantMemberships)
      .values({
        id: newId(), tenantId: tenantB, userId: member.id, role: "member", status: "active", createdAt: now, updatedAt: now,
      })
      .returning();

    await assert.rejects(
      service.updateMemberRole(tenantA, membershipB.id, "admin", ownerA),
      (error: unknown) => error instanceof TenantAccessError && error.status === 404,
    );
    await assert.rejects(
      service.updateMemberRole(tenantA, membershipA.id, "admin", member.id),
      (error: unknown) => error instanceof TenantAccessError && error.status === 403,
    );
    const promoted = await service.updateMemberRole(tenantA, membershipA.id, "admin", ownerA);
    assert.equal(promoted.role, "admin");

    const foreignInvite = await service.createInvite({
      tenantId: tenantB, email: "foreign@example.test", role: "member", invitedByUserId: ownerB,
    });
    await assert.rejects(
      service.revokeInvite(tenantA, foreignInvite.invite.id, ownerA),
      (error: unknown) => error instanceof TenantAccessError && error.status === 404,
    );
    assert.ok(await service.getInviteByToken(foreignInvite.token));
    await service.revokeInvite(tenantB, foreignInvite.invite.id, ownerB);
    assert.equal(await service.getInviteByToken(foreignInvite.token), null);
  });

  it("redeems an invite once under concurrent calls and commits one membership", async () => {
    const email = `race-${newId()}@example.test`;
    const { token } = await service.createInvite({
      tenantId: tenantA, email, role: "admin", invitedByUserId: ownerA,
    });
    const attempts = await Promise.allSettled([
      service.acceptInvite({ token, email, password: "correct-horse" }),
      service.acceptInvite({ token, email, password: "correct-horse" }),
    ]);
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((result) => result.status === "rejected").length, 1);
    const user = await db.query.users.findFirst({ where: eq(users.email, email) });
    assert.ok(user);
    const memberships = await db.query.tenantMemberships.findMany({
      where: eq(tenantMemberships.userId, user!.id),
    });
    assert.deepEqual(memberships.map((row) => [row.tenantId, row.role, row.status]), [[tenantA, "admin", "active"]]);
  });

  it("uses the unique slug constraint as the concurrent creation boundary", async () => {
    const [left, right] = await Promise.all([
      service.createTenant({ name: "Collision", slug: "same-slug", ownerUserId: ownerA }),
      service.createTenant({ name: "Collision", slug: "same-slug", ownerUserId: ownerA }),
    ]);
    assert.notEqual(left.tenant.slug, right.tenant.slug);
    assert.ok(left.tenant.slug === "same-slug" || right.tenant.slug === "same-slug");
  });

  it("serializes SaaS admin owner transitions so a tenant keeps an active owner", async () => {
    const isolated = await service.createTenant({
      name: "Admin lifecycle", slug: `admin-${newId()}`, ownerUserId: ownerA,
    });
    const now = new Date();
    const [secondOwner] = await db
      .insert(tenantMemberships)
      .values({
        id: newId(), tenantId: isolated.tenant.id, userId: ownerB, role: "owner", status: "active", createdAt: now, updatedAt: now,
      })
      .returning();
    const admin = new AdminMembershipService(db, schema);
    const attempts = await Promise.allSettled([
      admin.update(isolated.tenant.id, isolated.membership.id, { role: "member" }),
      admin.update(isolated.tenant.id, secondOwner.id, { status: "suspended" }),
    ]);
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((result) => result.status === "rejected").length, 1);
    assert.ok(
      attempts.some(
        (result) => result.status === "rejected" && result.reason instanceof SaasAdminError,
      ),
    );
    const remaining = await db.query.tenantMemberships.findMany({
      where: eq(tenantMemberships.tenantId, isolated.tenant.id),
    });
    assert.equal(remaining.filter((row) => row.role === "owner" && row.status === "active").length, 1);
  });

  it("registers one SaaS account atomically under concurrent requests", async () => {
    const email = `register-${newId()}@example.test`;
    const register = () =>
      registerSaasUser(db, schema, {
        email,
        password: "a-secure-password",
        tenantName: "Concurrent registration",
      });
    const attempts = await Promise.allSettled([register(), register()]);
    assert.equal(attempts.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(attempts.filter((result) => result.status === "rejected").length, 1);
    assert.ok(
      attempts.some(
        (result) => result.status === "rejected" && result.reason instanceof RegisterError,
      ),
    );
    const user = await db.query.users.findFirst({ where: eq(users.email, email) });
    assert.ok(user);
    const memberships = await db.query.tenantMemberships.findMany({
      where: eq(tenantMemberships.userId, user!.id),
    });
    assert.equal(memberships.length, 1);
    assert.equal(memberships[0]!.role, "owner");
  });

  it("enforces membership and invite boundaries through the real SaaS routes", async () => {
    const routeOwner = await addUser(`route-owner-${newId()}@example.test`);
    const routeMember = await addUser(`route-member-${newId()}@example.test`);
    const routeTenant = await service.createTenant({
      name: "Route tenant", slug: `route-${newId()}`, ownerUserId: routeOwner.id,
    });
    const now = new Date();
    const [routeMembership] = await db
      .insert(tenantMemberships)
      .values({
        id: newId(), tenantId: routeTenant.tenant.id, userId: routeMember.id, role: "member", status: "active", createdAt: now, updatedAt: now,
      })
      .returning();
    const foreign = await db.query.tenantMemberships.findFirst({
      where: eq(tenantMemberships.tenantId, tenantB),
    });

    const app = new Hono<{ Variables: { session?: SaasSession } }>();
    app.use("*", async (context, next) => {
      context.set("session", {
        userId: routeOwner.id,
        tenantId: routeTenant.tenant.id,
        email: routeOwner.email,
        role: "owner",
        isPlatformAdmin: false,
      });
      await next();
    });
    const deps = {
      db,
      config: {
        secret: "route-secret",
        webPublicUrl: "https://web.example.test",
        multiTenant: true,
        edition: "saas" as const,
      },
      encryptJson: (_secret: string, value: unknown) => JSON.stringify(value),
      decryptJson: <T,>(_secret: string, payload: string) => JSON.parse(payload) as T,
      tenants: service,
      signSession: () => "signed",
      sessionFromLogin: () => "signed",
      switchTenantSession: async () => null,
      isSessionAdmin: (session: SaasSession) => session.role === "owner" || session.role === "admin",
      ensurePlatformMeta: async () => ({ setupCompleted: true, mode: "multi-tenant", version: "test" }),
      schema,
    } satisfies SaasHostDeps & { schema: typeof schema };
    registerSaasRoutes(app, deps);

    const foreignPatch = await app.request(`http://test/api/tenant/members/${foreign!.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    });
    assert.equal(foreignPatch.status, 404);
    const promote = await app.request(`http://test/api/tenant/members/${routeMembership.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role: "admin" }),
    });
    assert.equal(promote.status, 200, await promote.clone().text());

    const inviteResponse = await app.request("http://test/api/tenant/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: `route-invite-${newId()}@example.test`, role: "member" }),
    });
    assert.equal(inviteResponse.status, 201, await inviteResponse.clone().text());
    const invite = (await inviteResponse.json()) as { invite: { id: string }; token: string };
    const revoke = await app.request(`http://test/api/tenant/invites/${invite.invite.id}`, { method: "DELETE" });
    assert.equal(revoke.status, 200, await revoke.clone().text());
    const afterRevoke = await app.request(`http://test/api/invites/${invite.token}`);
    assert.equal(afterRevoke.status, 404);
  });

  it("enforces tenant-bound SCIM routes, group roles and token revocation", async () => {
    const first = await createScimToken(db, tenantA, { groupRoleMap: { Admins: "admin" } });
    const second = await createScimToken(db, tenantB, { groupRoleMap: { Admins: "admin" } });
    const app = new Hono();
    registerScimRoutes(app, { db, audit: new SecurityAuditService(db) });

    const createdResponse = await app.request("http://test/scim/v2/Users", {
      method: "POST",
      headers: { authorization: `Bearer ${first.token}`, "content-type": "application/json" },
      body: JSON.stringify({ userName: "scim-user@example.test", externalId: "ext-1", displayName: "SCIM User" }),
    });
    assert.equal(createdResponse.status, 201, await createdResponse.clone().text());
    const provisioned = (await createdResponse.json()) as { id: string; userName: string };

    const foreignRead = await app.request(`http://test/scim/v2/Users/${provisioned.id}`, {
      headers: { authorization: `Bearer ${second.token}` },
    });
    assert.equal(foreignRead.status, 404);

    const groupsResponse = await app.request("http://test/scim/v2/Groups", {
      headers: { authorization: `Bearer ${first.token}` },
    });
    const groups = (await groupsResponse.json()) as { Resources: Array<{ id: string }> };
    const groupId = groups.Resources[0]!.id;
    const groupPatch = await app.request(`http://test/scim/v2/Groups/${groupId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${first.token}`, "content-type": "application/json" },
      body: JSON.stringify({ Operations: [{ op: "add", path: "members", value: [{ value: provisioned.id }] }] }),
    });
    assert.equal(groupPatch.status, 200, await groupPatch.clone().text());
    const mapping = await db.query.scimUserMappings.findFirst({ where: eq(scimUserMappings.id, provisioned.id) });
    const membership = await db.query.tenantMemberships.findFirst({
      where: eq(tenantMemberships.userId, mapping!.userId),
    });
    assert.equal(membership?.role, "admin");

    const remove = await app.request(`http://test/scim/v2/Groups/${groupId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${first.token}`, "content-type": "application/json" },
      body: JSON.stringify({ Operations: [{ op: "remove", path: `members[value eq "${provisioned.id}"]` }] }),
    });
    assert.equal(remove.status, 200);
    const demoted = await db.query.tenantMemberships.findFirst({ where: eq(tenantMemberships.id, membership!.id) });
    assert.equal(demoted?.role, "member");

    await revokeScimToken(db, tenantA, first.id);
    const revoked = await app.request("http://test/scim/v2/Users", {
      headers: { authorization: `Bearer ${first.token}` },
    });
    assert.equal(revoked.status, 401);
    const auditRows = await db.select().from(securityAuditLogs).where(eq(securityAuditLogs.tenantId, tenantA));
    assert.ok(auditRows.some((row) => row.action === "scim.user_create"));
  });

  it("atomically consumes SSO state and completes OIDC against a fake IdP", async () => {
    const secret = "sso-test-secret";
    const urls = { webPublicUrl: "https://web.example.test", publicBaseUrl: "https://api.example.test" };
    await upsertTenantSso(db, secret, tenantA, {
      enabled: true,
      protocol: "oidc",
      issuer: "https://idp.example.test",
      clientId: "client-1",
      clientSecret: "client-secret",
      authorizeUrl: "https://idp.example.test/authorize",
      tokenUrl: "https://idp.example.test/token",
      jwksUrl: "https://idp.example.test/jwks",
      jitEnabled: true,
      defaultRole: "member",
    });

    const atomicState = `state-${newId()}`;
    await db.insert(ssoLoginStates).values({
      id: atomicState, tenantId: tenantA, protocol: "oidc", expiresAt: new Date(Date.now() + 60_000),
    });
    const claims = await Promise.allSettled([
      claimSsoState(db, atomicState, "oidc"),
      claimSsoState(db, atomicState, "oidc"),
    ]);
    assert.equal(claims.filter((result) => result.status === "fulfilled").length, 1);

    const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = publicKey.export({ format: "jwk" });
    const originalFetch = globalThis.fetch;
    let assertedVerifier = false;
    let assertedEmail = "oidc-user@example.test";
    let expectedNonce = "";
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      if (url.endsWith("/jwks")) return Response.json({ keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] });
      if (url.endsWith("/token")) {
        const form = new URLSearchParams(String(init?.body ?? ""));
        assertedVerifier = Boolean(form.get("code_verifier"));
        const now = Math.floor(Date.now() / 1000);
        const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid: "test-key" })).toString("base64url");
        const payload = Buffer.from(JSON.stringify({
          iss: "https://idp.example.test", aud: "client-1", sub: "subject-1", email: assertedEmail,
          name: "OIDC User", nonce: expectedNonce, iat: now, exp: now + 300,
        })).toString("base64url");
        const signer = createSign("RSA-SHA256");
        signer.update(`${header}.${payload}`);
        signer.end();
        const signature = signer.sign(privateKey).toString("base64url");
        return Response.json({ id_token: `${header}.${payload}.${signature}` });
      }
      throw new Error(`Unexpected fake IdP URL: ${url}`);
    };
    try {
      const start = await startOidcSso(db, urls, "acme-a");
      const authorize = new URL(start.authorizeUrl);
      expectedNonce = authorize.searchParams.get("nonce")!;
      const state = authorize.searchParams.get("state")!;
      const firstLogin = await completeOidcSso(db, secret, urls, { code: "code-1", state });
      assert.equal(firstLogin.user.email, "oidc-user@example.test");
      assert.equal(firstLogin.tenant.id, tenantA);
      assert.equal(assertedVerifier, true);
      await assert.rejects(completeOidcSso(db, secret, urls, { code: "code-1", state }), /状态/);

      assertedEmail = "renamed-at-idp@example.test";
      const secondStart = await startOidcSso(db, urls, "acme-a");
      const secondAuthorize = new URL(secondStart.authorizeUrl);
      expectedNonce = secondAuthorize.searchParams.get("nonce")!;
      const secondLogin = await completeOidcSso(db, secret, urls, {
        code: "code-2",
        state: secondAuthorize.searchParams.get("state")!,
      });
      assert.equal(secondLogin.user.id, firstLogin.user.id);
      assert.equal(secondLogin.user.email, "oidc-user@example.test");
      const identities = await db.select().from(oauthIdentities).where(eq(oauthIdentities.providerUserId, "subject-1"));
      assert.equal(identities.length, 1);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
