# Preserved compatibility manifest

Baseline: `210677c58a700dbaf58dbff86350d46fd7b9a3e1`.

This generated ledger lists every baseline-identical file in the rewritten tree. Identical files are preserved deliberately for compatibility; they are not counted as rewritten. Tests, migrations, static assets and protocol data are separated from production implementation so carried-over logic remains visible.

## `apps/server`

### Production compatibility implementation (176)

- `apps/server/drizzle.config.ts`
- `apps/server/scripts/build-stdio-bridge.mjs`
- `apps/server/scripts/diag-boot.mjs`
- `apps/server/scripts/diag-db-host.mjs`
- `apps/server/scripts/diag-pg-cancel.mjs`
- `apps/server/scripts/diag-pg-fresh.mjs`
- `apps/server/scripts/diag-pg-locks.mjs`
- `apps/server/scripts/diag-pg-ping.mjs`
- `apps/server/scripts/diag-pg-write.mjs`
- `apps/server/scripts/e2e-zakurabot.mjs`
- `apps/server/scripts/run-mcp-conformance.ts`
- `apps/server/scripts/test-oci-only.ts`
- `apps/server/scripts/test-stdio-direct.ts`
- `apps/server/src/api/acp-routes.ts`
- `apps/server/src/api/connection-routes.ts`
- `apps/server/src/api/connector-routes.ts`
- `apps/server/src/api/file-share-routes.ts`
- `apps/server/src/api/mcp-oauth-state.ts`
- `apps/server/src/api/mcp-routes.ts`
- `apps/server/src/api/migration-routes.ts`
- `apps/server/src/api/otel-routes.ts`
- `apps/server/src/api/route-helpers.ts`
- `apps/server/src/api/runtime-node-routes.ts`
- `apps/server/src/api/tenant-routes.ts`
- `apps/server/src/api/zakurabot-app-routes.ts`
- `apps/server/src/api/zakurabot-session-routes.ts`
- `apps/server/src/capabilities/cred-slots.ts`
- `apps/server/src/capabilities/web-fetch/backends.ts`
- `apps/server/src/capabilities/web-fetch/index.ts`
- `apps/server/src/capabilities/web-fetch/types.ts`
- `apps/server/src/capabilities/web-search/engines.ts`
- `apps/server/src/capabilities/web-search/index.ts`
- `apps/server/src/capabilities/web-search/types.ts`
- `apps/server/src/config.ts`
- `apps/server/src/db/pglite.ts`
- `apps/server/src/emails/account-layout.tsx`
- `apps/server/src/emails/crisis-support.tsx`
- `apps/server/src/emails/invite.tsx`
- `apps/server/src/emails/reset-password.tsx`
- `apps/server/src/emails/verify-email.tsx`
- `apps/server/src/lib/mcp-config-parse.ts`
- `apps/server/src/lib/mcp-install-parse.ts`
- `apps/server/src/load-env.ts`
- `apps/server/src/mcp/agent-capabilities.ts`
- `apps/server/src/mcp/http.ts`
- `apps/server/src/mcp/instructions.ts`
- `apps/server/src/mcp/stdio-bridge.ts`
- `apps/server/src/model-router/adapter.ts`
- `apps/server/src/model-router/adapters/codex.ts`
- `apps/server/src/model-router/adapters/cursor.ts`
- `apps/server/src/model-router/adapters/index.ts`
- `apps/server/src/model-router/cache.ts`
- `apps/server/src/model-router/index.ts`
- `apps/server/src/model-router/media.ts`
- `apps/server/src/model-router/messages.ts`
- `apps/server/src/model-router/oauth-hook.ts`
- `apps/server/src/model-router/openai-tools.ts`
- `apps/server/src/model-router/reasoning.ts`
- `apps/server/src/model-router/registry.ts`
- `apps/server/src/model-router/resolver.ts`
- `apps/server/src/model-router/strategy.ts`
- `apps/server/src/model-router/types.ts`
- `apps/server/src/oauth/http.ts`
- `apps/server/src/platform-services/catalog.ts`
- `apps/server/src/platform-services/lifecycle.ts`
- `apps/server/src/providers/browser-notifications.ts`
- `apps/server/src/providers/credential-config.ts`
- `apps/server/src/providers/discord/index.ts`
- `apps/server/src/providers/generic-mcp.ts`
- `apps/server/src/providers/gitlab/index.ts`
- `apps/server/src/providers/google-workspace/calendar.ts`
- `apps/server/src/providers/google-workspace/chat.ts`
- `apps/server/src/providers/google-workspace/drive.ts`
- `apps/server/src/providers/google-workspace/gmail.ts`
- `apps/server/src/providers/google-workspace/people.ts`
- `apps/server/src/providers/google-workspace/tool-permissions.ts`
- `apps/server/src/providers/google-workspace/types.ts`
- `apps/server/src/providers/index.ts`
- `apps/server/src/providers/notion/index.ts`
- `apps/server/src/providers/openviking.ts`
- `apps/server/src/providers/remote-agent.ts`
- `apps/server/src/providers/stdio-mcp.ts`
- `apps/server/src/providers/web-fetch.ts`
- `apps/server/src/providers/web-search.ts`
- `apps/server/src/realtime/presence.ts`
- `apps/server/src/realtime/socket-gateway.ts`
- `apps/server/src/realtime/yjs-sync.ts`
- `apps/server/src/saas-loader.ts`
- `apps/server/src/services/acp/client-handlers.ts`
- `apps/server/src/services/acp/codex-device.ts`
- `apps/server/src/services/acp/config.ts`
- `apps/server/src/services/acp/events.ts`
- `apps/server/src/services/acp/install-progress.ts`
- `apps/server/src/services/acp/permissions.ts`
- `apps/server/src/services/acp/provisioner.ts`
- `apps/server/src/services/acp/registry.ts`
- `apps/server/src/services/acp/session.ts`
- `apps/server/src/services/agent-binaries.ts`
- `apps/server/src/services/agent-caps.ts`
- `apps/server/src/services/agent-mcp-primitives.ts`
- `apps/server/src/services/agent-screenshot.ts`
- `apps/server/src/services/bootstrap.ts`
- `apps/server/src/services/capabilities.ts`
- `apps/server/src/services/cloud-agent/acp-tools.ts`
- `apps/server/src/services/cloud-agent/ask-user-tools.ts`
- `apps/server/src/services/cloud-agent/composer-capabilities.ts`
- `apps/server/src/services/cloud-agent/crisis-support-tools.ts`
- `apps/server/src/services/cloud-agent/messages.ts`
- `apps/server/src/services/cloud-agent/peer-tools.ts`
- `apps/server/src/services/cloud-agent/prompts.ts`
- `apps/server/src/services/cloud-agent/tools.ts`
- `apps/server/src/services/cloud-agent-runtime.ts`
- `apps/server/src/services/connection-catalog.ts`
- `apps/server/src/services/connection-packages.ts`
- `apps/server/src/services/cron-next.ts`
- `apps/server/src/services/desktop-ticket.ts`
- `apps/server/src/services/email-connector-instances.ts`
- `apps/server/src/services/embedding-client.ts`
- `apps/server/src/services/host-tailscale.ts`
- `apps/server/src/services/identity/cleanup.ts`
- `apps/server/src/services/identity/mail.ts`
- `apps/server/src/services/identity/throttle.ts`
- `apps/server/src/services/instance-tool-permissions.ts`
- `apps/server/src/services/integration-catalog.ts`
- `apps/server/src/services/mcp-oauth-clients.ts`
- `apps/server/src/services/memory-embed.ts`
- `apps/server/src/services/memory-runtime.ts`
- `apps/server/src/services/model-upstream-auth/index.ts`
- `apps/server/src/services/model-upstream-auth/providers/claude-code.ts`
- `apps/server/src/services/model-upstream-auth/providers/codex.ts`
- `apps/server/src/services/model-upstream-auth/providers/cursor.ts`
- `apps/server/src/services/model-upstream-auth/providers/gemini-cli.ts`
- `apps/server/src/services/model-upstream-auth/providers/grok.ts`
- `apps/server/src/services/model-upstream-auth/remote-models.ts`
- `apps/server/src/services/model-upstream-auth/tokens.ts`
- `apps/server/src/services/model-upstream-auth/types.ts`
- `apps/server/src/services/network-audit.ts`
- `apps/server/src/services/network-security.ts`
- `apps/server/src/services/network-settings.ts`
- `apps/server/src/services/oauth-cimd.ts`
- `apps/server/src/services/oauth-private-key-jwt.ts`
- `apps/server/src/services/oauth-signing.ts`
- `apps/server/src/services/oauth.ts`
- `apps/server/src/services/onboarding-bootstrap.ts`
- `apps/server/src/services/platform-headscale.ts`
- `apps/server/src/services/platform-transactional-email.ts`
- `apps/server/src/services/project-config.ts`
- `apps/server/src/services/redis-store.ts`
- `apps/server/src/services/redis.ts`
- `apps/server/src/services/remote-channel-commands.ts`
- `apps/server/src/services/remote-channel-stream.ts`
- `apps/server/src/services/runner-hub.ts`
- `apps/server/src/services/runner-updates.ts`
- `apps/server/src/services/runtime-nodes.ts`
- `apps/server/src/services/skills/builtin.ts`
- `apps/server/src/services/skills/discover.ts`
- `apps/server/src/services/skills/index.ts`
- `apps/server/src/services/skills/source.ts`
- `apps/server/src/services/skills/store.ts`
- `apps/server/src/services/skills/tools.ts`
- `apps/server/src/services/space-config.ts`
- `apps/server/src/services/space-progress.ts`
- `apps/server/src/services/store-catalog.ts`
- `apps/server/src/services/transactional-email.ts`
- `apps/server/src/services/user-usage.ts`
- `apps/server/src/services/workspace-readiness.ts`
- `apps/server/src/services/workspace-tcp-tunnel.ts`
- `apps/server/src/services/zakurabot-adapter.ts`
- `apps/server/src/services/zakurabot-channel.ts`
- `apps/server/src/services/zakurabot-files.ts`
- `apps/server/src/services/zakurabot-gateway.ts`
- `apps/server/src/services/zakurabot-interactions.ts`
- `apps/server/src/services/zakurabot-protocol.ts`
- `apps/server/src/services/zakurabot-store.ts`
- `apps/server/src/tunnel/cloudflare-quick.ts`
- `apps/server/src/tunnel/tailscale-serve.ts`

