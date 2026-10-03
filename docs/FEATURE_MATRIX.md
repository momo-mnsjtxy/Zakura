# Feature parity matrix

Baseline: `210677c58a700dbaf58dbff86350d46fd7b9a3e1`

Status values are checked only when corresponding implementation and tests pass. The generated source inventories below are the required acceptance surface, not optional examples.

## Product capability groups

| Capability | Required behaviors | Evidence gate | Status |
|---|---|---|---|
| Identity and tenancy | Login/register/reset/verify/invites, OAuth/OIDC, SSO, MFA, SCIM, sessions, suspension, audit, tenant isolation | auth, identity, account-status, OAuth and migration suites | Pending |
| Agents and chat | Agent CRUD/config, sessions, paged history/search/fork/pin, streaming, queue/cancel/interrupt/retry, attachments, projects, presence | cloud-agent, agent, platform-events, socket, Yjs suites + browser smoke | Pending |
| Tool safety and interaction | Tool approval, remembered rules, ask-user, ACP permissions/elicitation, timeouts/cancel/default deny | tool-approval, ACP permission/elicitation suites | Pending |
| Models and gateways | OpenAI Responses/chat, Anthropic Messages, compatible adapters, routing weights/retry, SSE normalization, reasoning/media/tools | gateway/router/stream/tool continuation fake-server suites | Pending |
| MCP and skills | stdio/HTTP/OAuth MCP, install/catalog/health/default binding, conformance, skill discovery/cache/source/update | MCP conformance and skill suites | Pending |
| Runtimes and workspaces | Local/container/remote runners, path jail, terminal/process lifecycle, filesystem routing, CDP/desktop, install/update/recovery | runtime/workspace/runner/ACP suites + Go tests | Pending |
| Connectors and channels | Slack, GitHub, GitLab, Jira, Linear, Notion, Google Workspace, M365, Discord, email, Feishu, remote channel commands | provider fake-server suites | Pending |
| Spaces and collaboration | Spaces/members/settings, computers, automation, projects, graph, reactions, file shares, platform services | spaces/graph/reaction/file/platform suites | Pending |
| Operations | PGlite/Postgres migration, Redis event coordination, health/readiness, telemetry, Docker/Caddy deployment, backup/recovery docs | migration/observability/redis + compose checks | Pending |
| SaaS/admin | Onboarding, users/tenants/runners/defaults/platform, usage, audit, enterprise controls | SaaS typecheck/tests and browser smoke | Pending |

## Rewrite and acceptance status

`Rewritten` means production business logic was materially replaced and its focused tests pass. `Preserved` means the pinned implementation remains the parity floor; presence is not rewrite completion. `Gated` means a real external environment or credential is intentionally unavailable.

| Capability | Rewritten and focused-tested | Preserved business scope still requiring migration | Acceptance state |
|---|---|---|---|
| Identity and tenancy | Session validation/revocation/suspension; atomic verification/reset/invite/MFA/recovery claims; auth UI action/recovery state | SSO/OIDC/SCIM provisioning and group sync; full tenant permissions; SaaS admin service internals | Full auth route suite required on each snapshot; real IdP is gated, fake IdP required |
| Agents and chat | Project reconciliation; local/Redis event subscription lifecycle; run cancellation; client history/reconnect/cancel state | Most cloud run/session/message orchestration, durable queue and provider execution business rules | Full cloud-agent/event/socket/Yjs suites plus authenticated create/send/cancel browser flow remain |
| Models and gateways | Retry/cancellation/backoff lifecycle; bounded gateway session cache | Provider adapters, routing/catalog/upstream credential refresh, normalized streaming/tool/media business paths | Fake OpenAI/Anthropic upstream matrix remains |
| MCP and tools | Atomic ask/tool interactions; real route/PGlite races; MCP start/stop coalescing; bounded HTTP cleanup; real fake-stdio/catalog mutation flows | Broader MCP gateway/conformance/capability and skill install/cache/update business logic | Focused real-route tests green; full conformance remains |
| Runtime/workspace | Go RPC family dispatch, jail, OAuth PKCE/state, process/stream/request recovery, archive integrity/atomic import, runtime factory | Remaining Docker/local/remote orchestration and server integration business branches | Go test/vet and focused core suites green; real Docker/remote is gated |
| Connectors/channels | Frontend connection/channel state boundaries | Connector provider auth/refresh/webhook/channel command/reaction business services | Per-provider fake servers remain; live credentials gated |
| Skills/memory | Frontend memory/vector/tool-call state boundaries | Server memory/vector/graph, skill discovery/cache/source/update business services | Real PGlite/fake embedding and skill source tests remain |
| Spaces/operations | Frontend Spaces/computer/automation state; DB/runtime foundations | Server collaboration, network/tunnel, platform services, usage/observability and deployment operations | Local static/route tests remain; live Docker/Headscale/deploy gated |
| Web application | HTTP decoder/session/error/recovery; auth/agents/spaces/models/MCP/memory/admin state boundaries | Remaining pages retain pinned rendering/business composition | Typecheck, production build and fixture browser flows green; broader workflow E2E remains |

