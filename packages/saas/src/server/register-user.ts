import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { randomBytes } from "node:crypto";

/** Tables are injected by the host to keep the SaaS package server-agnostic. */
export type RegisterSchema = {
  users: unknown;
  tenants: unknown;
  tenantMemberships: unknown;
  newId: () => string;
};

type RegistrationInput = {
  email: string;
  password: string;
  name?: string;
  tenantName?: string;
  joinTenant?: { tenantId: string; role: "member" | "admin" };
};

type RegisteredUser = {
  id: string;
  email: string;
  name: string | null;
  isPlatformAdmin?: boolean;
};

type RegisteredTenant = {
  id: string;
  slug: string;
  name: string;
  onboardingCompleted: boolean;
};

type RegisteredMembership = { role: string };

type LooseDb = {
  query: {
    users: { findFirst: (args: unknown) => Promise<Record<string, unknown> | null | undefined> };
    tenants: { findFirst: (args: unknown) => Promise<Record<string, unknown> | null | undefined> };
  };
  transaction: <T>(fn: (tx: LooseDb) => Promise<T>) => Promise<T>;
  insert: (table: unknown) => {
    values: (value: unknown) => { returning: () => Promise<Array<Record<string, unknown>>> };
  };
};

export function slugifyWorkspace(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 48) || `tenant-${Date.now().toString(36)}`
  );
}

export class RegisterError extends Error {
  constructor(
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "RegisterError";
  }
}

function normalizeRegistration(input: RegistrationInput) {
  const email = input.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new RegisterError("Valid email required", 400);
  }
  if (!input.password || input.password.length < 8) {
    throw new RegisterError("Password required (min 8 chars)", 400);
  }
  if (input.password.length > 1024) {
    throw new RegisterError("Password is too long", 400);
  }
  const tenantName = input.tenantName?.trim() || `${email.split("@")[0]}'s workspace`;
  return {
    email,
    name: input.name?.trim() || email.split("@")[0],
    tenantName,
  };
}

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { code?: unknown; cause?: unknown; constraint?: unknown };
  if (value.code === "23505") return true;
  return value.cause !== error && isUniqueViolation(value.cause);
}

/**
 * Atomically registers the global account and its first membership. Email and
 * slug pre-checks are only friendly diagnostics; database constraints remain
 * the concurrency boundary.
 */
export async function registerSaasUser(
  dbUnknown: unknown,
  schema: RegisterSchema,
  input: RegistrationInput,
): Promise<{
  user: RegisteredUser;
  tenant: RegisteredTenant;
  membership: RegisteredMembership;
}> {
  const db = dbUnknown as LooseDb;
  const users = schema.users as { email: unknown };
  const tenants = schema.tenants as { id: unknown; slug: unknown };
  const normalized = normalizeRegistration(input);
  const passwordHash = await bcrypt.hash(input.password, 12);
  const baseSlug = slugifyWorkspace(normalized.tenantName);
  const attempts = input.joinTenant ? 1 : 8;

  for (let attempt = 0; attempt < attempts; attempt++) {
    const slug =
      attempt === 0
        ? baseSlug
        : `${baseSlug.slice(0, 43)}-${randomBytes(2).toString("hex")}`;
    try {
      return await db.transaction(async (tx) => {
        const existing = await tx.query.users.findFirst({
          where: eq(users.email as never, normalized.email),
        });
        if (existing) throw new RegisterError("Email already registered", 409);

        const now = new Date();
        let tenant: Record<string, unknown>;
        if (input.joinTenant) {
          const found = await tx.query.tenants.findFirst({
            where: eq(tenants.id as never, input.joinTenant.tenantId),
          });
          if (!found) throw new RegisterError("加入的团队不存在", 400);
          if (found.suspendedAt) throw new RegisterError("该团队已被封禁", 403);
          tenant = found;
        } else {
          [tenant] = await tx
            .insert(schema.tenants)
            .values({
              id: schema.newId(),
              slug,
              name: normalized.tenantName,
              isDefault: false,
              onboardingCompleted: false,
              onboardingSteps: "{}",
              createdAt: now,
              updatedAt: now,
            })
            .returning();
        }

        let user: Record<string, unknown>;
        [user] = await tx
          .insert(schema.users)
          .values({
            id: schema.newId(),
            email: normalized.email,
            name: normalized.name,
            passwordHash,
            isPlatformAdmin: false,
            canUseLocalRunner: false,
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        let membership: Record<string, unknown>;
        [membership] = await tx
          .insert(schema.tenantMemberships)
          .values({
            id: schema.newId(),
            tenantId: tenant.id,
            userId: user.id,
            role: input.joinTenant?.role ?? "owner",
            status: "active",
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        return {
          user: user as RegisteredUser,
          tenant: tenant as RegisteredTenant,
          membership: membership as RegisteredMembership,
        };
      });
    } catch (error) {
      if (error instanceof RegisterError) throw error;
      if (!isUniqueViolation(error)) throw error;
      // A simultaneous registration for this email must report conflict, not
      // retry it as though only the generated tenant slug collided.
      const existing = await db.query.users.findFirst({
        where: eq(users.email as never, normalized.email),
      });
      if (existing) throw new RegisterError("Email already registered", 409);
      if (attempt === attempts - 1) throw new RegisterError("Workspace slug already exists", 409);
    }
  }
  throw new RegisterError("Could not allocate workspace slug", 409);
}