### Tests and fixtures (118)

- `apps/server/test/account-status.test.ts`
- `apps/server/test/acp-adapter-identity.test.ts`
- `apps/server/test/acp-auth.test.ts`
- `apps/server/test/acp-config.test.ts`
- `apps/server/test/acp-container-home.test.ts`
- `apps/server/test/acp-container-install.test.ts`
- `apps/server/test/acp-container-rebuild.test.ts`
- `apps/server/test/acp-container-status.test.ts`
- `apps/server/test/acp-curated-lookup.test.ts`
- `apps/server/test/acp-device.test.ts`
- `apps/server/test/acp-elicitation.test.ts`
- `apps/server/test/acp-events.test.ts`
- `apps/server/test/acp-fx-install.test.ts`
- `apps/server/test/acp-internal-base-url.test.ts`
- `apps/server/test/acp-login-shell.test.ts`
- `apps/server/test/acp-mcp-gateway.test.ts`
- `apps/server/test/acp-permissions.test.ts`
- `apps/server/test/acp-registry-refresh.test.ts`
- `apps/server/test/acp-remote-install-progress.test.ts`
- `apps/server/test/acp-runtime-status.test.ts`
- `apps/server/test/acp-spawn.test.ts`
- `apps/server/test/acp-storage.test.ts`
- `apps/server/test/agent-avatar.test.ts`
- `apps/server/test/agent-binaries.test.ts`
- `apps/server/test/agent-cdp-chromium.test.ts`
- `apps/server/test/agent-desktop-atspi.test.ts`
- `apps/server/test/agent-fs-paths.test.ts`
- `apps/server/test/agent-mcp-primitives.test.ts`
- `apps/server/test/agent-projects.test.ts`
- `apps/server/test/cloud-agent-config.test.ts`
- `apps/server/test/cloud-agent-multiturn.test.ts`
- `apps/server/test/cloud-agent-runtime.test.ts`
- `apps/server/test/cloud-agent-seq-lag.test.ts`
- `apps/server/test/cloud-agent-session-seq.test.ts`
- `apps/server/test/composer-capabilities.test.ts`
- `apps/server/test/connection-catalog.test.ts`
- `apps/server/test/connection-markets.test.ts`
- `apps/server/test/connection-packages.test.ts`
- `apps/server/test/cred-slots.test.ts`
- `apps/server/test/credential-config.test.ts`
- `apps/server/test/cron-next.test.ts`
- `apps/server/test/db-migrations.test.ts`
- `apps/server/test/delta-publisher.test.ts`
- `apps/server/test/desktop-ticket.test.ts`
- `apps/server/test/desktop-url.test.ts`
- `apps/server/test/docker-image-pull-coordination.test.ts`
- `apps/server/test/email-provider.test.ts`
- `apps/server/test/file-shares.test.ts`
- `apps/server/test/github-slack-provider.test.ts`
- `apps/server/test/google-cloud-provision.test.ts`
- `apps/server/test/google-workspace-provider.test.ts`
- `apps/server/test/helpers/desktop-a11y-fixture.py`
- `apps/server/test/helpers/png.ts`
- `apps/server/test/helpers/spaces.ts`
- `apps/server/test/helpers/zakurabot.ts`
- `apps/server/test/identity-scim.test.ts`
- `apps/server/test/identity-sessions.test.ts`
- `apps/server/test/instance-runner.test.ts`
- `apps/server/test/instance-tools.test.ts`
- `apps/server/test/integration-catalog.test.ts`
- `apps/server/test/list-events-around.test.ts`
- `apps/server/test/mcp-capabilities.test.ts`
- `apps/server/test/mcp-defaults-and-skills.test.ts`
- `apps/server/test/mcp-install-bind-default.test.ts`
- `apps/server/test/mcp-install-prefer.test.ts`
- `apps/server/test/mcp-instance-tools-cache.test.ts`
- `apps/server/test/mcp-oauth-clients.test.ts`
- `apps/server/test/microsoft-365-provider.test.ts`
- `apps/server/test/model-router.test.ts`
- `apps/server/test/no-local-fallback.test.ts`
- `apps/server/test/oauth-cimd.test.ts`
- `apps/server/test/oauth-login-flow.test.ts`
- `apps/server/test/oauth-oidc-scopes.test.ts`
- `apps/server/test/oauth-private-key-jwt.test.ts`
- `apps/server/test/oauth-rest-connectors.test.ts`
- `apps/server/test/oauth-signing.test.ts`
- `apps/server/test/openai-tools.test.ts`
- `apps/server/test/otel-ingest.test.ts`
- `apps/server/test/peer-tools.test.ts`
- `apps/server/test/platform-events-cross-instance.test.ts`
- `apps/server/test/platform-lifecycle.test.ts`
- `apps/server/test/platform-services.test.ts`
- `apps/server/test/presence.test.ts`
- `apps/server/test/project-config.test.ts`
- `apps/server/test/redis-keys.test.ts`
- `apps/server/test/remote-channel-commands.test.ts`
- `apps/server/test/remote-channel-tools.test.ts`
- `apps/server/test/runner-update-routes.test.ts`
- `apps/server/test/runner-updates.test.ts`
- `apps/server/test/runtime-node-connectivity.test.ts`
- `apps/server/test/runtime-node-delete.test.ts`
- `apps/server/test/skills-auto-update.test.ts`
- `apps/server/test/skills-discover.test.ts`
- `apps/server/test/skills-source.test.ts`
- `apps/server/test/socket-gateway.test.ts`
- `apps/server/test/space-graph.test.ts`
- `apps/server/test/spaces-api.test.ts`
- `apps/server/test/spaces.test.ts`
- `apps/server/test/stdio-runtime-node.test.ts`
- `apps/server/test/tool-approval.test.ts`
- `apps/server/test/transactional-email.test.ts`
- `apps/server/test/user-avatar.test.ts`
- `apps/server/test/user-profile.test.ts`
- `apps/server/test/user-usage.test.ts`
- `apps/server/test/workspace-cdp.test.ts`
- `apps/server/test/workspace-ensure-started.test.ts`
- `apps/server/test/workspace-fs-routing.test.ts`
- `apps/server/test/yjs-sync.test.ts`
- `apps/server/test/zakurabot-app.test.ts`
- `apps/server/test/zakurabot-channel.test.ts`
- `apps/server/test/zakurabot-desktop.test.ts`
- `apps/server/test/zakurabot-exec.test.ts`
- `apps/server/test/zakurabot-history-pagination.test.ts`
- `apps/server/test/zakurabot-interactions.test.ts`
- `apps/server/test/zakurabot-protocol.test.ts`
- `apps/server/test/zakurabot-reactions.test.ts`
- `apps/server/test/zakurabot-sessions.test.ts`
- `apps/server/test/zakurabot-user.test.ts`