The canonical file-level counts are maintained in `REWRITE_COVERAGE.md`. Full acceptance requires no unclassified business module and every Stage 9 gate in `MIGRATION_PLAN.md` to be green.

## Frontend route inventory (92)

- `/chat`
- `/console/oauth/[provider]/callback`
- `/console/oauth/authorize`
- `/console/oauth/mcp-upstream/callback`
- `/console/sso/callback`
- `/console/sso/oidc/callback`
- `/dashboard/admin/agent-defaults`
- `/dashboard/admin/auth`
- `/dashboard/admin`
- `/dashboard/admin/platform`
- `/dashboard/admin/runners`
- `/dashboard/admin/tenants/[id]`
- `/dashboard/admin/tenants`
- `/dashboard/admin/users/[id]`
- `/dashboard/admin/users`
- `/dashboard/agent-connections`
- `/dashboard/agents/[id]/[...rest]`
- `/dashboard/agents/[id]/approvals`
- `/dashboard/agents/[id]/general`
- `/dashboard/agents/[id]/memory`
- `/dashboard/agents/[id]/overview`
- `/dashboard/agents/[id]`
- `/dashboard/agents/[id]/settings`
- `/dashboard/agents/[id]/skills/add`
- `/dashboard/agents/[id]/skills`
- `/dashboard/agents`
- `/dashboard/connections/[id]`
- `/dashboard/connections`
- `/dashboard/connections/store/[id]`
- `/dashboard/connectors/[id]`
- `/dashboard/connectors`
- `/dashboard/keys`
- `/dashboard/mcp/[id]`
- `/dashboard/mcp/import`
- `/dashboard/mcp/official`
- `/dashboard/mcp`
- `/dashboard/mcp/plugins/[slug]`
- `/dashboard/mcp/store`
- `/dashboard/memory`
- `/dashboard/models`
- `/dashboard/models/upstreams`
- `/dashboard/network/active`
- `/dashboard/network/exposure`
- `/dashboard/network/mesh`
- `/dashboard/network`
- `/dashboard/network/security`
- `/dashboard`
- `/dashboard/people/[id]`
- `/dashboard/people`
- `/dashboard/platform-services`
- `/dashboard/policies`
- `/dashboard/runners/[id]`
- `/dashboard/runners`
- `/dashboard/runners/upgrades`
- `/dashboard/settings/account`
- `/dashboard/settings/audit`
- `/dashboard/settings/identity`
- `/dashboard/settings/members`
- `/dashboard/settings/oauth-apps`
- `/dashboard/settings/oauth-clients`
- `/dashboard/settings/team`
- `/dashboard/settings/teams`
- `/dashboard/settings/tenant`
- `/dashboard/settings/tenants`
- `/dashboard/settings/usage/[userId]`
- `/dashboard/settings/usage`
- `/dashboard/skills`
- `/dashboard/spaces/[id]/agents/[agentId]/[[...section]]`
- `/dashboard/spaces/[id]`
- `/dashboard/spaces/[id]/settings/acp`
- `/dashboard/spaces/[id]/settings/automation`
- `/dashboard/spaces/[id]/settings/computer`
- `/dashboard/spaces/[id]/settings/connect`
- `/dashboard/spaces/[id]/settings/gateway`
- `/dashboard/spaces/[id]/settings/mcp`
- `/dashboard/spaces/[id]/settings`
- `/dashboard/spaces/[id]/settings/platforms`
- `/dashboard/spaces/[id]/settings/projects`
- `/dashboard/spaces/[id]/settings/tool-calls`
- `/dashboard/spaces/[id]/settings/web`
- `/dashboard/spaces`
- `/dashboard/tool-calls`
- `/dashboard/web`
- `/forgot-password`
- `/invite/[token]`
- `/login`
- `/onboarding`
- `/`
- `/register`
- `/reset-password`
- `/setup`
- `/verify-email`

