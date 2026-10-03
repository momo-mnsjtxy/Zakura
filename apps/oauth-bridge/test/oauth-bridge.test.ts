import assert from "node:assert/strict";
import test from "node:test";

process.env.NODE_ENV = "test";
process.env.GOOGLE_CLIENT_ID = "fake-client";
const { app } = await import("../src/app.js");

test("DCR rejects unsafe redirect URIs", async () => {
  const response = await app.request("http://bridge/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ redirect_uris: ["http://attacker.example/callback"] }),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error, "invalid_redirect_uri");
});

test("authorize requires downstream PKCE and rejects open redirects", async () => {
  const unsafe = await app.request("http://bridge/authorize?redirect_uri=https%3A%2F%2Fexample.com%2Fcb");
  assert.equal(unsafe.status, 400);
  assert.match(await unsafe.text(), /PKCE/);

  const openRedirect = await app.request(
    "http://bridge/authorize?redirect_uri=http%3A%2F%2Fevil.example%2Fcb&code_challenge=x&code_challenge_method=S256",
  );
  assert.equal(openRedirect.status, 400);
  assert.match(await openRedirect.text(), /invalid redirect_uri/);
});

test("authorize accepts HTTPS callback with S256", async () => {
  const response = await app.request(
    "http://bridge/authorize?redirect_uri=https%3A%2F%2Fclient.example%2Fcb&state=s&code_challenge=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa&code_challenge_method=S256",
  );
  assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location")!);
  assert.equal(location.hostname, "accounts.google.com");
  assert.equal(location.searchParams.get("code_challenge_method"), "S256");
});
