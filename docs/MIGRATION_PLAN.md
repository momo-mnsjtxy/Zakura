# Module-by-module rewrite plan

Baseline contracts remain fixed at `210677c58a700dbaf58dbff86350d46fd7b9a3e1`. Each stage is complete only after implementation logic is replaced coherently and the named compatibility gates pass. Preserved assets, schemas, migrations, type declarations, and protocol catalogs do not count as rewritten business logic.

1. **Foundation and boundaries (in progress)**
   - Workspace/CI/acceptance manifests; API transport/session/error; chat event state; DB target/lifecycle; Go RPC dispatch/jail; OAuth app/state/security; Docker mux transport
   - Gates: package typechecks/builds, focused boundary tests, Go test/vet
2. **Identity and tenancy**
   - Reimplement accounts, sessions, invites, email verification/reset, OAuth/OIDC, MFA, SSO, SCIM, audit, suspension, tenant isolation, SaaS onboarding/admin
   - Gates: all identity/auth/account-status/SaaS tests, migration upgrade paths, browser interrupted auth/onboarding flows
3. **Agent/session/event core**
   - Reimplement agent, space and project aggregates; cloud sessions/runs/events; queue/cancel/interrupt/retry; sequence/history; Socket.IO/Yjs/presence
   - Gates: cloud-agent/platform-events/socket/Yjs/presence suites and reconnect/replay browser smoke
4. **Model gateway**
   - Reimplement provider-independent request/stream/tool state machine and adapters for OpenAI Responses/chat, Anthropic Messages, compatible/region/OAuth upstreams and weighted retry
   - Gates: deterministic local fake upstreams for SSE fragmentation, media/reasoning/tool continuation/error/retry/cancel
5. **Tools, MCP, skills, memory**
   - Reimplement approval/ask-user/ACP policy, MCP stdio/HTTP/OAuth lifecycle, catalog/install/health/conformance, skill cache/source/update, memory/vector/graph services
   - Gates: approval timeout/default-deny, conformance, skill and memory suites; static tool catalogs schema-validated
6. **Runtimes and workspaces**
   - Reimplement container/local/remote orchestration, runner RPC/update/image/migration, terminal/process/filesystem/CDP/desktop, path jail and recovery
   - Gates: core/server runner/workspace/ACP suites, Go tests/vet, fake runner/daemon lifecycle tests
7. **Connectors and channels**
   - Reimplement shared connector lifecycle plus Slack, GitHub, GitLab, Jira, Linear, Notion, Google Workspace, M365, Discord, email, Feishu and remote channel command/reaction flows
   - Gates: per-provider local fake servers, webhook/auth refresh/error/retry tests; real credentials remain live-verification gates
8. **Spaces, operations and deployment**
   - Reimplement collaboration/settings/computers/automation/files/shares/reactions/platform services/network/tunnel/observability/usage and deployment diagnostics
   - Gates: spaces/platform/network/telemetry tests; compose/static checks; live Docker/Headscale/deployment only with environment authorization
9. **Full product acceptance**
   - Compare all 439 HTTP routes and non-HTTP contracts against baseline manifest; run every shared/core/server/web/SaaS/Go test; production builds; browser happy/interrupted/repeated flows; fresh and upgrade DB tests
   - Publish only to an explicitly authorized fork/isolated branch; verify Actions on the exact commit before reporting readiness
