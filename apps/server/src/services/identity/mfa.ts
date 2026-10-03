import { eq, and } from "drizzle-orm";
import { randomBytes } from "node:crypto";
import { Secret, TOTP } from "otpauth";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import type { Db } from "../../db/client.js";
import {
  newId,
  settings,
  tenantMemberships,
  userRecoveryCodes,
  userTotp,
  userWebauthnCredentials,
  users,
} from "../../db/schema.js";
import { encryptJson, decryptJson } from "@zakura/core";
import { hashToken, rpFromWebUrl } from "./util.js";
import { CredentialLifecycleService } from "./credential-lifecycle.js";

const pendingChallenge = new Map<string, { challenge: string; expiresAt: number }>();
const MFA_POLICY_KEY = "identity.mfa";

function transactionDb(value: unknown): Db {
  return value as Db;
}

export type TenantMfaPolicy = "optional" | "admins" | "all";

export function parseTenantMfaPolicy(value: unknown): TenantMfaPolicy {
  return value === "admins" || value === "all" ? value : "optional";
}

export function tenantMfaPolicyRequires(policy: TenantMfaPolicy, role: string): boolean {
  return policy === "all" || (policy === "admins" && (role === "owner" || role === "admin"));
}

export async function getTenantMfaPolicy(db: Db, tenantId: string): Promise<TenantMfaPolicy> {
  const row = await db.query.settings.findFirst({
    where: and(eq(settings.ownerKey, `tenant:${tenantId}`), eq(settings.key, MFA_POLICY_KEY)),
  });
  try {
    return parseTenantMfaPolicy(JSON.parse(row?.value ?? "{}").policy);
  } catch {
    return "optional";
  }
}

export async function setTenantMfaPolicy(
  db: Db,
  tenantId: string,
  policy: TenantMfaPolicy,
): Promise<TenantMfaPolicy> {
  if (policy !== "optional" && policy !== "admins" && policy !== "all") {
    throw new Error("无效的 MFA 策略");
  }
  const ownerKey = `tenant:${tenantId}`;
  const value = JSON.stringify({ policy });
  await db
    .insert(settings)
    .values({ id: newId(), ownerKey, key: MFA_POLICY_KEY, value })
    .onConflictDoUpdate({
      target: [settings.ownerKey, settings.key],
      set: { value },
    });
  return policy;
}

/** MFA factors are global to a user, so every active tenant policy must agree to removal. */
export async function userRequiresMfaInAnyTenant(db: Db, userId: string): Promise<boolean> {
  const memberships = await db.query.tenantMemberships.findMany({
    where: and(
      eq(tenantMemberships.userId, userId),
      eq(tenantMemberships.status, "active"),
    ),
  });
  for (const membership of memberships) {
    const policy = await getTenantMfaPolicy(db, membership.tenantId);
    if (tenantMfaPolicyRequires(policy, membership.role)) return true;
  }
  return false;
}

function setChallenge(key: string, challenge: string) {
  pendingChallenge.set(key, { challenge, expiresAt: Date.now() + 5 * 60 * 1000 });
}

function takeChallenge(key: string): string | null {
  const row = pendingChallenge.get(key);
  pendingChallenge.delete(key);
  if (!row || row.expiresAt < Date.now()) return null;
  return row.challenge;
}

function toBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function fromBase64Url(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64url"));
}

export async function mfaStatus(db: Db, userId: string) {
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  const creds = await db.query.userWebauthnCredentials.findMany({
    where: eq(userWebauthnCredentials.userId, userId),
  });
  const recoveryRows = user?.totpEnabledAt
    ? await db.query.userRecoveryCodes.findMany({
        where: eq(userRecoveryCodes.userId, userId),
      })
    : [];
  return {
    totp: Boolean(user?.totpEnabledAt),
    totpEnabledAt: user?.totpEnabledAt?.toISOString() ?? null,
    webauthn: creds.length > 0,
    methods: [
      ...(user?.totpEnabledAt ? (["totp"] as const) : []),
      ...(creds.length ? (["webauthn"] as const) : []),
    ] as Array<"totp" | "webauthn">,
    recoveryRemaining: recoveryRows.filter((row) => !row.usedAt).length,
    recoveryTotal: recoveryRows.length,
    credentials: creds.map((row) => ({
      id: row.id,
      name: row.name,
      createdAt: row.createdAt.toISOString(),
    })),
  };
}

export function mfaRequired(status: { totp: boolean; webauthn: boolean }): boolean {
  return status.totp || status.webauthn;
}

