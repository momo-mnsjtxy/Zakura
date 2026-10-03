import { serve } from "@hono/node-server";
import { app, bridgeRuntimeInfo } from "./app.js";

const info = bridgeRuntimeInfo();
process.stdout.write(
  `${JSON.stringify({
    ts: new Date().toISOString(),
    level: "info",
    service: "oauth-bridge",
    event: "process.ready",
    bind_port: info.port,
    google_configured: info.googleConfigured,
  })}\n`,
);
serve({ fetch: app.fetch, port: info.port, hostname: "0.0.0.0" });