### Migrations, schema and generated metadata (75)

- `apps/server/drizzle/0000_new_thunderbird.sql`
- `apps/server/drizzle/0001_thin_risque.sql`
- `apps/server/drizzle/0002_far_lily_hollister.sql`
- `apps/server/drizzle/0003_steady_metal_master.sql`
- `apps/server/drizzle/0004_petite_prism.sql`
- `apps/server/drizzle/0005_mysterious_vanisher.sql`
- `apps/server/drizzle/0006_many_baron_strucker.sql`
- `apps/server/drizzle/0007_lame_jackal.sql`
- `apps/server/drizzle/0008_agent_opt_in_defaults.sql`
- `apps/server/drizzle/0009_memory_providers.sql`
- `apps/server/drizzle/0010_memory_embeddings.sql`
- `apps/server/drizzle/0011_runtime_nodes.sql`
- `apps/server/drizzle/0012_network_tunnel.sql`
- `apps/server/drizzle/0013_tenant_onboarding.sql`
- `apps/server/drizzle/0014_tenant_isolation_hardening.sql`
- `apps/server/drizzle/0015_accounts_memberships.sql`
- `apps/server/drizzle/0016_oauth_login.sql`
- `apps/server/drizzle/0017_runner_access.sql`
- `apps/server/drizzle/0018_model_router.sql`
- `apps/server/drizzle/0019_model_catalog_weight.sql`
- `apps/server/drizzle/0020_upstream_models.sql`
- `apps/server/drizzle/0021_cloud_agent.sql`
- `apps/server/drizzle/0022_cloud_agent_session_kind.sql`
- `apps/server/drizzle/0023_file_shares.sql`
- `apps/server/drizzle/0024_platform_services.sql`
- `apps/server/drizzle/0025_agent_skills.sql`
- `apps/server/drizzle/0026_session_search_trgm.sql`
- `apps/server/drizzle/0027_platform_skill_cache.sql`
- `apps/server/drizzle/0028_cloud_agent_session_preferences.sql`
- `apps/server/drizzle/0029_agent_web_defaults.sql`
- `apps/server/drizzle/0030_integration_catalog.sql`
- `apps/server/drizzle/0031_mcp_store_sources.sql`
- `apps/server/drizzle/0032_mcp_health_scheduler.sql`
- `apps/server/drizzle/0033_instance_runtime_node.sql`
- `apps/server/drizzle/0034_store_catalog.sql`
- `apps/server/drizzle/0035_skill_auto_update.sql`
- `apps/server/drizzle/0036_upstream_oauth_clients.sql`
- `apps/server/drizzle/0037_connector_auth_profiles.sql`
- `apps/server/drizzle/0038_agent_remote_channels.sql`
- `apps/server/drizzle/0039_email_connector_instances.sql`
- `apps/server/drizzle/0040_remove_upstream_model_enabled.sql`
- `apps/server/drizzle/0041_agent_channel_binding_credentials.sql`
- `apps/server/drizzle/0042_agent_automation.sql`
- `apps/server/drizzle/0043_agent_connector_installations.sql`
- `apps/server/drizzle/0044_account_suspension.sql`
- `apps/server/drizzle/0045_user_usage.sql`
- `apps/server/drizzle/0046_agent_projects.sql`
- `apps/server/drizzle/0047_user_auth_timestamps.sql`
- `apps/server/drizzle/0048_account_enterprise.sql`
- `apps/server/drizzle/0049_agent_project_records.sql`
- `apps/server/drizzle/0050_user_avatar.sql`
- `apps/server/drizzle/0051_user_profile.sql`
- `apps/server/drizzle/0052_routines_ask_user.sql`
- `apps/server/drizzle/0053_go_agent_runtime.sql`
- `apps/server/drizzle/0054_restore_local_runtime.sql`
- `apps/server/drizzle/0055_zakurabot_channel.sql`
- `apps/server/drizzle/0056_zakurabot_authorization.sql`
- `apps/server/drizzle/0057_zakurabot_app.sql`
- `apps/server/drizzle/0058_zakurabot_interactions.sql`
- `apps/server/drizzle/0059_zakurabot_trusted.sql`
- `apps/server/drizzle/0060_tool_approvals.sql`
- `apps/server/drizzle/0061_zakurabot_oauth_user.sql`
- `apps/server/drizzle/0062_spaces.sql`
- `apps/server/drizzle/0063_space_settings.sql`
- `apps/server/drizzle/0064_space_computer.sql`
- `apps/server/drizzle/0065_agent_avatar.sql`
- `apps/server/drizzle/0066_reactions.sql`
- `apps/server/drizzle/meta/0000_snapshot.json`
- `apps/server/drizzle/meta/0001_snapshot.json`
- `apps/server/drizzle/meta/0002_snapshot.json`
- `apps/server/drizzle/meta/0003_snapshot.json`
- `apps/server/drizzle/meta/0004_snapshot.json`
- `apps/server/drizzle/meta/0005_snapshot.json`
- `apps/server/drizzle/meta/0006_snapshot.json`
- `apps/server/drizzle/meta/0007_snapshot.json`