export async function startTotpSetup(
  db: Db,
  secret: string,
  user: { id: string; email: string; totpEnabledAt?: Date | null },
) {
  if (user.totpEnabledAt) throw new Error("验证器已启用，请先关闭再重新绑定");
  const existing = await db.query.userTotp.findFirst({ where: eq(userTotp.userId, user.id) });
  if (existing?.enabledAt) throw new Error("验证器已启用，请先关闭再重新绑定");
  const totpSecret = new Secret({ size: 20 });
  const totp = new TOTP({
    issuer: "Zakura",
    label: user.email,
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: totpSecret,
  });
  const secretEnc = encryptJson(secret, totpSecret.base32);
  if (existing) {
    await db.update(userTotp).set({ secretEnc, enabledAt: null }).where(eq(userTotp.userId, user.id));
  } else {
    await db.insert(userTotp).values({
      userId: user.id,
      secretEnc,
      enabledAt: null,
      createdAt: new Date(),
    });
  }
  return { secret: totpSecret.base32, otpauthUrl: totp.toString() };
}

export async function cancelTotpSetup(db: Db, userId: string): Promise<void> {
  const row = await db.query.userTotp.findFirst({ where: eq(userTotp.userId, userId) });
  if (!row || row.enabledAt) return;
  await db.delete(userTotp).where(eq(userTotp.userId, userId));
}

export async function enableTotp(db: Db, appSecret: string, userId: string, code: string) {
  const row = await db.query.userTotp.findFirst({ where: eq(userTotp.userId, userId) });
  if (!row) throw new Error("请先开始绑定验证器");
  const base32 = decryptJson<string>(appSecret, row.secretEnc);
  if (!verifyTotpCode(base32, code)) throw new Error("验证码不正确");
  const now = new Date();
  await db.update(userTotp).set({ enabledAt: now }).where(eq(userTotp.userId, userId));
  await db.update(users).set({ totpEnabledAt: now, updatedAt: now }).where(eq(users.id, userId));
  return issueRecoveryCodes(db, userId);
}

/** Verify setup, atomically consume the enrollment ticket, and enable TOTP. */
export async function completeTotpEnrollment(
  db: Db,
  appSecret: string,
  userId: string,
  rawTicket: string,
  code: string,
): Promise<string[]> {
  return db.transaction(async (tx) => {
    const database = transactionDb(tx);
    const row = await database.query.userTotp.findFirst({ where: eq(userTotp.userId, userId) });
    if (!row || row.enabledAt) throw new Error("请先开始绑定验证器");
    const base32 = decryptJson<string>(appSecret, row.secretEnc);
    if (!verifyTotpCode(base32, code)) throw new Error("验证码不正确");
    const consumed = await new CredentialLifecycleService(database).consumeAuth(
      "mfa_enrollment",
      rawTicket,
    );
    if (!consumed?.userId || consumed.userId !== userId) {
      throw new Error("MFA enrollment ticket 无效或已过期");
    }
    const now = new Date();
    await database.update(userTotp).set({ enabledAt: now }).where(eq(userTotp.userId, userId));
    await database.update(users).set({ totpEnabledAt: now, updatedAt: now }).where(eq(users.id, userId));
    return issueRecoveryCodes(database, userId);
  });
}

export async function disableTotp(
  db: Db,
  userId: string,
  appSecret: string,
  input: { code?: string; recoveryCode?: string },
) {
  const totpOk = input.code ? await verifyUserTotp(db, appSecret, userId, input.code) : false;
  const recoveryOk =
    !totpOk && input.recoveryCode ? await consumeRecoveryCode(db, userId, input.recoveryCode) : false;
  if (!totpOk && !recoveryOk) throw new Error("验证码不正确");
  await db.delete(userTotp).where(eq(userTotp.userId, userId));
  await db.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
  await db.update(users).set({ totpEnabledAt: null, updatedAt: new Date() }).where(eq(users.id, userId));
}

export async function regenerateRecoveryCodes(db: Db, appSecret: string, userId: string, code: string) {
  if (!(await verifyUserTotp(db, appSecret, userId, code))) {
    throw new Error("验证码不正确");
  }
  const user = await db.query.users.findFirst({ where: eq(users.id, userId) });
  if (!user?.totpEnabledAt) throw new Error("尚未启用验证器");
  return issueRecoveryCodes(db, userId);
}

export function verifyTotpCode(base32: string, code: string): boolean {
  const totp = new TOTP({
    issuer: "Zakura",
    label: "user",
    algorithm: "SHA1",
    digits: 6,
    period: 30,
    secret: Secret.fromBase32(base32.replace(/\s+/g, "")),
  });
  return totp.validate({ token: code.replace(/\s+/g, ""), window: 1 }) !== null;
}

export async function verifyUserTotp(db: Db, appSecret: string, userId: string, code: string): Promise<boolean> {
  const row = await db.query.userTotp.findFirst({ where: eq(userTotp.userId, userId) });
  if (!row?.enabledAt) return false;
  const base32 = decryptJson<string>(appSecret, row.secretEnc);
  return verifyTotpCode(base32, code);
}

/** 10 位十六进制，写成 xxxxx-xxxxx，方便手抄。 */
export function newRecoveryCode(): string {
  const raw = randomBytes(5).toString("hex");
  return `${raw.slice(0, 5)}-${raw.slice(5)}`;
}

export function normalizeRecoveryCode(code: string): string {
  return code.trim().toLowerCase().replace(/[^a-f0-9]/g, "");
}

