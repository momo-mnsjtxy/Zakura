import assert from "node:assert/strict";
import { createSign, generateKeyPairSync, type KeyObject } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import {
  clearJwksCache,
  decodeJwt,
  fetchJwks,
  verifyRs256Jwt,
} from "../src/services/identity/jwt.js";

const issuer = "https://idp.example.test";
const audience = "zakura-client";
const jwksUrl = `${issuer}/jwks`;

function keyPair(kid: string, extra?: Record<string, unknown>) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  return {
    kid,
    privateKey,
    jwk: {
      ...publicKey.export({ format: "jwk" }),
      kid,
      kty: "RSA",
      alg: "RS256",
      use: "sig",
      ...extra,
    },
  };
}

function signJwt(
  privateKey: KeyObject,
  kid: string | undefined,
  claims: Record<string, unknown>,
  header?: Record<string, unknown>,
) {
  const encodedHeader = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", ...(kid ? { kid } : {}), ...header })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(claims)).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${encodedHeader}.${encodedPayload}`);
  signer.end();
  return `${encodedHeader}.${encodedPayload}.${signer.sign(privateKey).toString("base64url")}`;
}

function validClaims(extra?: Record<string, unknown>) {
  const now = Math.floor(Date.now() / 1000);
  return { iss: issuer, aud: audience, sub: "subject", iat: now, exp: now + 300, nonce: "nonce", ...extra };
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  clearJwksCache();
});

describe("enterprise OIDC JWT verification", () => {
  it("coalesces concurrent JWKS fetches and refreshes once for key rotation", async () => {
    const oldKey = keyPair("old");
    const nextKey = keyPair("next");
    let keys = [oldKey.jwk];
    let fetches = 0;
    globalThis.fetch = async () => {
      fetches += 1;
      await new Promise((resolve) => setTimeout(resolve, 5));
      return Response.json({ keys });
    };
    const oldToken = signJwt(oldKey.privateKey, oldKey.kid, validClaims());
    await Promise.all(
      Array.from({ length: 12 }, () =>
        verifyRs256Jwt(oldToken, jwksUrl, { issuer, audience, nonce: "nonce" }),
      ),
    );
    assert.equal(fetches, 1);

    keys = [nextKey.jwk];
    const nextToken = signJwt(nextKey.privateKey, nextKey.kid, validClaims());
    assert.equal(
      (await verifyRs256Jwt(nextToken, jwksUrl, { issuer, audience, nonce: "nonce" })).sub,
      "subject",
    );
    assert.equal(fetches, 2);

    const unknown = signJwt(nextKey.privateKey, "unknown", validClaims());
    await assert.rejects(
      verifyRs256Jwt(unknown, jwksUrl, { issuer, audience, nonce: "nonce" }),
      /匹配的签名密钥/,
    );
  });

  it("requires an unambiguous eligible RSA signing key", async () => {
    const first = keyPair("first");
    const second = keyPair("second");
    globalThis.fetch = async () => Response.json({ keys: [first.jwk, second.jwk] });
    await assert.rejects(
      verifyRs256Jwt(signJwt(first.privateKey, undefined, validClaims()), jwksUrl, {
        issuer,
        audience,
        nonce: "nonce",
      }),
      /明确的 kid/,
    );

    clearJwksCache();
    globalThis.fetch = async () => Response.json({ keys: [{ ...first.jwk, use: "enc" }] });
    await assert.rejects(
      verifyRs256Jwt(signJwt(first.privateKey, first.kid, validClaims()), jwksUrl, {
        issuer,
        audience,
        nonce: "nonce",
      }),
      /匹配的签名密钥/,
    );
  });

  it("enforces issuer, audience, azp, nonce and temporal claims", async () => {
    const signing = keyPair("claims");
    globalThis.fetch = async () => Response.json({ keys: [signing.jwk] });
    const verify = (claims: Record<string, unknown>) =>
      verifyRs256Jwt(signJwt(signing.privateKey, signing.kid, claims), jwksUrl, {
        issuer,
        audience,
        nonce: "nonce",
      });
    await assert.rejects(verify(validClaims({ iss: "https://evil.example" })), /issuer/);
    await assert.rejects(verify(validClaims({ aud: "other" })), /audience/);
    await assert.rejects(verify(validClaims({ aud: [audience, "other"] })), /azp/);
    assert.equal((await verify(validClaims({ aud: [audience, "other"], azp: audience }))).sub, "subject");
    await assert.rejects(verify(validClaims({ nonce: "wrong" })), /nonce/);
    await assert.rejects(verify(validClaims({ nbf: Math.floor(Date.now() / 1000) + 120 })), /尚未生效/);
    await assert.rejects(verify(validClaims({ iat: Math.floor(Date.now() / 1000) + 120 })), /签发时间/);
    await assert.rejects(verify(validClaims({ exp: Math.floor(Date.now() / 1000) - 120 })), /已过期/);
  });

  it("bounds malformed tokens and oversized JWKS responses", async () => {
    assert.equal(decodeJwt("a.b"), null);
    assert.equal(decodeJwt(`a.${"x".repeat(130 * 1024)}.b`), null);
    globalThis.fetch = async () => new Response("x".repeat(1024 * 1024 + 1), { status: 200 });
    await assert.rejects(fetchJwks(jwksUrl), /响应过大/);
  });
});