### Static assets, manifests and build metadata (2)

- `apps/server/src/catalog/integration-packages.json`
- `apps/server/tsconfig.json`

## `packages/saas`

### Production compatibility implementation (3)

- `packages/saas/src/index.ts`
- `packages/saas/src/server/oauth-login.selfcheck.mjs`
- `packages/saas/src/server/oauth-zerocat.ts`

### Tests and fixtures (0)

- None

### Migrations, schema and generated metadata (0)

- None

### Static assets, manifests and build metadata (4)

- `packages/saas/README.md`
- `packages/saas/package.json`
- `packages/saas/strip-manifest.json`
- `packages/saas/tsconfig.json`

## `apps/web`

### Production compatibility implementation (221)

- `apps/web/next-env.d.ts`
- `apps/web/next.config.mjs`
- `apps/web/postcss.config.mjs`
- `apps/web/public/browserconfig.xml`
- `apps/web/public/sw.js`
- `apps/web/src/app/chat/page.tsx`
- `apps/web/src/app/console/oauth/authorize/authorize-client.tsx`
- `apps/web/src/app/console/oauth/authorize/page.tsx`
- `apps/web/src/app/console/oauth/mcp-upstream/callback/page.tsx`
- `apps/web/src/app/dashboard/admin/auth/page.tsx`
- `apps/web/src/app/dashboard/admin/layout.tsx`
- `apps/web/src/app/dashboard/admin/page.tsx`
- `apps/web/src/app/dashboard/admin/platform/page.tsx`
- `apps/web/src/app/dashboard/admin/runners/page.tsx`
- `apps/web/src/app/dashboard/admin/tenants/[id]/page.tsx`
- `apps/web/src/app/dashboard/admin/tenants/page.tsx`
- `apps/web/src/app/dashboard/admin/users/[id]/page.tsx`
- `apps/web/src/app/dashboard/agent-connections/page.tsx`
- `apps/web/src/app/dashboard/agents/[id]/[...rest]/page.tsx`
- `apps/web/src/app/dashboard/agents/[id]/approvals/page.tsx`
- `apps/web/src/app/dashboard/agents/[id]/general/page.tsx`
- `apps/web/src/app/dashboard/agents/[id]/layout.tsx`
- `apps/web/src/app/dashboard/agents/[id]/overview/page.tsx`
- `apps/web/src/app/dashboard/agents/[id]/page.tsx`
- `apps/web/src/app/dashboard/agents/[id]/skills/add/page.tsx`
- `apps/web/src/app/dashboard/agents/[id]/skills/page.tsx`
- `apps/web/src/app/dashboard/connections/[id]/page.tsx`
- `apps/web/src/app/dashboard/connections/store/[id]/page.tsx`
- `apps/web/src/app/dashboard/connectors/[id]/page.tsx`
- `apps/web/src/app/dashboard/connectors/page.tsx`
- `apps/web/src/app/dashboard/layout.tsx`
- `apps/web/src/app/dashboard/mcp/[id]/page.tsx`
- `apps/web/src/app/dashboard/mcp/import/page.tsx`
- `apps/web/src/app/dashboard/mcp/official/page.tsx`
- `apps/web/src/app/dashboard/mcp/page.tsx`
- `apps/web/src/app/dashboard/mcp/plugins/[slug]/page.tsx`
- `apps/web/src/app/dashboard/mcp/store/page.tsx`
- `apps/web/src/app/dashboard/models/layout.tsx`
- `apps/web/src/app/dashboard/network/layout.tsx`
- `apps/web/src/app/dashboard/page.tsx`
- `apps/web/src/app/dashboard/people/[id]/page.tsx`
- `apps/web/src/app/dashboard/people/page.tsx`
- `apps/web/src/app/dashboard/settings/members/page.tsx`
- `apps/web/src/app/dashboard/settings/oauth-apps/page.tsx`
- `apps/web/src/app/dashboard/settings/teams/page.tsx`
- `apps/web/src/app/dashboard/settings/tenant/page.tsx`
- `apps/web/src/app/dashboard/settings/usage/[userId]/page.tsx`
- `apps/web/src/app/dashboard/settings/usage/page.tsx`
- `apps/web/src/app/dashboard/skills/page.tsx`
- `apps/web/src/app/dashboard/spaces/[id]/agents/[agentId]/[[...section]]/page.tsx`
- `apps/web/src/app/dashboard/spaces/[id]/agents/[agentId]/layout.tsx`
- `apps/web/src/app/dashboard/spaces/[id]/settings/acp/page.tsx`
- `apps/web/src/app/dashboard/spaces/[id]/settings/connect/page.tsx`
- `apps/web/src/app/dashboard/spaces/[id]/settings/gateway/page.tsx`
- `apps/web/src/app/dashboard/spaces/[id]/settings/layout.tsx`
- `apps/web/src/app/dashboard/spaces/[id]/settings/page.tsx`
- `apps/web/src/app/dashboard/spaces/[id]/settings/platforms/page.tsx`
- `apps/web/src/app/dashboard/spaces/[id]/settings/projects/page.tsx`
- `apps/web/src/app/dashboard/spaces/[id]/settings/tool-calls/page.tsx`
- `apps/web/src/app/dashboard/spaces/[id]/settings/web/page.tsx`
- `apps/web/src/app/dashboard/tool-calls/page.tsx`
- `apps/web/src/app/dashboard/web/page.tsx`
- `apps/web/src/app/error.tsx`
- `apps/web/src/app/layout.tsx`
- `apps/web/src/app/manifest.ts`
- `apps/web/src/app/setup/page.tsx`
- `apps/web/src/components/account/recovery-codes.tsx`
- `apps/web/src/components/account/totp-dialogs.tsx`
- `apps/web/src/components/admin/suspend-dialog.tsx`
- `apps/web/src/components/agent-connect-panel.tsx`
- `apps/web/src/components/agent-files/file-manager.tsx`
- `apps/web/src/components/agent-target-picker.tsx`
- `apps/web/src/components/auth-screen.tsx`
- `apps/web/src/components/brand-icon.tsx`
- `apps/web/src/components/brand-mark.tsx`
- `apps/web/src/components/chat/answer-sources.tsx`
- `apps/web/src/components/chat/automation-panel.tsx`
- `apps/web/src/components/chat/chat-helpers.ts`
- `apps/web/src/components/chat/chat-project-row.tsx`
- `apps/web/src/components/chat/chat-session-row.tsx`
- `apps/web/src/components/chat/chat-settings-sheet.tsx`
- `apps/web/src/components/chat/composer-plus-menu.tsx`
- `apps/web/src/components/chat/composer.tsx`
- `apps/web/src/components/chat/context-window.tsx`
- `apps/web/src/components/chat/file-panel.tsx`
- `apps/web/src/components/chat/message-navigator.tsx`
- `apps/web/src/components/chat/message-queue.tsx`
- `apps/web/src/components/chat/model-picker.tsx`
- `apps/web/src/components/chat/presence-avatars.tsx`
- `apps/web/src/components/chat/project-config-panel.tsx`
- `apps/web/src/components/chat/project-pane.tsx`
- `apps/web/src/components/chat/run-log-drawer.tsx`
- `apps/web/src/components/chat/runtime-icon.tsx`
- `apps/web/src/components/chat/session-context-bar.tsx`
- `apps/web/src/components/chat/session-search-dialog.tsx`
- `apps/web/src/components/chat/slash-command-picker.tsx`
- `apps/web/src/components/chat/tool-activity.tsx`
- `apps/web/src/components/chat/web-sources.tsx`
- `apps/web/src/components/connections/connector-oauth-form.tsx`
- `apps/web/src/components/connections/platform-assistant-sheet.tsx`
- `apps/web/src/components/connections/platform-connector-provision.tsx`
- `apps/web/src/components/connections/store-panel.tsx`
- `apps/web/src/components/connector-browser-notifications.tsx`
- `apps/web/src/components/embedding-config-fields.tsx`
- `apps/web/src/components/markdown/chat-markdown.tsx`
- `apps/web/src/components/markdown/markstream-setup.ts`
- `apps/web/src/components/mcp/capability-explorers.tsx`
- `apps/web/src/components/mcp/google-cloud-provision-panel.tsx`
- `apps/web/src/components/mcp/import-panel.tsx`
- `apps/web/src/components/mcp/install-dialog.tsx`
- `apps/web/src/components/mcp/install-flow.tsx`
- `apps/web/src/components/mcp/official-store-panel.tsx`
- `apps/web/src/components/mcp/schema-tool-form.tsx`
- `apps/web/src/components/mcp/server-card.tsx`
- `apps/web/src/components/mcp/store-panel.tsx`
- `apps/web/src/components/mcp/tool-permissions-panel.tsx`
- `apps/web/src/components/me-context.tsx`
- `apps/web/src/components/models/model-route-selector.tsx`
- `apps/web/src/components/models/upstream-auth-panel.tsx`
- `apps/web/src/components/models/upstream-model-setup.tsx`
- `apps/web/src/components/navigation-progress.tsx`
- `apps/web/src/components/network-subnav.tsx`
- `apps/web/src/components/oauth-provider-icon.tsx`
- `apps/web/src/components/onboarding/step-agent-connect.tsx`
- `apps/web/src/components/onboarding/step-ai-provider.tsx`
- `apps/web/src/components/onboarding/step-mcp-setup.tsx`
- `apps/web/src/components/onboarding/step-profile-name.tsx`
- `apps/web/src/components/onboarding/step-ready.tsx`
- `apps/web/src/components/otel-provider.tsx`
- `apps/web/src/components/pwa-register.tsx`
- `apps/web/src/components/runner-install-panel.tsx`
- `apps/web/src/components/settings-shell.tsx`
- `apps/web/src/components/skills/platform-skill-token-panel.tsx`
- `apps/web/src/components/skills/skill-card.tsx`
- `apps/web/src/components/skills/skill-install-dialog.tsx`
- `apps/web/src/components/skills/skill-markdown.tsx`
- `apps/web/src/components/skills/skill-registry-panel.tsx`
- `apps/web/src/components/skills/skill-store-panel.tsx`
- `apps/web/src/components/space-settings-layout.tsx`
- `apps/web/src/components/tailscale-mesh-dialog.tsx`
- `apps/web/src/components/tailscale-mesh-panel.tsx`
- `apps/web/src/components/theme-provider.tsx`
- `apps/web/src/components/theme-toggle.tsx`
- `apps/web/src/components/ui/alert.tsx`
- `apps/web/src/components/ui/avatar.tsx`
- `apps/web/src/components/ui/badge.tsx`
- `apps/web/src/components/ui/button.tsx`
- `apps/web/src/components/ui/card.tsx`
- `apps/web/src/components/ui/checkbox.tsx`
- `apps/web/src/components/ui/collapsible.tsx`
- `apps/web/src/components/ui/confirm-dialog.tsx`
- `apps/web/src/components/ui/data-table.tsx`
- `apps/web/src/components/ui/dialog.tsx`
- `apps/web/src/components/ui/disclosure.tsx`
- `apps/web/src/components/ui/dropdown-menu.tsx`
- `apps/web/src/components/ui/empty.tsx`
- `apps/web/src/components/ui/fluid-hover-highlight.tsx`
- `apps/web/src/components/ui/fluid-hover.tsx`
- `apps/web/src/components/ui/input.tsx`
- `apps/web/src/components/ui/label.tsx`
- `apps/web/src/components/ui/popover.tsx`
- `apps/web/src/components/ui/progress-linear.tsx`
- `apps/web/src/components/ui/radio-group.tsx`
- `apps/web/src/components/ui/scroll-area.tsx`
- `apps/web/src/components/ui/search-field.tsx`
- `apps/web/src/components/ui/searchable-select.tsx`
- `apps/web/src/components/ui/select.tsx`
- `apps/web/src/components/ui/separator.tsx`
- `apps/web/src/components/ui/sheet.tsx`
- `apps/web/src/components/ui/sidebar.tsx`
- `apps/web/src/components/ui/skeleton.tsx`
- `apps/web/src/components/ui/sonner.tsx`
- `apps/web/src/components/ui/switch.tsx`
- `apps/web/src/components/ui/table.tsx`
- `apps/web/src/components/ui/tabs.tsx`
- `apps/web/src/components/ui/textarea.tsx`
- `apps/web/src/components/ui/tooltip.tsx`
- `apps/web/src/components/usage/user-usage-panel.tsx`
- `apps/web/src/components/user-avatar.tsx`
- `apps/web/src/components/workspace-desktop.tsx`
- `apps/web/src/components/workspace-image-upgrade-dialog.tsx`
- `apps/web/src/components/workspace-terminal-dialog.tsx`
- `apps/web/src/hooks/use-auto-save.ts`
- `apps/web/src/hooks/use-fluid-hover.ts`
- `apps/web/src/hooks/use-fuzzy-search.ts`
- `apps/web/src/hooks/use-mobile.ts`
- `apps/web/src/hooks/use-paged-list.ts`
- `apps/web/src/hooks/use-stick-to-bottom.ts`
- `apps/web/src/lib/acp.ts`
- `apps/web/src/lib/admin.ts`
- `apps/web/src/lib/agent-fs.ts`
- `apps/web/src/lib/agents.ts`
- `apps/web/src/lib/automation.ts`
- `apps/web/src/lib/browser-notifications.ts`
- `apps/web/src/lib/cloud-agent.ts`
- `apps/web/src/lib/composer-slash.ts`
- `apps/web/src/lib/connections.ts`
- `apps/web/src/lib/device-from-ua.ts`
- `apps/web/src/lib/empty-module.js`
- `apps/web/src/lib/font-weight.ts`
- `apps/web/src/lib/format.ts`
- `apps/web/src/lib/mcp-config.ts`
- `apps/web/src/lib/nav.ts`
- `apps/web/src/lib/network.ts`
- `apps/web/src/lib/otel.ts`
- `apps/web/src/lib/people.ts`
- `apps/web/src/lib/pick-nearest.ts`
- `apps/web/src/lib/qr.tsx`
- `apps/web/src/lib/runners.ts`
- `apps/web/src/lib/skills.ts`
- `apps/web/src/lib/space-subnav.ts`
- `apps/web/src/lib/spaces.ts`
- `apps/web/src/lib/springs.ts`
- `apps/web/src/lib/sync/bytes.ts`
- `apps/web/src/lib/sync/presence.ts`
- `apps/web/src/lib/sync/session-doc.ts`
- `apps/web/src/lib/tool-result.ts`
- `apps/web/src/lib/user-usage.ts`
- `apps/web/src/lib/utils.ts`
- `apps/web/src/lib/workspace-socket-url.ts`
- `apps/web/src/types/novnc.d.ts`