async function issueRecoveryCodes(db: Db, userId: string): Promise<string[]> {
  await db.delete(userRecoveryCodes).where(eq(userRecoveryCodes.userId, userId));
  const codes: string[] = [];
  for (let i = 0; i < 8; i++) {
    const code = newRecoveryCode();
    codes.push(code);
    await db.insert(userRecoveryCodes).values({
      id: newId(),
      userId,
      codeHash: hashToken(normalizeRecoveryCode(code)),
      createdAt: new Date(),
    });
  }
  return codes;
}

export async function consumeRecoveryCode(db: Db, userId: string, code: string): Promise<boolean> {
  return new CredentialLifecycleService(db).consumeRecovery(userId, code);
}

export async function beginWebauthnRegistration(
  db: Db,
  webPublicUrl: string,
  user: { id: string; email: string; name?: string | null },
) {
  const rp = rpFromWebUrl(webPublicUrl);
  const existing = await db.query.userWebauthnCredentials.findMany({
    where: eq(userWebauthnCredentials.userId, user.id),
  });
  const options = await generateRegistrationOptions({
    rpName: rp.name,
    rpID: rp.rpID,
    userName: user.email,
    userDisplayName: user.name || user.email,
    userID: new TextEncoder().encode(user.id),
    excludeCredentials: existing.map((row) => ({ id: row.credentialId })),
    authenticatorSelection: { userVerification: "preferred", residentKey: "preferred" },
  });
  setChallenge(`reg:${user.id}`, options.challenge);
  return options;
}

export async function finishWebauthnRegistration(
  db: Db,
  webPublicUrl: string,
  userId: string,
  response: RegistrationResponseJSON,
  name?: string,
) {
  const challenge = takeChallenge(`reg:${userId}`);
  if (!challenge) throw new Error("通行密钥挑战已过期，请重试");
  const rp = rpFromWebUrl(webPublicUrl);
  const verified = await verifyRegistrationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
  });
  if (!verified.verified || !verified.registrationInfo) throw new Error("通行密钥注册失败");
  const cred = verified.registrationInfo.credential;
  await db.insert(userWebauthnCredentials).values({
    id: newId(),
    userId,
    credentialId: cred.id,
    publicKey: toBase64Url(cred.publicKey),
    counter: cred.counter,
    name: name?.trim() || "Passkey",
    transportsJson: JSON.stringify(cred.transports ?? []),
    createdAt: new Date(),
  });
}

export async function beginWebauthnLogin(
  db: Db,
  webPublicUrl: string,
  userId: string,
  challengeKey: string,
) {
  const rp = rpFromWebUrl(webPublicUrl);
  const existing = await db.query.userWebauthnCredentials.findMany({
    where: eq(userWebauthnCredentials.userId, userId),
  });
  if (!existing.length) throw new Error("未绑定通行密钥");
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    allowCredentials: existing.map((row) => ({ id: row.credentialId })),
    userVerification: "preferred",
  });
  setChallenge(challengeKey, options.challenge);
  return options;
}

export async function finishWebauthnLogin(
  db: Db,
  webPublicUrl: string,
  userId: string,
  challengeKey: string,
  response: AuthenticationResponseJSON,
): Promise<boolean> {
  const challenge = takeChallenge(challengeKey);
  if (!challenge) return false;
  const credId = response.id;
  const row = await db.query.userWebauthnCredentials.findFirst({
    where: eq(userWebauthnCredentials.credentialId, credId),
  });
  if (!row || row.userId !== userId) return false;
  const rp = rpFromWebUrl(webPublicUrl);
  const verified = await verifyAuthenticationResponse({
    response,
    expectedChallenge: challenge,
    expectedOrigin: rp.origin,
    expectedRPID: rp.rpID,
    credential: {
      id: row.credentialId,
      publicKey: fromBase64Url(row.publicKey) as Uint8Array<ArrayBuffer>,
      counter: row.counter,
    },
  });
  if (!verified.verified) return false;
  await db
    .update(userWebauthnCredentials)
    .set({ counter: verified.authenticationInfo.newCounter })
    .where(eq(userWebauthnCredentials.id, row.id));
  return true;
}

export async function deleteWebauthnCredential(db: Db, userId: string, credentialRowId: string): Promise<boolean> {
  const rows = await db
    .delete(userWebauthnCredentials)
    .where(and(eq(userWebauthnCredentials.id, credentialRowId), eq(userWebauthnCredentials.userId, userId)))
    .returning();
  return rows.length > 0;
}

export async function renameWebauthnCredential(
  db: Db,
  userId: string,
  credentialRowId: string,
  name: string,
): Promise<boolean> {
  const next = name.trim().slice(0, 40) || "Passkey";
  const rows = await db
    .update(userWebauthnCredentials)
    .set({ name: next })
    .where(and(eq(userWebauthnCredentials.id, credentialRowId), eq(userWebauthnCredentials.userId, userId)))
    .returning();
  return rows.length > 0;
}
