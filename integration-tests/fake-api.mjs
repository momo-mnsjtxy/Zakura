import { createServer } from "node:http";

const server = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};

  response.setHeader("content-type", "application/json; charset=utf-8");
  if (request.url === "/api/platform") {
    response.end(JSON.stringify({
      edition: "oss",
      passwordLoginEnabled: true,
      registrationEnabled: true,
      oauthProviders: [],
    }));
    return;
  }
  if (request.url === "/api/auth/sso/discover" && request.method === "POST") {
    response.end(JSON.stringify({ sso: false, echoedEmail: body.email }));
    return;
  }
  if (request.url === "/api/auth/login" && request.method === "POST") {
    response.end(JSON.stringify({ session: "fixture-session" }));
    return;
  }
  if (request.url === "/api/tenant/current") {
    response.end(JSON.stringify({ onboardingCompleted: true }));
    return;
  }
  if (request.url === "/api/me") {
    response.end(JSON.stringify({
      user: { id: "fixture-user", name: "Fixture Member", email: "member@example.test" },
      tenant: { id: "fixture-tenant", name: "Fixture Team", onboardingCompleted: true },
      role: "owner",
      edition: "oss",
      multiTenant: false,
      canUseLocalRunner: true,
    }));
    return;
  }
  if (request.url === "/api/agents" || request.url === "/api/spaces") {
    response.end("[]");
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "fixture route not found" }));
});

server.listen(8787, "127.0.0.1", () => {
  process.stdout.write("fake-api-ready\n");
});