### Tests and fixtures (3)

- `apps/web/src/lib/composer-slash.test.ts`
- `apps/web/src/lib/pick-nearest.test.ts`
- `apps/web/src/lib/runners.test.ts`

### Migrations, schema and generated metadata (0)

- None

### Static assets, manifests and build metadata (12)

- `apps/web/components.json`
- `apps/web/public/apple-touch-icon.png`
- `apps/web/public/favicon-16x16.png`
- `apps/web/public/favicon-32x32.png`
- `apps/web/public/favicon.ico`
- `apps/web/public/icons/icon-1024.png`
- `apps/web/public/icons/icon-192.png`
- `apps/web/public/icons/icon-512.png`
- `apps/web/public/icons/icon-maskable-192.png`
- `apps/web/public/icons/icon-maskable-512.png`
- `apps/web/public/wterm.wasm`
- `apps/web/src/app/globals.css`

## `packages/core`

### Production compatibility implementation (14)

- `packages/core/src/crypto.ts`
- `packages/core/src/docker-endpoint.ts`
- `packages/core/src/docker-path.ts`
- `packages/core/src/observability/context.ts`
- `packages/core/src/observability/http.ts`
- `packages/core/src/observability/ids.ts`
- `packages/core/src/observability/log.ts`
- `packages/core/src/observability/otlp.ts`
- `packages/core/src/observability/redact.ts`
- `packages/core/src/path-jail.ts`
- `packages/core/src/provider.ts`
- `packages/core/src/registry.ts`
- `packages/core/src/runner-token.ts`
- `packages/core/src/workspace-fs.ts`

