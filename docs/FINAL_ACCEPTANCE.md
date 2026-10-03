# Zakura rewrite acceptance report

## Scope and provenance

- Upstream: `Moonrend/Zakura`
- Pinned baseline: `210677c58a700dbaf58dbff86350d46fd7b9a3e1`
- License and attribution: AGPL-3.0 and original author/package metadata preserved
- Validation fork: `momo-mnsjtxy/Zakura`
- Isolated branch: `ci/zakura-rewrite-validation`
- Upstream/default branch: unchanged; no merge or deployment performed

The rewrite preserves every baseline file and public contract while replacing business and lifecycle logic in coherent modules. Static assets, schemas, ordered migrations, protocol descriptors, public type contracts, platform compatibility shims and already-correct covered adapters remain intentionally byte-identical. They are listed path-by-path in `PRESERVED_MANIFEST.md` and are not counted as rewritten.

## Implemented and verified capability groups

1. Identity and tenancy: password/OAuth/OIDC/SAML, SCIM, MFA policy/challenge/enrollment, verification/reset/invites, tenant/domain/RBAC/owner invariants, sessions, suspension and cache invalidation, rotating JWKS/JWT validation, audit export/retention, SaaS administration
2. Agent and chat: durable sessions/runs/events, cross-replica queue CAS, cancel/interrupt/recovery, tool-result ordering, Spaces/workspaces, projects/shares, automation/heartbeats, tenant drains, CDP/desktop/proxy lifecycle, session search/history, tool audit and post-run memory routing
3. Models and gateways: weighted route retry/failover, partial-output rollback, cancellation, OpenAI Chat/Responses, Anthropic, Gemini, Bailian, Codex, Cursor and TypeSafe adapters, reasoning/media/tool continuation, gateway keys/sessions, catalog/default transitions, credential refresh/cache invalidation and OAuth client lifecycle
4. MCP, skills and memory: stdio/HTTP JSON-RPC lifecycle, catalog/install/health, skill source/cache/install rollback and tenant token isolation, memory/vector/graph invariants, encrypted external-provider secrets, tenant-safe bounded task proxies and per-hop validated upstream OAuth
5. Runtime and workspace: Go RPC dispatch/path jail, dial reconnect/drain, Docker command/recreate rollback, host exec/filesystem/stream lifecycle, runner request/stream/archive/workspace/process recovery, atomic local file mutation, cancellable image probing, telemetry shutdown/health/metrics and OAuth bridge PKCE/state
6. Connectors and channels: all inventoried providers through deterministic fake transports, bounded retry/cancel, refresh isolation, webhook/remote-channel lifecycle, retry-safe email inbound delivery, tenant cleanup outbox and live fan-out/reconciliation
7. Spaces and operations: workspace/project/share lifecycle, network exposure teardown, fake Headscale/Tailscale/Cloudflare control planes, platform service quota/lifecycle/diagnostics, instance migration compensation, default MCP reconciliation, Google provisioning lifecycle and bounded image/market/progress services
8. Web application: session/error/recovery, every session-issuance MFA path, chat state, agents/Spaces/models/connectors/memory/admin/network/runner/platform/access-governance controllers, audit truncation handling, interrupted/repeated-action recovery and desktop/mobile visual acceptance

The exact HTTP inventory is in `ROUTE_ACCEPTANCE.md`; the capability-level matrix and evidence are in `FEATURE_MATRIX.md`.

## Acceptance evidence

- Full workspace typecheck, unit/integration tests and production builds on GitHub-hosted runners
- Full server suite serially with a real Redis service and fresh PGlite migrations
- Go `test ./...` and `vet ./...`; focused race coverage for dial/host executor lifecycles
- Real PGlite/Hono workflows for identity, SaaS, sessions, automation, model routes/gateway keys, OAuth clients, MCP catalog/tasks, connectors, migration, cleanup, network/platform services and tool audit
- Deterministic local fake upstreams/control planes for model providers, connectors, IdPs/JWKS, MCP, email, DNS, Headscale/Tailscale/Cloudflare, Google provisioning, runner/Docker boundaries and external memory
- Hosted Playwright flows for login, authenticated dashboard, MFA enrollment retry, generic OAuth MFA, tenant-switch enrollment, desktop operational pages and mobile access-governance recovery

Final immutable head and workflow URL are recorded after the terminal run below.

## Visual artifacts

The hosted browser job uploads screenshots for:

- `desktop-agents-dashboard.png`
- `desktop-network-overview.png`
- `desktop-network-exposure.png`
- `desktop-runners.png`
- `desktop-platform-services.png`
- `desktop-policies.png`
- `desktop-api-keys.png`
- `desktop-oauth-clients.png`
- `mobile-api-key-secret.png`
- `mobile-policies.png`
- `mobile-network-exposure.png`

All visual checks require loaded content, zero page errors and no error boundary. The mobile API-key flow also proves failure/retry, draft preservation and one-time secret display.

## Placeholder and secret gates

- Changed production source has no TODO, FIXME, “not implemented” or unimplemented branch
- The inherited platform-assistant migration fallback is now an unavailable-service error, with a positive test proving the mounted migration service is invoked
- UI input `placeholder` properties and tests checking unresolved templates are not implementation stubs
- Repository scans must show no committed GitHub token, provider key, OAuth token, private key or local auth configuration
- Real external providers stayed disabled without user credentials; no paid calls were made

## Intentional live-environment gates

These production adapters are implemented and fake-tested but cannot honestly be reported live-verified in this environment:

- Real SMTP delivery and DNS propagation
- Third-party OAuth/OIDC/SAML metadata, token and certificate behavior
- Hardware/browser WebAuthn authenticators
- Paid hosted model providers and real connector credentials/webhooks
- Multi-process Redis outage/reconnect behavior beyond hosted service integration and deterministic replica fakes
- Real Docker daemon/container networking, remote runners and OS desktop/CDP hosts
- Headscale/Tailscale/Cloudflare control planes and deployment
- External mem0-compatible services

These are credential/infrastructure gates, not unimplemented product branches.

## Final result

- Final head: pending
- GitHub Actions: pending
- Branch publication only; no merge/deploy
