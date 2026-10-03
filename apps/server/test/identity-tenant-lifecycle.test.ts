import assert from "node:assert/strict";
import { createSign, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { and, eq, or } from "drizzle-orm";
import { Hono } from "hono";
import type { Db } from "../src/db/client.js";
import {
  apiKeys,
  connectorAuthProfiles,
  connectorSettings,
  newId,
  oauthIdentities,
  platformServiceQuotas,
  scimUserMappings,
  securityAuditLogs,
  settings,
  skillSourceTokens,
  ssoLoginStates,
  tenants,
  tenantMemberships,
  tenantDomains,
  userWebauthnCredentials,
  users,
} from "../src/db/schema.js";
import { hashApiKey } from "@zakura/core";
import { registerScimRoutes } from "../src/api/scim-routes.js";
import { registerIdentityRoutes } from "../src/api/identity-routes.js";
import type { AppConfig } from "../src/config.js";
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
import { authenticateApiKey, signSession, verifySession } from "../src/services/auth.js";
import { IdentitySessionService } from "../src/services/identity/sessions.js";
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
    const lifecycleTenant = await service.createTenant({
      name: "Lifecycle target",
      slug: `lifecycle-${newId()}`,
      ownerUserId: ownerB,
    });
    const soleOwner = await addUser(`sole-owner-${newId()}@example.test`);
    const dependentMember = await addUser(`dependent-member-${newId()}@example.test`);
    const governedTenant = await service.createTenant({
      name: "Governed tenant",
      slug: `governed-${newId()}`,
      ownerUserId: soleOwner.id,
    });
    await db.insert(tenantMemberships).values({
      id: newId(),
      tenantId: governedTenant.tenant.id,
      userId: dependentMember.id,
      role: "member",
      status: "active",
      createdAt: now,
      updatedAt: now,
    });
    const lifecycleEvents: string[] = [];
    const unregisterLifecycle = service.registerLifecycleHook({
      afterSuspend: async (tenantId) => lifecycleEvents.push(`suspend:${tenantId}`),
      afterMemberRemoved: async (tenantId, userId) =>
        lifecycleEvents.push(`member:${tenantId}:${userId}`),
    });
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
        isPlatformAdmin: true,
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
      mfaForLogin: async (input: { tenantId: string }) =>
        input.tenantId === lifecycleTenant.tenant.id
          ? ({ action: "enroll" as const, ticket: "enrollment-ticket" })
          : ({ action: "allow" as const }),
      switchTenantSession: async () => null,
      isSessionAdmin: (session: SaasSession) => session.role === "owner" || session.role === "admin",
      ensurePlatformMeta: async () => ({ setupCompleted: true, mode: "multi-tenant", version: "test" }),
      resolveRegistrationJoin: async (email: string) =>
        email.endsWith("@autojoin.example.test")
          ? ({ action: "auto_join" as const, tenantId: lifecycleTenant.tenant.id, role: "member" as const })
          : ({ action: "create_tenant" as const }),
      schema,
    } satisfies SaasHostDeps & { schema: typeof schema };
    registerSaasRoutes(app, deps);

    const unverifiedAutoJoin = await app.request("http://test/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: `unverified-${newId()}@autojoin.example.test`,
        password: "registration-password",
        tenantName: "Unverified personal tenant",
      }),
    });
    assert.equal(unverifiedAutoJoin.status, 201, await unverifiedAutoJoin.clone().text());
    const unverifiedBody = await unverifiedAutoJoin.json() as {
      user: { id: string };
      tenant: { id: string };
    };
    assert.notEqual(unverifiedBody.tenant.id, lifecycleTenant.tenant.id);
    assert.equal(
      await db.query.tenantMemberships.findFirst({
        where: and(
          eq(tenantMemberships.tenantId, lifecycleTenant.tenant.id),
          eq(tenantMemberships.userId, unverifiedBody.user.id),
        ),
      }),
      undefined,
    );

    await db.insert(tenantMemberships).values({
      id: newId(), tenantId: lifecycleTenant.tenant.id, userId: routeOwner.id,
      role: "member", status: "active", createdAt: now, updatedAt: now,
    });
    const blockedSwitch = await app.request("http://test/api/auth/switch-tenant", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId: lifecycleTenant.tenant.id }),
    });
    assert.equal(blockedSwitch.status, 200);
    const blockedSwitchBody = await blockedSwitch.json() as {
      code?: string;
      mfaEnrollmentTicket?: string;
    };
    assert.equal(blockedSwitchBody.code, "mfa_enrollment_required");
    assert.equal(blockedSwitchBody.mfaEnrollmentTicket, "enrollment-ticket");

    const missingDefaults = await app.request("http://test/api/admin/agent-defaults");
    assert.equal(missingDefaults.status, 503);

    const invalidRole = await app.request(
      `http://test/api/admin/tenants/${routeTenant.tenant.id}/members`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ userId: ownerB, role: "viewer" }),
      },
    );
    assert.equal(invalidRole.status, 400, await invalidRole.clone().text());

    const oldPayload = verifySession(
      "route-secret",
      signSession("route-secret", {
        userId: routeMember.id,
        tenantId: routeTenant.tenant.id,
        email: routeMember.email,
        role: "member",
        iat: Math.floor(Date.now() / 1000) - 60,
      }),
    )!;
    const passwordUpdate = await app.request(`http://test/api/admin/users/${routeMember.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "replacement-password" }),
    });
    assert.equal(passwordUpdate.status, 200, await passwordUpdate.clone().text());
    assert.equal((await new IdentitySessionService(db).lookup(oldPayload)).status, "invalid");

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

    const suspendSoleOwner = await app.request(
      `http://test/api/admin/tenants/${routeTenant.tenant.id}/members/${routeTenant.membership.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "suspended" }),
      },
    );
    assert.equal(suspendSoleOwner.status, 400, await suspendSoleOwner.clone().text());
    const deleteSoleOwner = await app.request(
      `http://test/api/admin/tenants/${routeTenant.tenant.id}/members/${routeTenant.membership.id}`,
      { method: "DELETE" },
    );
    assert.equal(deleteSoleOwner.status, 400, await deleteSoleOwner.clone().text());

    const suspendSoleOwnerUser = await app.request(
      `http://test/api/admin/users/${soleOwner.id}/suspend`,
      { method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
    );
    assert.equal(suspendSoleOwnerUser.status, 400, await suspendSoleOwnerUser.clone().text());
    const deleteSoleOwnerUser = await app.request(
      `http://test/api/admin/users/${soleOwner.id}`,
      { method: "DELETE" },
    );
    assert.equal(deleteSoleOwnerUser.status, 400, await deleteSoleOwnerUser.clone().text());

    const concurrentOwnerA = await addUser(`concurrent-owner-a-${newId()}@example.test`);
    const concurrentOwnerB = await addUser(`concurrent-owner-b-${newId()}@example.test`);
    const concurrentTenant = await service.createTenant({
      name: "Concurrent global owner guard",
      slug: `global-owner-${newId()}`,
      ownerUserId: concurrentOwnerA.id,
    });
    await db.insert(tenantMemberships).values({
      id: newId(), tenantId: concurrentTenant.tenant.id, userId: concurrentOwnerB.id,
      role: "owner", status: "active", createdAt: now, updatedAt: now,
    });
    const suspendGlobalOwner = (userId: string) =>
      app.request(`http://test/api/admin/users/${userId}/suspend`, {
        method: "POST", headers: { "content-type": "application/json" }, body: "{}",
      });
    const concurrentSuspensions = await Promise.all([
      suspendGlobalOwner(concurrentOwnerA.id),
      suspendGlobalOwner(concurrentOwnerB.id),
    ]);
    assert.deepEqual(concurrentSuspensions.map((response) => response.status).sort(), [200, 400]);

    const suspendMember = await app.request(
      `http://test/api/admin/tenants/${routeTenant.tenant.id}/members/${routeMembership.id}`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "suspended" }),
      },
    );
    assert.equal(suspendMember.status, 200, await suspendMember.clone().text());
    assert.ok(lifecycleEvents.includes(`member:${routeTenant.tenant.id}:${routeMember.id}`));

    const suspendTenant = await app.request(
      `http://test/api/admin/tenants/${lifecycleTenant.tenant.id}/suspend`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "lifecycle test" }),
      },
    );
    assert.equal(suspendTenant.status, 200, await suspendTenant.clone().text());
    assert.ok(lifecycleEvents.includes(`suspend:${lifecycleTenant.tenant.id}`));

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
    unregisterLifecycle();
  });

  it("deletes tenant-owned credential/state rows, callbacks and cached API-key auth", async () => {
    const deletion = await service.createTenant({
      name: "Deletion aggregate",
      slug: `delete-${newId()}`,
      ownerUserId: ownerA,
    });
    const tenantId = deletion.tenant.id;
    const rawKey = `zak_test_${newId()}`;
    const keyHash = hashApiKey(rawKey);
    const now = new Date();
    await db.insert(apiKeys).values({
      id: newId(), tenantId, name: "cached", keyHash, keyPrefix: rawKey.slice(0, 8), scopes: '["*"]', createdAt: now,
    });
    await db.insert(connectorAuthProfiles).values({
      id: newId(), scopeKey: tenantId, profileKey: "owned", label: "Owned", kind: "custom", enabled: true,
      configEnc: "encrypted-profile", createdAt: now, updatedAt: now,
    });
    await db.insert(connectorSettings).values({
      id: newId(), scopeKey: tenantId, connectorRef: "owned", configEnc: "encrypted-settings", createdAt: now, updatedAt: now,
    });
    await db.insert(skillSourceTokens).values({
      id: newId(), scopeKey: tenantId, provider: "github", tokenEnc: "encrypted-token", hint: "oken", createdAt: now, updatedAt: now,
    });
    await db.insert(platformServiceQuotas).values({
      id: newId(), scopeKey: tenantId, serviceKey: "*", monthlyLimit: 10, createdAt: now, updatedAt: now,
    });
    await db.insert(settings).values([
      { id: newId(), ownerKey: tenantId, key: "skills.auto-update", value: "{}" },
      { id: newId(), ownerKey: `tenant:${tenantId}`, key: "identity.audit", value: "{}" },
    ]);
    assert.equal((await authenticateApiKey(db, rawKey))?.tenant.id, tenantId);
    const directlyRevoked = `zak_test_${newId()}`;
    const directHash = hashApiKey(directlyRevoked);
    const [directRow] = await db.insert(apiKeys).values({
      id: newId(), tenantId, name: "direct revoke", keyHash: directHash,
      keyPrefix: directlyRevoked.slice(0, 8), scopes: '["*"]', createdAt: now,
    }).returning();
    assert.ok(await authenticateApiKey(db, directlyRevoked));
    await db.delete(apiKeys).where(eq(apiKeys.id, directRow.id));
    assert.equal(await authenticateApiKey(db, directlyRevoked), null);

    const lifecycle: string[] = [];
    const aggregate = new TenantService(db, [{
      beforeDelete: async (id) => { lifecycle.push(`before:${id}`); },
      afterDelete: async (id) => { lifecycle.push(`after:${id}`); },
    }]);
    await aggregate.deleteTenant(tenantId, ownerA);
    assert.deepEqual(lifecycle, [`before:${tenantId}`, `after:${tenantId}`]);
    assert.equal(await authenticateApiKey(db, rawKey), null);
    assert.equal(
      (await db.select().from(connectorAuthProfiles).where(eq(connectorAuthProfiles.scopeKey, tenantId))).length,
      0,
    );
    assert.equal(
      (await db.select().from(connectorSettings).where(eq(connectorSettings.scopeKey, tenantId))).length,
      0,
    );
    assert.equal(
      (await db.select().from(skillSourceTokens).where(eq(skillSourceTokens.scopeKey, tenantId))).length,
      0,
    );
    assert.equal(
      (await db.select().from(platformServiceQuotas).where(eq(platformServiceQuotas.scopeKey, tenantId))).length,
      0,
    );
    assert.equal(
      (await db.select().from(settings).where(or(eq(settings.ownerKey, tenantId), eq(settings.ownerKey, `tenant:${tenantId}`)))).length,
      0,
    );

    const blocked = await service.createTenant({
      name: "Blocked deletion",
      slug: `blocked-delete-${newId()}`,
      ownerUserId: ownerA,
    });
    const guarded = new TenantService(db, [{
      beforeDelete: async () => { throw new Error("runtime teardown failed"); },
    }]);
    await assert.rejects(
      guarded.deleteTenant(blocked.tenant.id, ownerA),
      /runtime teardown failed/,
    );
    assert.ok(await db.query.tenants.findFirst({ where: eq(tenants.id, blocked.tenant.id) }));
  });

  it("enforces tenant-bound SCIM routes, group roles and token revocation", async () => {
    const first = await createScimToken(db, tenantA, { groupRoleMap: { Admins: "admin" } });
    const second = await createScimToken(db, tenantB, { groupRoleMap: { Admins: "admin" } });
    const app = new Hono();
    const lifecycleEvents: string[] = [];
    const unregisterLifecycle = service.registerLifecycleHook({
      afterMemberRemoved: async (tenantId, userId) =>
        lifecycleEvents.push(`${tenantId}:${userId}`),
    });
    registerScimRoutes(app, {
      db,
      audit: new SecurityAuditService(db),
      tenantLifecycle: service,
    });

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
      where: and(
        eq(tenantMemberships.tenantId, tenantA),
        eq(tenantMemberships.userId, mapping!.userId),
      ),
    });
    assert.equal(membership?.role, "admin");

    const failedGroupReplace = await app.request(`http://test/scim/v2/Groups/${groupId}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${first.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        Operations: [
          { op: "replace", path: "members", value: [] },
          { op: { invalid: true }, path: "members", value: [] },
        ],
      }),
    });
    assert.equal(failedGroupReplace.status, 400);
    assert.equal(
      (await db.query.tenantMemberships.findFirst({ where: eq(tenantMemberships.id, membership!.id) }))?.role,
      "admin",
    );

    const deactivate = await app.request(`http://test/scim/v2/Users/${provisioned.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${first.token}`, "content-type": "application/json" },
      body: JSON.stringify({ Operations: [{ op: "replace", path: "active", value: false }] }),
    });
    assert.equal(deactivate.status, 200, await deactivate.clone().text());
    assert.ok(lifecycleEvents.includes(`${tenantA}:${mapping!.userId}`));
    const reactivate = await app.request(`http://test/scim/v2/Users/${provisioned.id}`, {
      method: "PATCH",
      headers: { authorization: `Bearer ${first.token}`, "content-type": "application/json" },
      body: JSON.stringify({ Operations: [{ op: "replace", path: "active", value: true }] }),
    });
    assert.equal(reactivate.status, 200, await reactivate.clone().text());

    await db.insert(tenantMemberships).values({
      id: newId(),
      tenantId: tenantB,
      userId: mapping!.userId,
      role: "member",
      status: "active",
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const profileChange = await app.request(`http://test/scim/v2/Users/${provisioned.id}`, {
      method: "PUT",
      headers: { authorization: `Bearer ${first.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        userName: "changed-by-scim@example.test",
        displayName: "Changed by SCIM",
        externalId: "ext-1",
        active: true,
      }),
    });
    assert.equal(profileChange.status, 409, await profileChange.clone().text());
    const unchangedUser = await db.query.users.findFirst({ where: eq(users.id, mapping!.userId) });
    assert.equal(unchangedUser?.email, "scim-user@example.test");
    assert.equal(unchangedUser?.name, "SCIM User");

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
    unregisterLifecycle();
  });

  it("atomically consumes SSO state and completes OIDC against a fake IdP", async () => {
    const secret = "sso-test-secret";
    const urls = { webPublicUrl: "https://web.example.test", publicBaseUrl: "https://api.example.test" };
    await db.insert(tenantDomains).values({
      id: newId(),
      tenantId: tenantA,
      domain: "example.test",
      txtToken: "verified-for-test",
      verifiedAt: new Date(),
      joinMode: "sso_required",
    });
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

      await db.insert(userWebauthnCredentials).values({
        id: newId(), userId: firstLogin.user.id, credentialId: `sso-cred-${newId()}`,
        publicKey: "AA", counter: 0, name: "SSO passkey", transportsJson: "[]", createdAt: new Date(),
      });
      const mfaStart = await startOidcSso(db, urls, "acme-a");
      const mfaAuthorize = new URL(mfaStart.authorizeUrl);
      expectedNonce = mfaAuthorize.searchParams.get("nonce")!;
      assertedEmail = firstLogin.user.email;
      const identityApp = new Hono();
      registerIdentityRoutes(identityApp as never, {
        db,
        config: { secret, ...urls, dataDir: dir } as AppConfig,
        audit: new SecurityAuditService(db),
      });
      const mfaCallback = await identityApp.request("http://test/api/auth/sso/oidc/callback", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "mfa-code", state: mfaAuthorize.searchParams.get("state") }),
      });
      assert.equal(mfaCallback.status, 200, await mfaCallback.clone().text());
      const mfaBody = await mfaCallback.json() as { session?: string; mfaRequired?: boolean; methods?: string[] };
      assert.equal(mfaBody.session, undefined);
      assert.equal(mfaBody.mfaRequired, true);
      assert.deepEqual(mfaBody.methods, ["webauthn"]);

      await upsertTenantSso(db, secret, tenantB, {
        enabled: true,
        protocol: "oidc",
        issuer: "https://idp.example.test",
        clientId: "client-1",
        clientSecret: "client-secret",
        authorizeUrl: "https://idp.example.test/authorize",
        tokenUrl: "https://idp.example.test/token",
        jwksUrl: "https://idp.example.test/jwks",
        jitEnabled: true,
      });
      assertedEmail = firstLogin.user.email;
      const hostileStart = await startOidcSso(db, urls, "acme-b");
      const hostileAuthorize = new URL(hostileStart.authorizeUrl);
      expectedNonce = hostileAuthorize.searchParams.get("nonce")!;
      await assert.rejects(
        completeOidcSso(db, secret, urls, {
          code: "hostile-code",
          state: hostileAuthorize.searchParams.get("state")!,
        }),
        /可信关联/,
      );
      const hostileIdentity = await db.query.oauthIdentities.findFirst({
        where: and(
          eq(oauthIdentities.provider, `sso:${tenantB}`),
          eq(oauthIdentities.providerUserId, "subject-1"),
        ),
      });
      assert.equal(hostileIdentity, undefined);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