### Tests and fixtures (13)

- `packages/core/test/docker-endpoint.test.ts`
- `packages/core/test/docker-path.test.ts`
- `packages/core/test/host-path-mapping.test.ts`
- `packages/core/test/image-update-check.test.ts`
- `packages/core/test/image-update-probe.test.ts`
- `packages/core/test/local-fs.test.ts`
- `packages/core/test/observability.test.ts`
- `packages/core/test/path-jail.test.ts`
- `packages/core/test/projects.test.ts`
- `packages/core/test/runner-pull-progress.test.ts`
- `packages/core/test/runner-update.test.ts`
- `packages/core/test/shell-job.test.ts`
- `packages/core/test/workspace-container.test.ts`

### Migrations, schema and generated metadata (0)

- None

### Static assets, manifests and build metadata (2)

- `packages/core/package.json`
- `packages/core/tsconfig.json`

## `go`

### Production compatibility implementation (32)

- `go/agent/cmd/zakura-agent/main.go`
- `go/agent/cmd/zakura-agent/service_unix.go`
- `go/agent/cmd/zakura-agent/service_windows.go`
- `go/agent/install/install.ps1`
- `go/agent/install/install.sh`
- `go/agent/internal/dial/dial_test.go`
- `go/agent/internal/docker/docker_test.go`
- `go/agent/internal/docker/pull_test.go`
- `go/agent/internal/docker/pull_unix.go`
- `go/agent/internal/docker/pull_windows.go`
- `go/agent/internal/docker/recreate_test.go`
- `go/agent/internal/host/docker_exec.go`
- `go/agent/internal/host/jail_test.go`
- `go/agent/internal/host/pty_unix.go`
- `go/agent/internal/host/pty_windows.go`
- `go/agent/internal/rpc/codec.go`
- `go/agent/internal/rpc/codec_test.go`
- `go/agent/internal/rpc/pull_test.go`
- `go/agent/internal/sys/disk_unix.go`
- `go/agent/internal/sys/disk_windows.go`
- `go/agent/internal/sys/info.go`
- `go/agent/internal/sys/paths.go`
- `go/agent/internal/sys/paths_test.go`
- `go/agent/internal/sys/priv_unix.go`
- `go/agent/internal/sys/priv_windows.go`
- `go/agent/internal/sys/update.go`
- `go/agent/internal/sys/update_integration_test.go`
- `go/agent/internal/sys/update_test.go`
- `go/agent/internal/sys/update_unix.go`
- `go/agent/internal/sys/update_windows.go`
- `go/agent/internal/sys/windows_update_script.go`
- `go/agent/scripts/pack.sh`

