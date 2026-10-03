import { createServer } from "node:http";

const server = createServer(async (request, response) => {
  const pathname = new URL(request.url ?? "/", "http://fixture").pathname.replace(/\/$/, "") || "/";
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};

  response.setHeader("content-type", "application/json; charset=utf-8");
  if (pathname === "/api/platform") {
    response.end(JSON.stringify({
      edition: "oss",
      passwordLoginEnabled: true,
      registrationEnabled: true,
      oauthProviders: [],
    }));
    return;
  }
  if (pathname === "/api/auth/sso/discover" && request.method === "POST") {
    response.end(JSON.stringify({ sso: false, echoedEmail: body.email }));
    return;
  }
  if (pathname === "/api/auth/login" && request.method === "POST") {
    response.end(JSON.stringify({ session: "fixture-session" }));
    return;
  }
  if (pathname === "/api/tenant/current") {
    response.end(JSON.stringify({ onboardingCompleted: true }));
    return;
  }
  if (pathname === "/api/me") {
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
  if (pathname === "/api/agents" || pathname === "/api/spaces") {
    response.end("[]");
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: "fixture route not found" }));
});

server.listen(8787, "127.0.0.1", () => {
  process.stdout.write("fake-api-ready\n");
});
