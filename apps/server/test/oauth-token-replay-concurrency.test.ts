import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { isNull } from "drizzle-orm";
import type { AppConfig } from "../src/config.js";
import type { Db } from "../src/db/client.js";
import {
  newId,
  oauthRefreshTokens,
  tenantMemberships,
  tenants,
  users,
} from "../src/db/schema.js";
import { createOauthApp } from "../src/oauth/http.js";
import { OauthService } from "../src/services/oauth.js";

const REDIRECT_URI = "http://localhost:8081/oauth/callback";

function s256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

describe("OAuth token replay concurrency", () => {
  let dataDir = "";
  let close: (() => Promise<void>) | undefined;
  let db: Db;
  let oauth: OauthService;
  let app: ReturnType<typeof createOauthApp>;
  let tenantId = "";
  let userId = "";

  before(async () => {
    dataDir = mkdtempSync(join(tmpdir(), "zakura-oauth-replay-"));
    const databaseUrl = `pglite:${join(dataDir, "db")}`;
    const { runMigrations } = await import("../src/db/migrate.js");
    await runMigrations(databaseUrl);
    const created = await (await import("../src/db/client.js")).createDb({
      databaseUrl,
      dataDir,
    });
    db = created.db;
    close = created.close;

    const config = {
      dataDir,
      databaseUrl,
      secret: "oauth-token-replay-test-secret",
      publicBaseUrl: "https://zakura.example",
      webPublicUrl: "http://localhost:3001",
    } as AppConfig;
    oauth = new OauthService(db, config);
    app = createOauthApp({ db, config, oauth });

    tenantId = newId();
    userId = newId();
    await db.insert(tenants).values({ id: tenantId, name: "Replay tenant", slug: tenantId });
    await db.insert(users).values({ id: userId, email: `${userId}@example.test` });
    await db.insert(tenantMemberships).values({
      tenantId,
      userId,
      role: "owner",
      status: "active",
    });
  });

  after(async () => {
    await close?.();
    rmSync(dataDir, { recursive: true, force: true });
  });

  async function postToken(path: "/token" | "/oauth/token", body: URLSearchParams) {
    return app.request(`https://zakura.example${path}`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  }

  it("atomically consumes authorization codes and rotating refresh tokens", async () => {
    const registration = await app.request("https://zakura.example/oauth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "Concurrent exchange client",
        redirect_uris: [REDIRECT_URI],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        scope: "api offline_access",
      }),
    });
    assert.equal(registration.status, 201, await registration.clone().text());
    const { client_id: clientId } = await registration.json() as { client_id: string };

    const verifier = randomBytes(32).toString("base64url");
    const { code } = await oauth.consent({
      userId,
      tenantId,
      clientId,
      redirectUri: REDIRECT_URI,
      codeChallenge: s256(verifier),
      codeChallengeMethod: "S256",
      scope: "api offline_access",
    });
    const codeRequest = () => new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      code,
      redirect_uri: REDIRECT_URI,
      code_verifier: verifier,
    });

    const codeResponses = await Promise.all([
      postToken("/token", codeRequest()),
      postToken("/oauth/token", codeRequest()),
    ]);
    assert.deepEqual(
      codeResponses.map((response) => response.status).sort((a, b) => a - b),
      [200, 400],
      "only one concurrent authorization-code exchange may succeed",
    );
    const codeSuccess = codeResponses.find((response) => response.status === 200)!;
    const codeReplay = codeResponses.find((response) => response.status === 400)!;
    assert.equal((await codeReplay.json() as { error: string }).error, "invalid_grant");
    const initialTokens = await codeSuccess.json() as {
      access_token: string;
      refresh_token: string;
    };
    assert.ok(initialTokens.access_token);
    assert.ok(initialTokens.refresh_token);

    const refreshRequest = () => new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      refresh_token: initialTokens.refresh_token,
    });
    const refreshResponses = await Promise.all([
      postToken("/oauth/token", refreshRequest()),
      postToken("/token", refreshRequest()),
    ]);
    assert.deepEqual(
      refreshResponses.map((response) => response.status).sort((a, b) => a - b),
      [200, 400],
      "only one concurrent refresh-token rotation may succeed",
    );
    const refreshSuccess = refreshResponses.find((response) => response.status === 200)!;
    const refreshReplay = refreshResponses.find((response) => response.status === 400)!;
    assert.equal((await refreshReplay.json() as { error: string }).error, "invalid_grant");
    const rotatedTokens = await refreshSuccess.json() as {
      access_token: string;
      refresh_token: string;
    };
    assert.ok(rotatedTokens.access_token);
    assert.notEqual(rotatedTokens.refresh_token, initialTokens.refresh_token);
    assert.ok(await oauth.authenticateBearer(rotatedTokens.access_token));

    const rows = await db.select().from(oauthRefreshTokens);
    assert.equal(rows.length, 2, "one authorization exchange and one rotation mint two rows");
    const activeRows = await db
      .select()
      .from(oauthRefreshTokens)
      .where(isNull(oauthRefreshTokens.revokedAt));
    assert.equal(activeRows.length, 1, "the token family has exactly one active refresh token");

    const replayAfterRotation = await postToken("/oauth/token", refreshRequest());
    assert.equal(replayAfterRotation.status, 400);
    assert.equal((await replayAfterRotation.json() as { error: string }).error, "invalid_grant");
  });
});