### Tests and fixtures (0)

- None

### Migrations, schema and generated metadata (0)

- None

### Static assets, manifests and build metadata (3)

- `go/agent/.goreleaser.yaml`
- `go/agent/go.mod`
- `go/agent/go.sum`

## `apps/oauth-bridge`

### Production compatibility implementation (0)

- None

### Tests and fixtures (0)

- None

### Migrations, schema and generated metadata (0)

- None

### Static assets, manifests and build metadata (1)

- `apps/oauth-bridge/tsconfig.json`

## `mcps`

### Production compatibility implementation (0)

- None

### Tests and fixtures (0)

- None

### Migrations, schema and generated metadata (0)

- None

### Static assets, manifests and build metadata (128)

- `mcps/github/tools/actions_get.json`
- `mcps/github/tools/actions_list.json`
- `mcps/github/tools/actions_run_trigger.json`
- `mcps/github/tools/add_comment_to_pending_review.json`
- `mcps/github/tools/add_issue_comment.json`
- `mcps/github/tools/add_reply_to_pull_request_comment.json`
- `mcps/github/tools/check_dependency_vulnerabilities.json`
- `mcps/github/tools/create_branch.json`
- `mcps/github/tools/create_gist.json`
- `mcps/github/tools/create_or_update_file.json`
- `mcps/github/tools/create_pull_request.json`
- `mcps/github/tools/create_repository.json`
- `mcps/github/tools/delete_file.json`
- `mcps/github/tools/discussion_comment_write.json`
- `mcps/github/tools/dismiss_notification.json`
- `mcps/github/tools/fork_repository.json`
- `mcps/github/tools/get_code_quality_finding.json`
- `mcps/github/tools/get_code_scanning_alert.json`
- `mcps/github/tools/get_commit.json`
- `mcps/github/tools/get_copilot_space.json`
- `mcps/github/tools/get_dependabot_alert.json`
- `mcps/github/tools/get_discussion.json`
- `mcps/github/tools/get_discussion_comments.json`
- `mcps/github/tools/get_file_contents.json`
- `mcps/github/tools/get_gist.json`
- `mcps/github/tools/get_global_security_advisory.json`
- `mcps/github/tools/get_job_logs.json`
- `mcps/github/tools/get_label.json`
- `mcps/github/tools/get_latest_release.json`
- `mcps/github/tools/get_me.json`
- `mcps/github/tools/get_notification_details.json`
- `mcps/github/tools/get_release_by_tag.json`
- `mcps/github/tools/get_repository_tree.json`
- `mcps/github/tools/get_secret_scanning_alert.json`
- `mcps/github/tools/get_tag.json`
- `mcps/github/tools/get_team_members.json`
- `mcps/github/tools/get_teams.json`
- `mcps/github/tools/github_support_docs_search.json`
- `mcps/github/tools/issue_read.json`
- `mcps/github/tools/issue_write.json`
- `mcps/github/tools/label_write.json`
- `mcps/github/tools/list_branches.json`
- `mcps/github/tools/list_code_scanning_alerts.json`
- `mcps/github/tools/list_commits.json`
- `mcps/github/tools/list_copilot_spaces.json`
- `mcps/github/tools/list_dependabot_alerts.json`
- `mcps/github/tools/list_discussion_categories.json`
- `mcps/github/tools/list_discussions.json`
- `mcps/github/tools/list_gists.json`
- `mcps/github/tools/list_global_security_advisories.json`
- `mcps/github/tools/list_issue_fields.json`
- `mcps/github/tools/list_issue_types.json`
- `mcps/github/tools/list_issues.json`
- `mcps/github/tools/list_label.json`
- `mcps/github/tools/list_notifications.json`
- `mcps/github/tools/list_org_repository_security_advisories.json`
- `mcps/github/tools/list_pull_requests.json`
- `mcps/github/tools/list_releases.json`
- `mcps/github/tools/list_repository_collaborators.json`
- `mcps/github/tools/list_repository_security_advisories.json`
- `mcps/github/tools/list_secret_scanning_alerts.json`
- `mcps/github/tools/list_starred_repositories.json`
- `mcps/github/tools/list_tags.json`
- `mcps/github/tools/manage_notification_subscription.json`
- `mcps/github/tools/manage_repository_notification_subscription.json`
- `mcps/github/tools/mark_all_notifications_read.json`
- `mcps/github/tools/merge_pull_request.json`
- `mcps/github/tools/projects_get.json`
- `mcps/github/tools/projects_list.json`
- `mcps/github/tools/projects_write.json`
- `mcps/github/tools/pull_request_read.json`
- `mcps/github/tools/pull_request_review_write.json`
- `mcps/github/tools/push_files.json`
- `mcps/github/tools/request_copilot_review.json`
- `mcps/github/tools/run_secret_scanning.json`
- `mcps/github/tools/search_code.json`
- `mcps/github/tools/search_commits.json`
- `mcps/github/tools/search_issues.json`
- `mcps/github/tools/search_orgs.json`
- `mcps/github/tools/search_pull_requests.json`
- `mcps/github/tools/search_repositories.json`
- `mcps/github/tools/search_users.json`
- `mcps/github/tools/semantic_issue_similarity_search.json`
- `mcps/github/tools/semantic_issues_search.json`
- `mcps/github/tools/star_repository.json`
- `mcps/github/tools/sub_issue_write.json`
- `mcps/github/tools/triage_issue.json`
- `mcps/github/tools/unstar_repository.json`
- `mcps/github/tools/update_gist.json`
- `mcps/github/tools/update_pull_request.json`
- `mcps/github/tools/update_pull_request_branch.json`
- `mcps/shadcn/tools/get_add_command_for_items.json`
- `mcps/shadcn/tools/get_audit_checklist.json`
- `mcps/shadcn/tools/get_item_examples_from_registries.json`
- `mcps/shadcn/tools/get_project_registries.json`
- `mcps/shadcn/tools/list_items_in_registries.json`
- `mcps/shadcn/tools/search_items_in_registries.json`
- `mcps/shadcn/tools/view_items_in_registries.json`
- `mcps/tasks/tools/create.json`
- `mcps/tasks/tools/delete.json`
- `mcps/tasks/tools/get_results.json`
- `mcps/tasks/tools/list.json`
- `mcps/tasks/tools/pause.json`
- `mcps/tasks/tools/update.json`
- `mcps/vercel/tools/add_toolbar_reaction.json`
- `mcps/vercel/tools/change_toolbar_thread_resolve_status.json`
- `mcps/vercel/tools/check_domain_availability_and_price.json`
- `mcps/vercel/tools/deploy_to_vercel.json`
- `mcps/vercel/tools/edit_toolbar_message.json`
- `mcps/vercel/tools/get_access_to_vercel_url.json`
- `mcps/vercel/tools/get_agent_run.json`
- `mcps/vercel/tools/get_agent_run_trace.json`
- `mcps/vercel/tools/get_deployment.json`
- `mcps/vercel/tools/get_deployment_build_logs.json`
- `mcps/vercel/tools/get_project.json`
- `mcps/vercel/tools/get_runtime_errors.json`
- `mcps/vercel/tools/get_runtime_logs.json`
- `mcps/vercel/tools/get_toolbar_thread.json`
- `mcps/vercel/tools/import-claude-design-from-url.json`
- `mcps/vercel/tools/list_agent_run_projects.json`
- `mcps/vercel/tools/list_agent_runs.json`
- `mcps/vercel/tools/list_deployments.json`
- `mcps/vercel/tools/list_projects.json`
- `mcps/vercel/tools/list_teams.json`
- `mcps/vercel/tools/list_toolbar_threads.json`
- `mcps/vercel/tools/reply_to_toolbar_thread.json`
- `mcps/vercel/tools/search_vercel_documentation.json`
- `mcps/vercel/tools/web_fetch_vercel_url.json`

