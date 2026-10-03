import { createServer } from "node:http";

let enrollmentStartAttempts = 0;

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
    if (body.email === "enroll@example.test") {
      response.end(JSON.stringify({
        mfaEnrollmentRequired: true,
        mfaEnrollmentTicket: "fixture-enrollment-ticket",
        methods: ["totp"],
        code: "mfa_enrollment_required",
      }));
      return;
    }
    response.end(JSON.stringify({ session: "fixture-session" }));
    return;
  }
  if (pathname === "/api/auth/mfa/enrollment/totp/start" && request.method === "POST") {
    if (body.ticket !== "fixture-enrollment-ticket") {
      response.statusCode = 410;
      response.end(JSON.stringify({ error: "Enrollment ticket expired", code: "ticket_expired" }));
      return;
    }
    enrollmentStartAttempts += 1;
    if (enrollmentStartAttempts === 1) {
      response.statusCode = 503;
      response.end(JSON.stringify({ error: "Authenticator setup temporarily unavailable" }));
      return;
    }
    response.end(JSON.stringify({
      secret: "JBSWY3DPEHPK3PXP",
      qrCodeDataUrl: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='160' height='160'%3E%3Crect width='160' height='160' fill='white'/%3E%3Cpath d='M10 10h60v60H10zM90 10h60v60H90zM10 90h60v60H10z' fill='black'/%3E%3C/svg%3E",
    }));
    return;
  }
  if (pathname === "/api/auth/mfa/enrollment/totp/complete" && request.method === "POST") {
    if (body.ticket !== "fixture-enrollment-ticket" || body.code !== "123456") {
      response.statusCode = 400;
      response.end(JSON.stringify({ error: "Invalid enrollment code", code: "invalid_code" }));
      return;
    }
    response.end(JSON.stringify({
      session: "fixture-enrollment-session",
      recoveryCodes: ["RECOVERY-ONE", "RECOVERY-TWO"],
      tenant: { onboardingCompleted: true },
    }));
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