## Server HTTP/API inventory (439 routes across 26 direct API modules)

- `acp-routes`
- `agent-fs-routes`
- `automation-routes`
- `cloud-agent-routes`
- `connection-routes`
- `connector-routes`
- `file-share-routes`
- `identity-routes`
- `mcp-oauth-state`
- `mcp-routes`
- `memory-routes`
- `migration-routes`
- `model-router-routes`
- `network-routes`
- `openai-gateway-routes`
- `otel-routes`
- `platform-service-routes`
- `route-helpers`
- `routes`
- `runtime-node-routes`
- `scim-routes`
- `skill-routes`
- `tenant-routes`
- `usage-routes`
- `zakurabot-app-routes`
- `zakurabot-session-routes`

## Provider inventory

- `discord`
- `email`
- `feishu`
- `github`
- `gitlab`
- `google-workspace`
- `jira`
- `linear`
- `microsoft-365`
- `notion`
- `slack`

## Database migration inventory

- `67` ordered SQL migrations, from `0000_new_thunderbird.sql` through `0066_reactions.sql`

## Upstream behavioral test inventory

- Server tests: `139`
- Core tests: `15`
- Shared tests: `16`

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
- `apps/server/test/agent-cdp.test.ts`
- `apps/server/test/agent-desktop-atspi.test.ts`
- `apps/server/test/agent-desktop.test.ts`
- `apps/server/test/agent-duplicate.test.ts`
- `apps/server/test/agent-fs-paths.test.ts`
- `apps/server/test/agent-hooks.test.ts`
- `apps/server/test/agent-mcp-primitives.test.ts`
- `apps/server/test/agent-projects.test.ts`
- `apps/server/test/anthropic-gateway.test.ts`
- `apps/server/test/automation-runs.test.ts`
- `apps/server/test/cloud-agent-config.test.ts`
- `apps/server/test/cloud-agent-multiturn.test.ts`
- `apps/server/test/cloud-agent-queue.test.ts`
- `apps/server/test/cloud-agent-runtime.test.ts`
- `apps/server/test/cloud-agent-seq-lag.test.ts`
- `apps/server/test/cloud-agent-session-search.test.ts`
- `apps/server/test/cloud-agent-session-seq.test.ts`
- `apps/server/test/cloud-agent-ui-history.test.ts`
- `apps/server/test/composer-capabilities.test.ts`
- `apps/server/test/connection-catalog.test.ts`
- `apps/server/test/connection-markets.test.ts`
- `apps/server/test/connection-packages.test.ts`
- `apps/server/test/cred-slots.test.ts`
- `apps/server/test/credential-config.test.ts`
- `apps/server/test/cron-next.test.ts`
- `apps/server/test/db-migrations.test.ts`
- `apps/server/test/delta-publisher.test.ts`
- `apps/server/test/desktop-proxy.test.ts`
- `apps/server/test/desktop-ticket.test.ts`
- `apps/server/test/desktop-url.test.ts`
- `apps/server/test/docker-image-pull-coordination.test.ts`
- `apps/server/test/e2e-spaces-flow.test.ts`
- `apps/server/test/email-provider.test.ts`
- `apps/server/test/file-shares.test.ts`
- `apps/server/test/github-slack-provider.test.ts`
- `apps/server/test/google-cloud-provision.test.ts`
- `apps/server/test/google-workspace-provider.test.ts`
- `apps/server/test/identity-audit.test.ts`
- `apps/server/test/identity-domains.test.ts`
- `apps/server/test/identity-scim.test.ts`
- `apps/server/test/identity-sessions.test.ts`
- `apps/server/test/image-update-checker.test.ts`
- `apps/server/test/instance-runner.test.ts`
- `apps/server/test/instance-tools.test.ts`
- `apps/server/test/integration-catalog.test.ts`
- `apps/server/test/list-events-around.test.ts`
- `apps/server/test/local-runner.test.ts`
- `apps/server/test/mcp-capabilities.test.ts`
- `apps/server/test/mcp-defaults-and-skills.test.ts`
- `apps/server/test/mcp-install-bind-default.test.ts`
- `apps/server/test/mcp-install-prefer.test.ts`
- `apps/server/test/mcp-instance-tools-cache.test.ts`
- `apps/server/test/mcp-oauth-clients.test.ts`
- `apps/server/test/microsoft-365-provider.test.ts`
- `apps/server/test/model-router-retry.test.ts`
- `apps/server/test/model-router.test.ts`
- `apps/server/test/model-stream-adapters.test.ts`
- `apps/server/test/model-upstream-auth.test.ts`
- `apps/server/test/no-local-fallback.test.ts`
- `apps/server/test/oauth-cimd.test.ts`
- `apps/server/test/oauth-login-flow.test.ts`
- `apps/server/test/oauth-oidc-scopes.test.ts`
- `apps/server/test/oauth-private-key-jwt.test.ts`
- `apps/server/test/oauth-rest-connectors.test.ts`
- `apps/server/test/oauth-signing.test.ts`
- `apps/server/test/observability.test.ts`
- `apps/server/test/openai-gateway.test.ts`
- `apps/server/test/openai-tool-continuation.test.ts`
- `apps/server/test/openai-tools.test.ts`
- `apps/server/test/otel-ingest.test.ts`
- `apps/server/test/peer-tools.test.ts`
- `apps/server/test/platform-assistant-tools.test.ts`
- `apps/server/test/platform-events-cross-instance.test.ts`
- `apps/server/test/platform-events.test.ts`
- `apps/server/test/platform-lifecycle.test.ts`
- `apps/server/test/platform-services.test.ts`
- `apps/server/test/presence.test.ts`
- `apps/server/test/project-config.test.ts`
- `apps/server/test/redis-keys.test.ts`
- `apps/server/test/remote-agent-ingress.test.ts`
- `apps/server/test/remote-channel-commands.test.ts`
- `apps/server/test/remote-channel-tools.test.ts`
- `apps/server/test/runner-update-routes.test.ts`
- `apps/server/test/runner-updates.test.ts`
- `apps/server/test/runtime-node-connectivity.test.ts`
- `apps/server/test/runtime-node-delete.test.ts`
- `apps/server/test/skills-auto-update.test.ts`
- `apps/server/test/skills-cache.test.ts`
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
- `packages/core/test/docker-endpoint.test.ts`
- `packages/core/test/docker-path.test.ts`
- `packages/core/test/host-path-mapping.test.ts`
- `packages/core/test/image-update-check.test.ts`
- `packages/core/test/image-update-probe.test.ts`
- `packages/core/test/local-fs.test.ts`
- `packages/core/test/migration-archive.test.ts`
- `packages/core/test/observability.test.ts`
- `packages/core/test/path-jail.test.ts`
- `packages/core/test/projects.test.ts`
- `packages/core/test/runner-pull-progress.test.ts`
- `packages/core/test/runner-update.test.ts`
- `packages/core/test/shell-job.test.ts`
- `packages/core/test/stdio-exec.test.ts`
- `packages/core/test/workspace-container.test.ts`
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