## `packages/shared`

### Production compatibility implementation (35)

- `packages/shared/src/acp-provision.ts`
- `packages/shared/src/acp-registry-client.ts`
- `packages/shared/src/acp-registry-snapshot.ts`
- `packages/shared/src/acp-registry.ts`
- `packages/shared/src/acp-sources.ts`
- `packages/shared/src/acp-storage.ts`
- `packages/shared/src/acp.ts`
- `packages/shared/src/agent-hooks.ts`
- `packages/shared/src/cloud-agent.ts`
- `packages/shared/src/connections.ts`
- `packages/shared/src/connector-auth.ts`
- `packages/shared/src/context-accounting.ts`
- `packages/shared/src/curated-mcp.ts`
- `packages/shared/src/docker-pull.ts`
- `packages/shared/src/identicon.ts`
- `packages/shared/src/image-updates.ts`
- `packages/shared/src/index.ts`
- `packages/shared/src/markets.ts`
- `packages/shared/src/mcp-config.ts`
- `packages/shared/src/mcp-oauth.ts`
- `packages/shared/src/mcp-resource-prompt.ts`
- `packages/shared/src/mcp-tool-descriptor.ts`
- `packages/shared/src/model-router.ts`
- `packages/shared/src/network.ts`
- `packages/shared/src/presence.ts`
- `packages/shared/src/projects.ts`
- `packages/shared/src/pty-text.ts`
- `packages/shared/src/routine.ts`
- `packages/shared/src/runner-update.ts`
- `packages/shared/src/runner.ts`
- `packages/shared/src/skills.ts`
- `packages/shared/src/store-package.ts`
- `packages/shared/src/text-diff.ts`
- `packages/shared/src/tool-approval.ts`
- `packages/shared/src/user-usage.ts`

### Tests and fixtures (16)

- `packages/shared/test/acp-fast-agent-env.test.ts`
- `packages/shared/test/acp-fx-launch.test.ts`
- `packages/shared/test/acp-integration-metadata.test.ts`
- `packages/shared/test/acp-launch-matrix.test.ts`
- `packages/shared/test/acp-login-boot.test.ts`
- `packages/shared/test/acp-prompt-blocks.test.ts`
- `packages/shared/test/acp-provision.test.ts`
- `packages/shared/test/acp-registry-client.test.ts`
- `packages/shared/test/acp-registry.test.ts`
- `packages/shared/test/go-agent-install.test.ts`
- `packages/shared/test/identicon.test.ts`
- `packages/shared/test/mcp-tool-descriptor.test.ts`
- `packages/shared/test/presence.test.ts`
- `packages/shared/test/routine-listener.test.ts`
- `packages/shared/test/text-diff.test.ts`
- `packages/shared/test/tool-approval.test.ts`

### Migrations, schema and generated metadata (0)

- None

### Static assets, manifests and build metadata (2)

- `packages/shared/package.json`
- `packages/shared/tsconfig.json`

