# Route acceptance manifest

Baseline: `210677c58a700dbaf58dbff86350d46fd7b9a3e1`.

This source-derived inventory contains 474 registered HTTP handlers across the complete server source, including the 439 direct API surface plus OAuth, probe and mounted sub-application handlers. `rewritten` means the declaring production module differs from baseline; `preserved` remains an explicit compatibility implementation. Direct literal route tests are named where discoverable; all other handlers remain covered by the hosted full workspace suite and their module-level compatibility suites.

| Method | Path | Implementation | Source | Evidence |
|---|---|---|---|---|
| GET | `/` | rewritten | `apps/server/src/index.ts:425` | `instance-tools.test.ts`, `identity-tenant-lifecycle.test.ts`, `identity-domains.test.ts` |
| GET | `/` | preserved | `apps/server/src/mcp/stdio-bridge.ts:180` | `instance-tools.test.ts`, `identity-tenant-lifecycle.test.ts`, `identity-domains.test.ts` |
| GET | `/.well-known/jwks.json` | preserved | `apps/server/src/oauth/http.ts:76` | `oauth-cimd.test.ts` |
| GET | `/.well-known/oauth-authorization-server` | preserved | `apps/server/src/oauth/http.ts:68` | `mcp-upstream-oauth-security.test.ts` |
| GET | `/.well-known/oauth-authorization-server/*` | preserved | `apps/server/src/oauth/http.ts:69` | hosted full suite / module compatibility |
| GET | `/.well-known/oauth-protected-resource` | preserved | `apps/server/src/oauth/http.ts:85` | hosted full suite / module compatibility |
| GET | `/.well-known/oauth-protected-resource/*` | preserved | `apps/server/src/oauth/http.ts:89` | hosted full suite / module compatibility |
| GET | `/.well-known/openid-configuration` | preserved | `apps/server/src/oauth/http.ts:72` | hosted full suite / module compatibility |
| GET | `/.well-known/openid-configuration/*` | preserved | `apps/server/src/oauth/http.ts:73` | hosted full suite / module compatibility |
| GET | `/api/acp/registry` | preserved | `apps/server/src/api/acp-routes.ts:43` | hosted full suite / module compatibility |
| GET | `/api/agents` | rewritten | `apps/server/src/api/routes.ts:1833` | `observability.test.ts`, `spaces-lifecycle-api.test.ts`, `automation-runs.test.ts` |
| POST | `/api/agents` | rewritten | `apps/server/src/api/routes.ts:1854` | `observability.test.ts`, `spaces-lifecycle-api.test.ts`, `automation-runs.test.ts` |
| DELETE | `/api/agents/:id` | rewritten | `apps/server/src/api/routes.ts:2261` | `automation-runs.test.ts`, `agent-duplicate.test.ts` |
| GET | `/api/agents/:id` | rewritten | `apps/server/src/api/routes.ts:2038` | `automation-runs.test.ts`, `agent-duplicate.test.ts` |
| PATCH | `/api/agents/:id` | rewritten | `apps/server/src/api/routes.ts:2227` | `automation-runs.test.ts`, `agent-duplicate.test.ts` |
| GET | `/api/agents/:id/acp/adapters` | preserved | `apps/server/src/api/acp-routes.ts:63` | hosted full suite / module compatibility |
| DELETE | `/api/agents/:id/acp/adapters/:registryId` | preserved | `apps/server/src/api/acp-routes.ts:99` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/acp/adapters/:registryId/adopt` | preserved | `apps/server/src/api/acp-routes.ts:138` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/acp/adapters/:registryId/install` | preserved | `apps/server/src/api/acp-routes.ts:80` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/acp/adapters/gc` | preserved | `apps/server/src/api/acp-routes.ts:117` | hosted full suite / module compatibility |
| DELETE | `/api/agents/:id/acp/agents/:profileId` | preserved | `apps/server/src/api/acp-routes.ts:247` | hosted full suite / module compatibility |
| PUT | `/api/agents/:id/acp/agents/:profileId` | preserved | `apps/server/src/api/acp-routes.ts:225` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/acp/agents/:profileId/install` | preserved | `apps/server/src/api/acp-routes.ts:271` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/acp/agents/:profileId/oauth/device/cancel` | preserved | `apps/server/src/api/acp-routes.ts:492` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/acp/agents/:profileId/oauth/device/poll` | preserved | `apps/server/src/api/acp-routes.ts:478` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/acp/agents/:profileId/oauth/device/start` | preserved | `apps/server/src/api/acp-routes.ts:463` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/acp/agents/:profileId/probe` | preserved | `apps/server/src/api/acp-routes.ts:258` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/acp/config` | preserved | `apps/server/src/api/acp-routes.ts:180` | hosted full suite / module compatibility |
| PUT | `/api/agents/:id/acp/config` | preserved | `apps/server/src/api/acp-routes.ts:196` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/acp/draft` | preserved | `apps/server/src/api/acp-routes.ts:314` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/acp/installs` | preserved | `apps/server/src/api/acp-routes.ts:291` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/automation/runs` | rewritten | `apps/server/src/api/automation-routes.ts:189` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/automation/runs/:rid` | rewritten | `apps/server/src/api/automation-routes.ts:203` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/automation/runs/:rid/cancel` | rewritten | `apps/server/src/api/automation-routes.ts:212` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/bindings` | rewritten | `apps/server/src/api/routes.ts:2363` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/bindings` | rewritten | `apps/server/src/api/routes.ts:2370` | hosted full suite / module compatibility |
| DELETE | `/api/agents/:id/bindings/:instanceId` | rewritten | `apps/server/src/api/routes.ts:2386` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/cloud/composer` | rewritten | `apps/server/src/api/cloud-agent-routes.ts:220` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/cloud/config` | rewritten | `apps/server/src/api/cloud-agent-routes.ts:231` | hosted full suite / module compatibility |
| PUT | `/api/agents/:id/cloud/config` | rewritten | `apps/server/src/api/cloud-agent-routes.ts:248` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/cloud/sessions` | rewritten | `apps/server/src/api/cloud-agent-routes.ts:444` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/cloud/sessions` | rewritten | `apps/server/src/api/cloud-agent-routes.ts:470` | hosted full suite / module compatibility |
| DELETE | `/api/agents/:id/cloud/sessions/:sid` | rewritten | `apps/server/src/api/cloud-agent-routes.ts:650` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/cloud/sessions/:sid` | rewritten | `apps/server/src/api/cloud-agent-routes.ts:509` | hosted full suite / module compatibility |
| PATCH | `/api/agents/:id/cloud/sessions/:sid` | rewritten | `apps/server/src/api/cloud-agent-routes.ts:601` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/cloud/sessions/:sid/cancel` | rewritten | `apps/server/src/api/cloud-agent-routes.ts:905` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/cloud/sessions/:sid/compact` | rewritten | `apps/server/src/api/cloud-agent-routes.ts:923` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/cloud/sessions/:sid/continue` | rewritten | `apps/server/src/api/cloud-agent-routes.ts:875` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/cloud/sessions/:sid/fork` | rewritten | `apps/server/src/api/cloud-agent-routes.ts:947` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/cloud/sessions/:sid/messages` | rewritten | `apps/server/src/api/cloud-agent-routes.ts:667` | hosted full suite / module compatibility |
| DELETE | `/api/agents/:id/cloud/sessions/:sid/queue/:messageId` | rewritten | `apps/server/src/api/cloud-agent-routes.ts:778` | hosted full suite / module compatibility |
| PATCH | `/api/agents/:id/cloud/sessions/:sid/queue/:messageId` | rewritten | `apps/server/src/api/cloud-agent-routes.ts:759` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/cloud/sessions/:sid/queue/:messageId/interrupt` | rewritten | `apps/server/src/api/cloud-agent-routes.ts:788` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/cloud/sessions/:sid/regenerate` | rewritten | `apps/server/src/api/cloud-agent-routes.ts:811` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/cloud/sessions/:sid/retry` | rewritten | `apps/server/src/api/cloud-agent-routes.ts:844` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/cloud/sessions/:sid/tools` | rewritten | `apps/server/src/api/cloud-agent-routes.ts:585` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/connectors` | preserved | `apps/server/src/api/connector-routes.ts:287` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/desktop` | rewritten | `apps/server/src/api/routes.ts:2175` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/desktop-ticket` | rewritten | `apps/server/src/api/routes.ts:2182` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/duplicate` | rewritten | `apps/server/src/api/routes.ts:1911` | `agent-duplicate.test.ts` |
| GET | `/api/agents/:id/exposures` | rewritten | `apps/server/src/api/network-routes.ts:385` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/exposures` | rewritten | `apps/server/src/api/network-routes.ts:394` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/fs` | rewritten | `apps/server/src/api/agent-fs-routes.ts:118` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/fs/archive` | rewritten | `apps/server/src/api/agent-fs-routes.ts:203` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/fs/delete` | rewritten | `apps/server/src/api/agent-fs-routes.ts:302` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/fs/download` | rewritten | `apps/server/src/api/agent-fs-routes.ts:176` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/fs/extract` | rewritten | `apps/server/src/api/agent-fs-routes.ts:344` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/fs/list` | rewritten | `apps/server/src/api/agent-fs-routes.ts:137` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/fs/mkdir` | rewritten | `apps/server/src/api/agent-fs-routes.ts:282` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/fs/read` | rewritten | `apps/server/src/api/agent-fs-routes.ts:156` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/fs/rename` | rewritten | `apps/server/src/api/agent-fs-routes.ts:322` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/fs/upload` | rewritten | `apps/server/src/api/agent-fs-routes.ts:255` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/fs/write` | rewritten | `apps/server/src/api/agent-fs-routes.ts:229` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/gateway/sessions` | rewritten | `apps/server/src/api/cloud-agent-routes.ts:459` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/heartbeat` | rewritten | `apps/server/src/api/automation-routes.ts:231` | hosted full suite / module compatibility |
| PATCH | `/api/agents/:id/heartbeat` | rewritten | `apps/server/src/api/automation-routes.ts:239` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/heartbeat/run` | rewritten | `apps/server/src/api/automation-routes.ts:259` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/keys` | rewritten | `apps/server/src/api/routes.ts:2487` | hosted full suite / module compatibility |
| DELETE | `/api/agents/:id/memory` | rewritten | `apps/server/src/api/memory-routes.ts:400` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/memory` | rewritten | `apps/server/src/api/memory-routes.ts:135` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/memory/edges` | rewritten | `apps/server/src/api/memory-routes.ts:304` | hosted full suite / module compatibility |
| DELETE | `/api/agents/:id/memory/edges/:edgeId` | rewritten | `apps/server/src/api/memory-routes.ts:327` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/memory/embedding-stats` | rewritten | `apps/server/src/api/memory-routes.ts:277` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/memory/graph` | rewritten | `apps/server/src/api/memory-routes.ts:297` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/memory/items` | rewritten | `apps/server/src/api/memory-routes.ts:179` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/memory/items` | rewritten | `apps/server/src/api/memory-routes.ts:207` | hosted full suite / module compatibility |
| DELETE | `/api/agents/:id/memory/items/:memId` | rewritten | `apps/server/src/api/memory-routes.ts:388` | hosted full suite / module compatibility |
| PATCH | `/api/agents/:id/memory/items/:memId` | rewritten | `apps/server/src/api/memory-routes.ts:335` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/memory/reembed` | rewritten | `apps/server/src/api/memory-routes.ts:247` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/memory/search` | rewritten | `apps/server/src/api/memory-routes.ts:197` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/migrations` | preserved | `apps/server/src/api/migration-routes.ts:42` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/migrations` | preserved | `apps/server/src/api/migration-routes.ts:20` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/progress` | rewritten | `apps/server/src/api/routes.ts:2314` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/projects` | rewritten | `apps/server/src/api/agent-fs-routes.ts:364` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/projects` | rewritten | `apps/server/src/api/agent-fs-routes.ts:395` | hosted full suite / module compatibility |
| DELETE | `/api/agents/:id/projects/:slug` | rewritten | `apps/server/src/api/agent-fs-routes.ts:646` | hosted full suite / module compatibility |
| PATCH | `/api/agents/:id/projects/:slug` | rewritten | `apps/server/src/api/agent-fs-routes.ts:494` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/projects/:slug/config` | rewritten | `apps/server/src/api/agent-fs-routes.ts:737` | hosted full suite / module compatibility |
| PUT | `/api/agents/:id/projects/:slug/hooks` | rewritten | `apps/server/src/api/agent-fs-routes.ts:796` | hosted full suite / module compatibility |
| PUT | `/api/agents/:id/projects/:slug/instructions` | rewritten | `apps/server/src/api/agent-fs-routes.ts:758` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/projects/:slug/skills` | rewritten | `apps/server/src/api/agent-fs-routes.ts:830` | hosted full suite / module compatibility |
| DELETE | `/api/agents/:id/projects/:slug/skills/:name` | rewritten | `apps/server/src/api/agent-fs-routes.ts:920` | hosted full suite / module compatibility |
| PUT | `/api/agents/:id/projects/:slug/skills/:name` | rewritten | `apps/server/src/api/agent-fs-routes.ts:890` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/projects/:slug/skills/:name/file` | rewritten | `apps/server/src/api/agent-fs-routes.ts:867` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/providers` | rewritten | `apps/server/src/api/routes.ts:2401` | hosted full suite / module compatibility |
| PUT | `/api/agents/:id/providers` | rewritten | `apps/server/src/api/routes.ts:2412` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/routines` | rewritten | `apps/server/src/api/automation-routes.ts:43` | `automation-runs.test.ts` |
| POST | `/api/agents/:id/routines` | rewritten | `apps/server/src/api/automation-routes.ts:51` | `automation-runs.test.ts` |
| DELETE | `/api/agents/:id/routines/:sid` | rewritten | `apps/server/src/api/automation-routes.ts:140` | `automation-runs.test.ts` |
| GET | `/api/agents/:id/routines/:sid` | rewritten | `apps/server/src/api/automation-routes.ts:91` | `automation-runs.test.ts` |
| PATCH | `/api/agents/:id/routines/:sid` | rewritten | `apps/server/src/api/automation-routes.ts:102` | `automation-runs.test.ts` |
| POST | `/api/agents/:id/routines/:sid/run` | rewritten | `apps/server/src/api/automation-routes.ts:153` | `automation-runs.test.ts` |
| GET | `/api/agents/:id/routines/:sid/runs` | rewritten | `apps/server/src/api/automation-routes.ts:169` | `automation-runs.test.ts` |
| GET | `/api/agents/:id/routines/:sid/webhook-secret` | rewritten | `apps/server/src/api/automation-routes.ts:271` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/sessions/:sid/acp-runtime` | preserved | `apps/server/src/api/acp-routes.ts:299` | hosted full suite / module compatibility |
| PATCH | `/api/agents/:id/sessions/:sid/acp-runtime/config` | preserved | `apps/server/src/api/acp-routes.ts:411` | hosted full suite / module compatibility |
| PATCH | `/api/agents/:id/sessions/:sid/acp-runtime/mode` | preserved | `apps/server/src/api/acp-routes.ts:375` | hosted full suite / module compatibility |
| PATCH | `/api/agents/:id/sessions/:sid/acp-runtime/model` | preserved | `apps/server/src/api/acp-routes.ts:393` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/sessions/:sid/acp/authenticate` | preserved | `apps/server/src/api/acp-routes.ts:433` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/sessions/:sid/acp/elicitation` | preserved | `apps/server/src/api/acp-routes.ts:354` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/sessions/:sid/acp/logout` | preserved | `apps/server/src/api/acp-routes.ts:449` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/sessions/:sid/acp/permission` | preserved | `apps/server/src/api/acp-routes.ts:337` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/sessions/:sid/approvals` | rewritten | `apps/server/src/api/interaction-routes.ts:33` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/sessions/:sid/ask-user` | rewritten | `apps/server/src/api/interaction-routes.ts:14` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/skills` | rewritten | `apps/server/src/api/skill-routes.ts:329` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/skills` | rewritten | `apps/server/src/api/skill-routes.ts:341` | hosted full suite / module compatibility |
| DELETE | `/api/agents/:id/skills/:name` | rewritten | `apps/server/src/api/skill-routes.ts:396` | hosted full suite / module compatibility |
| PATCH | `/api/agents/:id/skills/:name` | rewritten | `apps/server/src/api/skill-routes.ts:378` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/skills/:name/file` | rewritten | `apps/server/src/api/skill-routes.ts:406` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/start` | rewritten | `apps/server/src/api/routes.ts:2272` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/stop` | rewritten | `apps/server/src/api/routes.ts:2342` | hosted full suite / module compatibility |
| POST | `/api/agents/:id/terminal-ticket` | rewritten | `apps/server/src/api/routes.ts:2206` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/tool-calls` | rewritten | `apps/server/src/api/routes.ts:3311` | hosted full suite / module compatibility |
| GET | `/api/agents/:id/tool-calls/stats` | rewritten | `apps/server/src/api/routes.ts:3320` | hosted full suite / module compatibility |
| GET | `/api/api-keys` | rewritten | `apps/server/src/api/routes.ts:3328` | hosted full suite / module compatibility |
| POST | `/api/api-keys` | rewritten | `apps/server/src/api/routes.ts:3347` | hosted full suite / module compatibility |
| DELETE | `/api/api-keys/:id` | rewritten | `apps/server/src/api/routes.ts:3407` | hosted full suite / module compatibility |
| POST | `/api/auth/forgot-password` | rewritten | `apps/server/src/api/identity-routes.ts:99` | hosted full suite / module compatibility |
| POST | `/api/auth/login` | rewritten | `apps/server/src/api/routes.ts:797` | `identity-session-routes.test.ts` |
| POST | `/api/auth/mfa/complete` | rewritten | `apps/server/src/api/identity-routes.ts:375` | `identity-session-routes.test.ts` |
| POST | `/api/auth/mfa/enrollment/totp/complete` | rewritten | `apps/server/src/api/identity-routes.ts:472` | `identity-session-routes.test.ts` |
| POST | `/api/auth/mfa/enrollment/totp/start` | rewritten | `apps/server/src/api/identity-routes.ts:461` | `identity-session-routes.test.ts` |
| POST | `/api/auth/mfa/webauthn/options` | rewritten | `apps/server/src/api/identity-routes.ts:363` | hosted full suite / module compatibility |
| POST | `/api/auth/reset-password` | rewritten | `apps/server/src/api/identity-routes.ts:107` | `identity-session-routes.test.ts` |
| POST | `/api/auth/sso/:protocol/start` | rewritten | `apps/server/src/api/identity-routes.ts:140` | hosted full suite / module compatibility |
| POST | `/api/auth/sso/discover` | rewritten | `apps/server/src/api/identity-routes.ts:127` | hosted full suite / module compatibility |
| POST | `/api/auth/sso/oidc/callback` | rewritten | `apps/server/src/api/identity-routes.ts:162` | `identity-tenant-lifecycle.test.ts` |
| POST | `/api/auth/sso/saml/:slug/acs` | rewritten | `apps/server/src/api/identity-routes.ts:238` | hosted full suite / module compatibility |
| GET | `/api/auth/sso/saml/:slug/metadata` | rewritten | `apps/server/src/api/identity-routes.ts:321` | hosted full suite / module compatibility |
| POST | `/api/auth/sso/ticket` | rewritten | `apps/server/src/api/identity-routes.ts:330` | hosted full suite / module compatibility |
| POST | `/api/auth/verify-email` | rewritten | `apps/server/src/api/identity-routes.ts:119` | `identity-session-routes.test.ts` |
| GET | `/api/capabilities` | rewritten | `apps/server/src/api/routes.ts:1190` | hosted full suite / module compatibility |
| GET | `/api/capabilities/web-fetch` | rewritten | `apps/server/src/api/routes.ts:1287` | hosted full suite / module compatibility |
| PUT | `/api/capabilities/web-fetch` | rewritten | `apps/server/src/api/routes.ts:1309` | hosted full suite / module compatibility |
| GET | `/api/capabilities/web-search` | rewritten | `apps/server/src/api/routes.ts:1166` | hosted full suite / module compatibility |
| PUT | `/api/capabilities/web-search` | rewritten | `apps/server/src/api/routes.ts:1254` | hosted full suite / module compatibility |
| GET | `/api/cloud/search` | rewritten | `apps/server/src/api/cloud-agent-routes.ts:419` | hosted full suite / module compatibility |
| GET | `/api/connect` | rewritten | `apps/server/src/api/routes.ts:1004` | hosted full suite / module compatibility |
| GET | `/api/connections` | preserved | `apps/server/src/api/connection-routes.ts:21` | hosted full suite / module compatibility |
| DELETE | `/api/connections/:id` | preserved | `apps/server/src/api/connection-routes.ts:170` | hosted full suite / module compatibility |
| POST | `/api/connections/:id/bind` | preserved | `apps/server/src/api/connection-routes.ts:157` | hosted full suite / module compatibility |
| POST | `/api/connections/:id/start` | preserved | `apps/server/src/api/connection-routes.ts:204` | hosted full suite / module compatibility |
| POST | `/api/connections/:id/stop` | preserved | `apps/server/src/api/connection-routes.ts:216` | hosted full suite / module compatibility |
| POST | `/api/connections/install` | preserved | `apps/server/src/api/connection-routes.ts:123` | hosted full suite / module compatibility |
| GET | `/api/connections/packages` | preserved | `apps/server/src/api/connection-routes.ts:48` | hosted full suite / module compatibility |
| GET | `/api/connections/packages/:id` | preserved | `apps/server/src/api/connection-routes.ts:66` | hosted full suite / module compatibility |
| POST | `/api/connections/packages/:id/install` | preserved | `apps/server/src/api/connection-routes.ts:74` | hosted full suite / module compatibility |
| GET | `/api/connections/search` | preserved | `apps/server/src/api/connection-routes.ts:27` | hosted full suite / module compatibility |
| GET | `/api/connections/sources` | preserved | `apps/server/src/api/connection-routes.ts:43` | hosted full suite / module compatibility |
| POST | `/api/connections/sources` | preserved | `apps/server/src/api/connection-routes.ts:98` | hosted full suite / module compatibility |
| DELETE | `/api/connections/sources/:id` | preserved | `apps/server/src/api/connection-routes.ts:114` | hosted full suite / module compatibility |
| GET | `/api/connectors` | preserved | `apps/server/src/api/connector-routes.ts:86` | hosted full suite / module compatibility |
| PUT | `/api/connectors/:id/credentials` | preserved | `apps/server/src/api/connector-routes.ts:304` | hosted full suite / module compatibility |
| POST | `/api/connectors/:ref/install` | preserved | `apps/server/src/api/connector-routes.ts:239` | hosted full suite / module compatibility |
| DELETE | `/api/connectors/:ref/installations/:agentId` | preserved | `apps/server/src/api/connector-routes.ts:270` | hosted full suite / module compatibility |
| POST | `/api/connectors/:ref/oauth/start` | preserved | `apps/server/src/api/connector-routes.ts:174` | hosted full suite / module compatibility |
| PUT | `/api/connectors/:ref/settings` | preserved | `apps/server/src/api/connector-routes.ts:364` | hosted full suite / module compatibility |
| GET | `/api/connectors/profiles` | preserved | `apps/server/src/api/connector-routes.ts:106` | hosted full suite / module compatibility |
| DELETE | `/api/connectors/profiles/:profileKey` | preserved | `apps/server/src/api/connector-routes.ts:140` | hosted full suite / module compatibility |
| PUT | `/api/connectors/profiles/:profileKey` | preserved | `apps/server/src/api/connector-routes.ts:116` | hosted full suite / module compatibility |
| GET | `/api/connectors/shared-oauth` | preserved | `apps/server/src/api/connector-routes.ts:158` | hosted full suite / module compatibility |
| GET | `/api/containers` | rewritten | `apps/server/src/api/routes.ts:1724` | hosted full suite / module compatibility |
| POST | `/api/containers/:id/stop` | rewritten | `apps/server/src/api/routes.ts:1802` | hosted full suite / module compatibility |
| POST | `/api/containers/allocate` | rewritten | `apps/server/src/api/routes.ts:1781` | hosted full suite / module compatibility |
| GET | `/api/email-connectors` | rewritten | `apps/server/src/api/routes.ts:2766` | hosted full suite / module compatibility |
| POST | `/api/email-connectors` | rewritten | `apps/server/src/api/routes.ts:2771` | hosted full suite / module compatibility |
| DELETE | `/api/email-connectors/:id` | rewritten | `apps/server/src/api/routes.ts:2812` | hosted full suite / module compatibility |
| PATCH | `/api/email-connectors/:id` | rewritten | `apps/server/src/api/routes.ts:2790` | hosted full suite / module compatibility |
| POST | `/api/email/inbound/:tenantId` | rewritten | `apps/server/src/api/routes.ts:680` | hosted full suite / module compatibility |
| POST | `/api/email/inbound/:tenantId/:connectorId` | rewritten | `apps/server/src/api/routes.ts:681` | hosted full suite / module compatibility |
| DELETE | `/api/exposures/:id` | rewritten | `apps/server/src/api/network-routes.ts:426` | hosted full suite / module compatibility |
| GET | `/api/files/shared/:token` | preserved | `apps/server/src/api/file-share-routes.ts:21` | hosted full suite / module compatibility |
| GET | `/api/health` | rewritten | `apps/server/src/observability.ts:118` | `zakurabot-channel.test.ts`, `socket-gateway.test.ts` |
| GET | `/api/instances` | rewritten | `apps/server/src/api/routes.ts:1342` | `instance-tools.test.ts`, `mcp-stdio-route-lifecycle.test.ts` |
| POST | `/api/instances` | rewritten | `apps/server/src/api/routes.ts:1383` | `instance-tools.test.ts`, `mcp-stdio-route-lifecycle.test.ts` |
| DELETE | `/api/instances/:id` | rewritten | `apps/server/src/api/routes.ts:1485` | hosted full suite / module compatibility |
| GET | `/api/instances/:id` | rewritten | `apps/server/src/api/routes.ts:1501` | hosted full suite / module compatibility |
| PATCH | `/api/instances/:id` | rewritten | `apps/server/src/api/routes.ts:1648` | hosted full suite / module compatibility |
| GET | `/api/instances/:id/containers/:containerId/logs` | rewritten | `apps/server/src/api/routes.ts:1705` | hosted full suite / module compatibility |
| POST | `/api/instances/:id/migrations` | preserved | `apps/server/src/api/connection-routes.ts:181` | hosted full suite / module compatibility |
| POST | `/api/instances/:id/rebuild` | rewritten | `apps/server/src/api/routes.ts:1470` | hosted full suite / module compatibility |
| GET | `/api/instances/:id/runtime` | rewritten | `apps/server/src/api/routes.ts:1679` | hosted full suite / module compatibility |
| POST | `/api/instances/:id/start` | rewritten | `apps/server/src/api/routes.ts:1430` | hosted full suite / module compatibility |
| POST | `/api/instances/:id/stop` | rewritten | `apps/server/src/api/routes.ts:1445` | hosted full suite / module compatibility |
| GET | `/api/instances/:id/tools` | preserved | `apps/server/src/api/mcp-routes.ts:129` | hosted full suite / module compatibility |
| PATCH | `/api/instances/:id/tools/:toolName` | preserved | `apps/server/src/api/mcp-routes.ts:164` | hosted full suite / module compatibility |
| GET | `/api/instances/reconcile` | rewritten | `apps/server/src/api/routes.ts:1459` | hosted full suite / module compatibility |
| POST | `/api/instances/reconcile` | rewritten | `apps/server/src/api/routes.ts:1464` | hosted full suite / module compatibility |
| GET | `/api/integrations/packages` | preserved | `apps/server/src/api/mcp-routes.ts:1631` | hosted full suite / module compatibility |
| GET | `/api/integrations/packages/:slug` | preserved | `apps/server/src/api/mcp-routes.ts:1636` | hosted full suite / module compatibility |
| GET | `/api/livez` | rewritten | `apps/server/src/observability.ts:119` | hosted full suite / module compatibility |
| POST | `/api/mcp/call` | preserved | `apps/server/src/api/mcp-routes.ts:893` | hosted full suite / module compatibility |
| POST | `/api/mcp/complete` | preserved | `apps/server/src/api/mcp-routes.ts:957` | hosted full suite / module compatibility |
| POST | `/api/mcp/google/provision` | preserved | `apps/server/src/api/mcp-routes.ts:1673` | hosted full suite / module compatibility |
| GET | `/api/mcp/google/provision-guide` | preserved | `apps/server/src/api/mcp-routes.ts:1644` | hosted full suite / module compatibility |
| POST | `/api/mcp/import` | preserved | `apps/server/src/api/mcp-routes.ts:442` | `mcp-stdio-route-lifecycle.test.ts` |
| POST | `/api/mcp/import-stdio` | preserved | `apps/server/src/api/mcp-routes.ts:1178` | `mcp-stdio-route-lifecycle.test.ts` |
| POST | `/api/mcp/import-vscode` | preserved | `apps/server/src/api/mcp-routes.ts:798` | hosted full suite / module compatibility |
| GET | `/api/mcp/oauth-redirect-uri` | preserved | `apps/server/src/api/mcp-routes.ts:1622` | hosted full suite / module compatibility |
| POST | `/api/mcp/parse-vscode` | preserved | `apps/server/src/api/mcp-routes.ts:873` | hosted full suite / module compatibility |
| GET | `/api/mcp/policies` | preserved | `apps/server/src/api/mcp-routes.ts:267` | hosted full suite / module compatibility |
| POST | `/api/mcp/policies` | preserved | `apps/server/src/api/mcp-routes.ts:300` | hosted full suite / module compatibility |
| DELETE | `/api/mcp/policies/:id` | preserved | `apps/server/src/api/mcp-routes.ts:410` | hosted full suite / module compatibility |
| PUT | `/api/mcp/policies/:id` | preserved | `apps/server/src/api/mcp-routes.ts:350` | hosted full suite / module compatibility |
| GET | `/api/mcp/policies/bootstrap` | preserved | `apps/server/src/api/mcp-routes.ts:212` | hosted full suite / module compatibility |
| POST | `/api/mcp/probe` | preserved | `apps/server/src/api/mcp-routes.ts:422` | hosted full suite / module compatibility |
| POST | `/api/mcp/prompts/get` | preserved | `apps/server/src/api/mcp-routes.ts:935` | hosted full suite / module compatibility |
| POST | `/api/mcp/resources/read` | preserved | `apps/server/src/api/mcp-routes.ts:920` | hosted full suite / module compatibility |
| POST | `/api/mcp/store/install` | preserved | `apps/server/src/api/mcp-routes.ts:1088` | hosted full suite / module compatibility |
| GET | `/api/mcp/store/search` | preserved | `apps/server/src/api/mcp-routes.ts:1067` | `mcp-catalog-routes.test.ts` |
| GET | `/api/mcp/store/servers/:name` | preserved | `apps/server/src/api/mcp-routes.ts:1078` | hosted full suite / module compatibility |
| GET | `/api/mcp/store/sources` | preserved | `apps/server/src/api/mcp-routes.ts:993` | `mcp-catalog-routes.test.ts` |
| POST | `/api/mcp/store/sources` | preserved | `apps/server/src/api/mcp-routes.ts:998` | `mcp-catalog-routes.test.ts` |
| DELETE | `/api/mcp/store/sources/:id` | preserved | `apps/server/src/api/mcp-routes.ts:1027` | hosted full suite / module compatibility |
| POST | `/api/mcp/store/sync` | preserved | `apps/server/src/api/mcp-routes.ts:1033` | `mcp-catalog-routes.test.ts` |
| GET | `/api/mcp/tools` | preserved | `apps/server/src/api/mcp-routes.ts:123` | hosted full suite / module compatibility |
| POST | `/api/mcp/upstream-oauth/authorize` | preserved | `apps/server/src/api/mcp-routes.ts:1453` | hosted full suite / module compatibility |
| GET | `/api/mcp/upstream-oauth/callback` | preserved | `apps/server/src/api/mcp-routes.ts:1498` | `google-cloud-provision.test.ts`, `mcp-upstream-oauth-security.test.ts` |
| POST | `/api/mcp/upstream-oauth/start` | preserved | `apps/server/src/api/mcp-routes.ts:1268` | hosted full suite / module compatibility |
| POST | `/api/mcp/upstream-oauth/verify` | preserved | `apps/server/src/api/mcp-routes.ts:1604` | hosted full suite / module compatibility |
| GET | `/api/me` | rewritten | `apps/server/src/api/routes.ts:948` | `identity-session-routes.test.ts`, `identity-enterprise-policy.test.ts`, `content-admin-routes.test.ts` |
| PATCH | `/api/me` | rewritten | `apps/server/src/api/identity-routes.ts:520` | `identity-session-routes.test.ts`, `identity-enterprise-policy.test.ts`, `content-admin-routes.test.ts` |
| DELETE | `/api/me/avatar` | rewritten | `apps/server/src/api/identity-routes.ts:558` | hosted full suite / module compatibility |
| POST | `/api/me/avatar` | rewritten | `apps/server/src/api/identity-routes.ts:546` | hosted full suite / module compatibility |
| GET | `/api/me/mfa` | rewritten | `apps/server/src/api/identity-routes.ts:631` | `identity-enterprise-policy.test.ts` |
| POST | `/api/me/mfa/totp/cancel` | rewritten | `apps/server/src/api/identity-routes.ts:657` | hosted full suite / module compatibility |
| POST | `/api/me/mfa/totp/disable` | rewritten | `apps/server/src/api/identity-routes.ts:680` | `identity-enterprise-policy.test.ts` |
| POST | `/api/me/mfa/totp/enable` | rewritten | `apps/server/src/api/identity-routes.ts:664` | hosted full suite / module compatibility |
| POST | `/api/me/mfa/totp/recovery` | rewritten | `apps/server/src/api/identity-routes.ts:706` | hosted full suite / module compatibility |
| POST | `/api/me/mfa/totp/start` | rewritten | `apps/server/src/api/identity-routes.ts:645` | hosted full suite / module compatibility |
| DELETE | `/api/me/mfa/webauthn/:id` | rewritten | `apps/server/src/api/identity-routes.ts:752` | hosted full suite / module compatibility |
| PATCH | `/api/me/mfa/webauthn/:id` | rewritten | `apps/server/src/api/identity-routes.ts:745` | hosted full suite / module compatibility |
| POST | `/api/me/mfa/webauthn/register` | rewritten | `apps/server/src/api/identity-routes.ts:729` | hosted full suite / module compatibility |
| POST | `/api/me/mfa/webauthn/register/options` | rewritten | `apps/server/src/api/identity-routes.ts:722` | hosted full suite / module compatibility |
| POST | `/api/me/password` | rewritten | `apps/server/src/api/identity-routes.ts:578` | hosted full suite / module compatibility |
| GET | `/api/me/sessions` | rewritten | `apps/server/src/api/identity-routes.ts:604` | hosted full suite / module compatibility |
| DELETE | `/api/me/sessions/:id` | rewritten | `apps/server/src/api/identity-routes.ts:610` | hosted full suite / module compatibility |
| POST | `/api/me/sessions/revoke-others` | rewritten | `apps/server/src/api/identity-routes.ts:624` | hosted full suite / module compatibility |
| POST | `/api/me/verify-email` | rewritten | `apps/server/src/api/identity-routes.ts:595` | hosted full suite / module compatibility |
| GET | `/api/memory-providers` | rewritten | `apps/server/src/api/memory-routes.ts:47` | `content-admin-routes.test.ts` |
| POST | `/api/memory-providers` | rewritten | `apps/server/src/api/memory-routes.ts:61` | `content-admin-routes.test.ts` |
| DELETE | `/api/memory-providers/:id` | rewritten | `apps/server/src/api/memory-routes.ts:112` | hosted full suite / module compatibility |
| GET | `/api/memory-providers/:id` | rewritten | `apps/server/src/api/memory-routes.ts:89` | hosted full suite / module compatibility |
| PATCH | `/api/memory-providers/:id` | rewritten | `apps/server/src/api/memory-routes.ts:96` | hosted full suite / module compatibility |
| POST | `/api/memory-providers/:id/health` | rewritten | `apps/server/src/api/memory-routes.ts:123` | hosted full suite / module compatibility |
| GET | `/api/memory-providers/meta` | rewritten | `apps/server/src/api/memory-routes.ts:43` | hosted full suite / module compatibility |
| GET | `/api/metrics` | rewritten | `apps/server/src/observability.ts:122` | hosted full suite / module compatibility |
| GET | `/api/migrations/:jobId` | preserved | `apps/server/src/api/migration-routes.ts:50` | hosted full suite / module compatibility |
| GET | `/api/migrations/:jobId/events` | preserved | `apps/server/src/api/migration-routes.ts:57` | hosted full suite / module compatibility |
| POST | `/api/model-catalog/import` | rewritten | `apps/server/src/api/model-router-routes.ts:611` | hosted full suite / module compatibility |
| GET | `/api/model-catalog/match` | rewritten | `apps/server/src/api/model-router-routes.ts:584` | hosted full suite / module compatibility |
| POST | `/api/model-catalog/refresh` | rewritten | `apps/server/src/api/model-router-routes.ts:597` | hosted full suite / module compatibility |
| POST | `/api/model-router/chat` | rewritten | `apps/server/src/api/model-router-routes.ts:685` | hosted full suite / module compatibility |
| POST | `/api/model-router/embed` | rewritten | `apps/server/src/api/model-router-routes.ts:627` | hosted full suite / module compatibility |
| POST | `/api/model-router/image` | rewritten | `apps/server/src/api/model-router-routes.ts:826` | hosted full suite / module compatibility |
| GET | `/api/model-router/meta` | rewritten | `apps/server/src/api/model-router-routes.ts:42` | hosted full suite / module compatibility |
| POST | `/api/model-router/rerank` | rewritten | `apps/server/src/api/model-router-routes.ts:655` | hosted full suite / module compatibility |
| GET | `/api/model-routes` | rewritten | `apps/server/src/api/model-router-routes.ts:371` | hosted full suite / module compatibility |
| POST | `/api/model-routes` | rewritten | `apps/server/src/api/model-router-routes.ts:403` | hosted full suite / module compatibility |
| DELETE | `/api/model-routes/:id` | rewritten | `apps/server/src/api/model-router-routes.ts:559` | hosted full suite / module compatibility |
| GET | `/api/model-routes/:id` | rewritten | `apps/server/src/api/model-router-routes.ts:477` | hosted full suite / module compatibility |
| PATCH | `/api/model-routes/:id` | rewritten | `apps/server/src/api/model-router-routes.ts:496` | hosted full suite / module compatibility |
| GET | `/api/model-upstreams` | rewritten | `apps/server/src/api/model-router-routes.ts:59` | hosted full suite / module compatibility |
| POST | `/api/model-upstreams` | rewritten | `apps/server/src/api/model-router-routes.ts:65` | hosted full suite / module compatibility |
| DELETE | `/api/model-upstreams/:id` | rewritten | `apps/server/src/api/model-router-routes.ts:113` | hosted full suite / module compatibility |
| GET | `/api/model-upstreams/:id` | rewritten | `apps/server/src/api/model-router-routes.ts:90` | hosted full suite / module compatibility |
| PATCH | `/api/model-upstreams/:id` | rewritten | `apps/server/src/api/model-router-routes.ts:97` | hosted full suite / module compatibility |
| POST | `/api/model-upstreams/:id/auth/cancel` | rewritten | `apps/server/src/api/model-router-routes.ts:188` | hosted full suite / module compatibility |
| POST | `/api/model-upstreams/:id/auth/logout` | rewritten | `apps/server/src/api/model-router-routes.ts:198` | hosted full suite / module compatibility |
| POST | `/api/model-upstreams/:id/auth/poll` | rewritten | `apps/server/src/api/model-router-routes.ts:149` | hosted full suite / module compatibility |
| POST | `/api/model-upstreams/:id/auth/start` | rewritten | `apps/server/src/api/model-router-routes.ts:140` | hosted full suite / module compatibility |
| POST | `/api/model-upstreams/:id/auth/submit` | rewritten | `apps/server/src/api/model-router-routes.ts:166` | hosted full suite / module compatibility |
| POST | `/api/model-upstreams/:id/health` | rewritten | `apps/server/src/api/model-router-routes.ts:210` | hosted full suite / module compatibility |
| GET | `/api/model-upstreams/:id/models` | rewritten | `apps/server/src/api/model-router-routes.ts:221` | hosted full suite / module compatibility |
| POST | `/api/model-upstreams/:id/sync-models` | rewritten | `apps/server/src/api/model-router-routes.ts:233` | hosted full suite / module compatibility |
| POST | `/api/model-upstreams/batch-delete` | rewritten | `apps/server/src/api/model-router-routes.ts:124` | hosted full suite / module compatibility |
| GET | `/api/oauth/authorize-info` | rewritten | `apps/server/src/api/routes.ts:1047` | `oauth-login-flow.test.ts` |
| GET | `/api/oauth/clients` | rewritten | `apps/server/src/api/routes.ts:1032` | hosted full suite / module compatibility |
| POST | `/api/oauth/consent` | rewritten | `apps/server/src/api/routes.ts:1107` | `oauth-login-flow.test.ts` |
| GET | `/api/otel/config` | preserved | `apps/server/src/api/otel-routes.ts:38` | `otel-ingest.test.ts` |
| POST | `/api/otel/v1/logs` | preserved | `apps/server/src/api/otel-routes.ts:48` | `otel-ingest.test.ts` |
| GET | `/api/platform` | rewritten | `apps/server/src/api/routes.ts:699` | hosted full suite / module compatibility |
| GET | `/api/platform-services` | rewritten | `apps/server/src/api/platform-service-routes.ts:40` | hosted full suite / module compatibility |
| GET | `/api/platform-services/:key` | rewritten | `apps/server/src/api/platform-service-routes.ts:120` | hosted full suite / module compatibility |
| PATCH | `/api/platform-services/:key` | rewritten | `apps/server/src/api/platform-service-routes.ts:189` | hosted full suite / module compatibility |
| POST | `/api/platform-services/:key/${action}` | rewritten | `apps/server/src/api/platform-service-routes.ts:281` | hosted full suite / module compatibility |
| POST | `/api/platform-services/:key/connect` | rewritten | `apps/server/src/api/platform-service-routes.ts:245` | hosted full suite / module compatibility |
| POST | `/api/platform-services/:key/deploy` | rewritten | `apps/server/src/api/platform-service-routes.ts:229` | hosted full suite / module compatibility |
| GET | `/api/platform-services/:key/diagnostics` | rewritten | `apps/server/src/api/platform-service-routes.ts:169` | hosted full suite / module compatibility |
| POST | `/api/platform-services/:key/disable` | rewritten | `apps/server/src/api/platform-service-routes.ts:264` | hosted full suite / module compatibility |
| GET | `/api/platform-services/:key/logs` | rewritten | `apps/server/src/api/platform-service-routes.ts:148` | hosted full suite / module compatibility |
| GET | `/api/platform-services/:key/progress` | rewritten | `apps/server/src/api/platform-service-routes.ts:136` | hosted full suite / module compatibility |
| GET | `/api/platform-services/meta/quotas` | rewritten | `apps/server/src/api/platform-service-routes.ts:56` | hosted full suite / module compatibility |
| PUT | `/api/platform-services/meta/quotas` | rewritten | `apps/server/src/api/platform-service-routes.ts:67` | hosted full suite / module compatibility |
| GET | `/api/platform-services/meta/usage` | rewritten | `apps/server/src/api/platform-service-routes.ts:96` | hosted full suite / module compatibility |
| GET | `/api/providers` | rewritten | `apps/server/src/api/routes.ts:1152` | hosted full suite / module compatibility |
| GET | `/api/ready` | rewritten | `apps/server/src/observability.ts:120` | hosted full suite / module compatibility |
| GET | `/api/readyz` | rewritten | `apps/server/src/observability.ts:121` | hosted full suite / module compatibility |
| GET | `/api/remote-channels` | rewritten | `apps/server/src/api/routes.ts:2829` | `remote-channel-lifecycle.test.ts` |
| POST | `/api/remote-channels` | rewritten | `apps/server/src/api/routes.ts:2844` | `remote-channel-lifecycle.test.ts` |
| DELETE | `/api/remote-channels/:id` | rewritten | `apps/server/src/api/routes.ts:2934` | hosted full suite / module compatibility |
| PATCH | `/api/remote-channels/:id` | rewritten | `apps/server/src/api/routes.ts:2884` | hosted full suite / module compatibility |
| POST | `/api/remote-channels/:id/access/approve` | rewritten | `apps/server/src/api/routes.ts:2949` | hosted full suite / module compatibility |
| POST | `/api/remote-channels/:id/access/deny` | rewritten | `apps/server/src/api/routes.ts:2971` | hosted full suite / module compatibility |
| ALL | `/api/remote-channels/:tenantId/:bindingId/webhook` | rewritten | `apps/server/src/api/routes.ts:2993` | hosted full suite / module compatibility |
| POST | `/api/routines/:id/hook` | rewritten | `apps/server/src/api/automation-routes.ts:284` | hosted full suite / module compatibility |
| GET | `/api/runtime-nodes` | preserved | `apps/server/src/api/runtime-node-routes.ts:223` | `runtime-node-connectivity.test.ts`, `runtime-node-delete.test.ts`, `agent-binaries.test.ts` |
| POST | `/api/runtime-nodes` | preserved | `apps/server/src/api/runtime-node-routes.ts:273` | `runtime-node-connectivity.test.ts`, `runtime-node-delete.test.ts`, `agent-binaries.test.ts` |
| DELETE | `/api/runtime-nodes/:id` | preserved | `apps/server/src/api/runtime-node-routes.ts:840` | hosted full suite / module compatibility |
| GET | `/api/runtime-nodes/:id` | preserved | `apps/server/src/api/runtime-node-routes.ts:560` | hosted full suite / module compatibility |
| PATCH | `/api/runtime-nodes/:id` | preserved | `apps/server/src/api/runtime-node-routes.ts:820` | hosted full suite / module compatibility |
| GET | `/api/runtime-nodes/:id/bootstrap.sh` | preserved | `apps/server/src/api/runtime-node-routes.ts:426` | hosted full suite / module compatibility |
| GET | `/api/runtime-nodes/:id/containers` | preserved | `apps/server/src/api/runtime-node-routes.ts:572` | hosted full suite / module compatibility |
| POST | `/api/runtime-nodes/:id/containers/allocate` | preserved | `apps/server/src/api/runtime-node-routes.ts:587` | hosted full suite / module compatibility |
| GET | `/api/runtime-nodes/:id/detail` | preserved | `apps/server/src/api/runtime-node-routes.ts:482` | hosted full suite / module compatibility |
| POST | `/api/runtime-nodes/:id/heartbeat` | preserved | `apps/server/src/api/runtime-node-routes.ts:198` | hosted full suite / module compatibility |
| GET | `/api/runtime-nodes/:id/image-updates` | preserved | `apps/server/src/api/runtime-node-routes.ts:792` | hosted full suite / module compatibility |
| GET | `/api/runtime-nodes/:id/install` | preserved | `apps/server/src/api/runtime-node-routes.ts:440` | hosted full suite / module compatibility |
| GET | `/api/runtime-nodes/:id/install.ps1` | preserved | `apps/server/src/api/runtime-node-routes.ts:360` | hosted full suite / module compatibility |
| GET | `/api/runtime-nodes/:id/install.sh` | preserved | `apps/server/src/api/runtime-node-routes.ts:335` | hosted full suite / module compatibility |
| POST | `/api/runtime-nodes/:id/refresh-workspace-image` | preserved | `apps/server/src/api/runtime-node-routes.ts:751` | hosted full suite / module compatibility |
| GET | `/api/runtime-nodes/:id/update-runner` | preserved | `apps/server/src/api/runtime-node-routes.ts:670` | hosted full suite / module compatibility |
| POST | `/api/runtime-nodes/:id/update-runner` | preserved | `apps/server/src/api/runtime-node-routes.ts:685` | hosted full suite / module compatibility |
| GET | `/api/runtime-nodes/:id/version` | preserved | `apps/server/src/api/runtime-node-routes.ts:634` | hosted full suite / module compatibility |
| DELETE | `/api/runtime-nodes/:nodeId/agents/:agentId/workspace-residual` | preserved | `apps/server/src/api/runtime-node-routes.ts:861` | hosted full suite / module compatibility |
| GET | `/api/runtime-nodes/agent-binaries/:os/:arch` | preserved | `apps/server/src/api/runtime-node-routes.ts:385` | hosted full suite / module compatibility |
| GET | `/api/runtime-nodes/mesh-status` | preserved | `apps/server/src/api/runtime-node-routes.ts:239` | hosted full suite / module compatibility |
| POST | `/api/runtime-nodes/register` | preserved | `apps/server/src/api/runtime-node-routes.ts:168` | hosted full suite / module compatibility |
| GET | `/api/runtime/docker` | rewritten | `apps/server/src/api/routes.ts:691` | hosted full suite / module compatibility |
| GET | `/api/settings` | rewritten | `apps/server/src/api/routes.ts:3418` | hosted full suite / module compatibility |
| PUT | `/api/settings/:key` | rewritten | `apps/server/src/api/routes.ts:3473` | hosted full suite / module compatibility |
| GET | `/api/settings/email/transactional` | rewritten | `apps/server/src/api/routes.ts:3445` | hosted full suite / module compatibility |
| PUT | `/api/settings/email/transactional` | rewritten | `apps/server/src/api/routes.ts:3453` | hosted full suite / module compatibility |
| GET | `/api/settings/network/active-exposures` | rewritten | `apps/server/src/api/network-routes.ts:350` | hosted full suite / module compatibility |
| POST | `/api/settings/network/active-exposures/stop-all` | rewritten | `apps/server/src/api/network-routes.ts:364` | hosted full suite / module compatibility |
| GET | `/api/settings/network/audit` | rewritten | `apps/server/src/api/network-routes.ts:341` | hosted full suite / module compatibility |
| GET | `/api/settings/network/exposure/providers` | rewritten | `apps/server/src/api/network-routes.ts:266` | hosted full suite / module compatibility |
| PATCH | `/api/settings/network/exposure/providers/:id` | rewritten | `apps/server/src/api/network-routes.ts:272` | hosted full suite / module compatibility |
| POST | `/api/settings/network/exposure/providers/:id/test` | rewritten | `apps/server/src/api/network-routes.ts:289` | hosted full suite / module compatibility |
| POST | `/api/settings/network/exposure/providers/cloudflare-named/create-tunnel` | rewritten | `apps/server/src/api/network-routes.ts:250` | hosted full suite / module compatibility |
| GET | `/api/settings/network/headscale` | rewritten | `apps/server/src/api/network-routes.ts:55` | hosted full suite / module compatibility |
| PUT | `/api/settings/network/headscale` | rewritten | `apps/server/src/api/network-routes.ts:66` | hosted full suite / module compatibility |
| GET | `/api/settings/network/mesh` | rewritten | `apps/server/src/api/network-routes.ts:99` | hosted full suite / module compatibility |
| POST | `/api/settings/network/mesh/acl/ensure-tags` | rewritten | `apps/server/src/api/network-routes.ts:176` | hosted full suite / module compatibility |
| POST | `/api/settings/network/mesh/auth-key` | rewritten | `apps/server/src/api/network-routes.ts:190` | hosted full suite / module compatibility |
| POST | `/api/settings/network/mesh/auth-key/generate` | rewritten | `apps/server/src/api/network-routes.ts:206` | hosted full suite / module compatibility |
| POST | `/api/settings/network/mesh/disconnect` | rewritten | `apps/server/src/api/network-routes.ts:228` | hosted full suite / module compatibility |
| POST | `/api/settings/network/mesh/oauth/connect` | rewritten | `apps/server/src/api/network-routes.ts:132` | hosted full suite / module compatibility |
| POST | `/api/settings/network/mesh/oauth/start` | rewritten | `apps/server/src/api/network-routes.ts:119` | hosted full suite / module compatibility |
| PATCH | `/api/settings/network/mesh/oauth/tags` | rewritten | `apps/server/src/api/network-routes.ts:160` | hosted full suite / module compatibility |
| POST | `/api/settings/network/mesh/platform/enable` | rewritten | `apps/server/src/api/network-routes.ts:105` | hosted full suite / module compatibility |
| POST | `/api/settings/network/mesh/sync` | rewritten | `apps/server/src/api/network-routes.ts:235` | hosted full suite / module compatibility |
| GET | `/api/settings/network/overview` | rewritten | `apps/server/src/api/network-routes.ts:88` | hosted full suite / module compatibility |
| GET | `/api/settings/network/security` | rewritten | `apps/server/src/api/network-routes.ts:303` | hosted full suite / module compatibility |
| PUT | `/api/settings/network/security` | rewritten | `apps/server/src/api/network-routes.ts:309` | hosted full suite / module compatibility |
| POST | `/api/setup` | rewritten | `apps/server/src/api/routes.ts:759` | hosted full suite / module compatibility |
| GET | `/api/skills` | rewritten | `apps/server/src/api/skill-routes.ts:264` | `content-admin-routes.test.ts` |
| DELETE | `/api/skills/:id` | rewritten | `apps/server/src/api/skill-routes.ts:320` | hosted full suite / module compatibility |
| GET | `/api/skills/:id` | rewritten | `apps/server/src/api/skill-routes.ts:301` | hosted full suite / module compatibility |
| PATCH | `/api/skills/:id/auto-update` | rewritten | `apps/server/src/api/skill-routes.ts:171` | hosted full suite / module compatibility |
| POST | `/api/skills/:id/update` | rewritten | `apps/server/src/api/skill-routes.ts:309` | hosted full suite / module compatibility |
| GET | `/api/skills/auto-update` | rewritten | `apps/server/src/api/skill-routes.ts:133` | hosted full suite / module compatibility |
| PUT | `/api/skills/auto-update` | rewritten | `apps/server/src/api/skill-routes.ts:143` | hosted full suite / module compatibility |
| GET | `/api/skills/cache` | rewritten | `apps/server/src/api/skill-routes.ts:121` | hosted full suite / module compatibility |
| POST | `/api/skills/check-updates` | rewritten | `apps/server/src/api/skill-routes.ts:158` | hosted full suite / module compatibility |
| POST | `/api/skills/install` | rewritten | `apps/server/src/api/skill-routes.ts:270` | hosted full suite / module compatibility |
| GET | `/api/skills/repos` | rewritten | `apps/server/src/api/skill-routes.ts:98` | hosted full suite / module compatibility |
| POST | `/api/skills/repos/:owner/:repo/sync` | rewritten | `apps/server/src/api/skill-routes.ts:108` | hosted full suite / module compatibility |
| POST | `/api/skills/resolve` | rewritten | `apps/server/src/api/skill-routes.ts:251` | hosted full suite / module compatibility |
| GET | `/api/skills/search` | rewritten | `apps/server/src/api/skill-routes.ts:75` | hosted full suite / module compatibility |
| GET | `/api/skills/stores` | rewritten | `apps/server/src/api/skill-routes.ts:60` | hosted full suite / module compatibility |
| GET | `/api/skills/tokens` | rewritten | `apps/server/src/api/skill-routes.ts:190` | `content-admin-routes.test.ts` |
| DELETE | `/api/skills/tokens/:provider` | rewritten | `apps/server/src/api/skill-routes.ts:236` | hosted full suite / module compatibility |
| PUT | `/api/skills/tokens/:provider` | rewritten | `apps/server/src/api/skill-routes.ts:205` | hosted full suite / module compatibility |
| GET | `/api/spaces` | rewritten | `apps/server/src/api/routes.ts:1969` | `spaces-lifecycle-api.test.ts`, `spaces-api.test.ts`, `authenticated-agent-workflow.test.ts` |
| POST | `/api/spaces` | rewritten | `apps/server/src/api/routes.ts:1990` | `spaces-lifecycle-api.test.ts`, `spaces-api.test.ts`, `authenticated-agent-workflow.test.ts` |
| DELETE | `/api/spaces/:id` | rewritten | `apps/server/src/api/routes.ts:2020` | hosted full suite / module compatibility |
| GET | `/api/spaces/:id` | rewritten | `apps/server/src/api/routes.ts:1982` | hosted full suite / module compatibility |
| PATCH | `/api/spaces/:id` | rewritten | `apps/server/src/api/routes.ts:2002` | hosted full suite / module compatibility |
| GET | `/api/spaces/:id/graph` | rewritten | `apps/server/src/api/routes.ts:2031` | hosted full suite / module compatibility |
| GET | `/api/system/image-updates` | rewritten | `apps/server/src/api/routes.ts:3514` | hosted full suite / module compatibility |
| POST | `/api/system/image-updates/check` | rewritten | `apps/server/src/api/routes.ts:3541` | hosted full suite / module compatibility |
| POST | `/api/system/image-updates/check-all` | rewritten | `apps/server/src/api/routes.ts:3575` | hosted full suite / module compatibility |
| GET | `/api/tenant/audit` | rewritten | `apps/server/src/api/identity-routes.ts:944` | `identity-enterprise-policy.test.ts` |
| PUT | `/api/tenant/audit/retention` | rewritten | `apps/server/src/api/identity-routes.ts:993` | `identity-enterprise-policy.test.ts` |
| DELETE | `/api/tenant/current` | preserved | `apps/server/src/api/tenant-routes.ts:118` | hosted full suite / module compatibility |
| GET | `/api/tenant/current` | preserved | `apps/server/src/api/tenant-routes.ts:80` | hosted full suite / module compatibility |
| PATCH | `/api/tenant/current` | preserved | `apps/server/src/api/tenant-routes.ts:101` | hosted full suite / module compatibility |
| GET | `/api/tenant/identity/domains` | rewritten | `apps/server/src/api/identity-routes.ts:801` | hosted full suite / module compatibility |
| POST | `/api/tenant/identity/domains` | rewritten | `apps/server/src/api/identity-routes.ts:807` | hosted full suite / module compatibility |
| DELETE | `/api/tenant/identity/domains/:id` | rewritten | `apps/server/src/api/identity-routes.ts:864` | hosted full suite / module compatibility |
| PATCH | `/api/tenant/identity/domains/:id` | rewritten | `apps/server/src/api/identity-routes.ts:825` | hosted full suite / module compatibility |
| POST | `/api/tenant/identity/domains/:id/verify` | rewritten | `apps/server/src/api/identity-routes.ts:848` | hosted full suite / module compatibility |
| GET | `/api/tenant/identity/mfa` | rewritten | `apps/server/src/api/identity-routes.ts:771` | `identity-enterprise-policy.test.ts` |
| PUT | `/api/tenant/identity/mfa` | rewritten | `apps/server/src/api/identity-routes.ts:777` | `identity-enterprise-policy.test.ts` |
| GET | `/api/tenant/identity/scim` | rewritten | `apps/server/src/api/identity-routes.ts:900` | hosted full suite / module compatibility |
| POST | `/api/tenant/identity/scim/tokens` | rewritten | `apps/server/src/api/identity-routes.ts:909` | hosted full suite / module compatibility |
| DELETE | `/api/tenant/identity/scim/tokens/:id` | rewritten | `apps/server/src/api/identity-routes.ts:932` | hosted full suite / module compatibility |
| PATCH | `/api/tenant/identity/scim/tokens/:id` | rewritten | `apps/server/src/api/identity-routes.ts:922` | hosted full suite / module compatibility |
| GET | `/api/tenant/identity/sso` | rewritten | `apps/server/src/api/identity-routes.ts:877` | hosted full suite / module compatibility |
| PUT | `/api/tenant/identity/sso` | rewritten | `apps/server/src/api/identity-routes.ts:885` | hosted full suite / module compatibility |
| GET | `/api/tenant/onboarding` | preserved | `apps/server/src/api/tenant-routes.ts:150` | hosted full suite / module compatibility |
| PATCH | `/api/tenant/onboarding` | preserved | `apps/server/src/api/tenant-routes.ts:160` | hosted full suite / module compatibility |
| POST | `/api/tenant/onboarding/bootstrap` | preserved | `apps/server/src/api/tenant-routes.ts:192` | hosted full suite / module compatibility |
| POST | `/api/tenant/onboarding/complete` | preserved | `apps/server/src/api/tenant-routes.ts:175` | hosted full suite / module compatibility |
| GET | `/api/tenant/people` | rewritten | `apps/server/src/api/identity-routes.ts:532` | hosted full suite / module compatibility |
| GET | `/api/tenant/people/:id` | rewritten | `apps/server/src/api/identity-routes.ts:538` | hosted full suite / module compatibility |
| GET | `/api/tenants` | preserved | `apps/server/src/api/tenant-routes.ts:66` | hosted full suite / module compatibility |
| GET | `/api/tool-calls` | rewritten | `apps/server/src/api/routes.ts:3290` | `tool-call-store.test.ts` |
| GET | `/api/tool-calls/:id` | rewritten | `apps/server/src/api/routes.ts:3304` | hosted full suite / module compatibility |
| GET | `/api/tool-calls/stats` | rewritten | `apps/server/src/api/routes.ts:3297` | `tool-call-store.test.ts` |
| GET | `/api/upstream-models` | rewritten | `apps/server/src/api/model-router-routes.ts:254` | hosted full suite / module compatibility |
| POST | `/api/upstream-models` | rewritten | `apps/server/src/api/model-router-routes.ts:271` | hosted full suite / module compatibility |
| DELETE | `/api/upstream-models/:id` | rewritten | `apps/server/src/api/model-router-routes.ts:343` | hosted full suite / module compatibility |
| PATCH | `/api/upstream-models/:id` | rewritten | `apps/server/src/api/model-router-routes.ts:311` | hosted full suite / module compatibility |
| POST | `/api/upstream-models/batch-delete` | rewritten | `apps/server/src/api/model-router-routes.ts:354` | hosted full suite / module compatibility |
| GET | `/api/usage/me` | rewritten | `apps/server/src/api/usage-routes.ts:46` | `identity-enterprise-policy.test.ts` |
| GET | `/api/usage/users` | rewritten | `apps/server/src/api/usage-routes.ts:67` | `identity-enterprise-policy.test.ts` |
| GET | `/api/usage/users/:userId` | rewritten | `apps/server/src/api/usage-routes.ts:90` | hosted full suite / module compatibility |
| GET | `/api/users/:id/avatar` | rewritten | `apps/server/src/api/identity-routes.ts:565` | hosted full suite / module compatibility |
| GET | `/api/zakurabot/ws` | rewritten | `apps/server/src/api/routes.ts:2764` | `zakurabot-channel.test.ts` |
| GET | `/authorize` | preserved | `apps/server/src/oauth/http.ts:137` | `identity-tenant-lifecycle.test.ts`, `integration-catalog.test.ts`, `mcp-upstream-oauth-security.test.ts` |
| GET | `/health` | preserved | `apps/server/src/mcp/stdio-bridge.ts:176` | `zakurabot-channel.test.ts`, `model-upstream-admin-lifecycle.test.ts`, `socket-gateway.test.ts` |
| GET | `/healthz` | rewritten | `apps/server/src/observability.ts:115` | hosted full suite / module compatibility |
| GET | `/livez` | rewritten | `apps/server/src/observability.ts:114` | `observability.test.ts` |
| ALL | `/mcp` | rewritten | `apps/server/src/index.ts:422` | `instance-tools.test.ts`, `identity-session-routes.test.ts`, `acp-mcp-gateway.test.ts` |
| ALL | `/mcp/*` | rewritten | `apps/server/src/index.ts:423` | hosted full suite / module compatibility |
| GET | `/metrics` | rewritten | `apps/server/src/observability.ts:117` | `observability.test.ts` |
| GET | `/oauth/authorize` | preserved | `apps/server/src/oauth/http.ts:138` | `model-upstream-auth.test.ts`, `oauth-login-flow.test.ts` |
| GET | `/oauth/discovery` | preserved | `apps/server/src/oauth/http.ts:229` | hosted full suite / module compatibility |
| GET | `/oauth/jwks` | preserved | `apps/server/src/oauth/http.ts:80` | hosted full suite / module compatibility |
| POST | `/oauth/register` | preserved | `apps/server/src/oauth/http.ts:130` | `oauth-cimd.test.ts`, `oauth-login-flow.test.ts` |
| POST | `/oauth/token` | preserved | `apps/server/src/oauth/http.ts:178` | `provider-breadth-fake-transports.test.ts`, `network-provider-fake-control-plane.test.ts`, `model-upstream-auth.test.ts` |
| GET | `/oauth/userinfo` | preserved | `apps/server/src/oauth/http.ts:226` | hosted full suite / module compatibility |
| POST | `/oauth/userinfo` | preserved | `apps/server/src/oauth/http.ts:227` | hosted full suite / module compatibility |
| GET | `/readyz` | rewritten | `apps/server/src/observability.ts:116` | `observability.test.ts` |
| POST | `/register` | preserved | `apps/server/src/oauth/http.ts:129` | `identity-tenant-lifecycle.test.ts`, `oauth-cimd.test.ts`, `mcp-upstream-oauth-security.test.ts` |
| GET | `/scim/v2/Groups` | rewritten | `apps/server/src/api/scim-routes.ts:156` | `identity-tenant-lifecycle.test.ts` |
| PATCH | `/scim/v2/Groups/:id` | rewritten | `apps/server/src/api/scim-routes.ts:166` | hosted full suite / module compatibility |
| GET | `/scim/v2/ServiceProviderConfig` | rewritten | `apps/server/src/api/scim-routes.ts:41` | hosted full suite / module compatibility |
| GET | `/scim/v2/Users` | rewritten | `apps/server/src/api/scim-routes.ts:50` | `identity-tenant-lifecycle.test.ts` |
| POST | `/scim/v2/Users` | rewritten | `apps/server/src/api/scim-routes.ts:76` | `identity-tenant-lifecycle.test.ts` |
| DELETE | `/scim/v2/Users/:id` | rewritten | `apps/server/src/api/scim-routes.ts:140` | hosted full suite / module compatibility |
| GET | `/scim/v2/Users/:id` | rewritten | `apps/server/src/api/scim-routes.ts:66` | hosted full suite / module compatibility |
| PATCH | `/scim/v2/Users/:id` | rewritten | `apps/server/src/api/scim-routes.ts:117` | hosted full suite / module compatibility |
| PUT | `/scim/v2/Users/:id` | rewritten | `apps/server/src/api/scim-routes.ts:94` | hosted full suite / module compatibility |
| POST | `/token` | preserved | `apps/server/src/oauth/http.ts:177` | `identity-tenant-lifecycle.test.ts`, `identity-session-routes.test.ts`, `model-route-workflow.test.ts` |
| POST | `/token/revoke` | preserved | `apps/server/src/oauth/http.ts:180` | hosted full suite / module compatibility |
| GET | `/userinfo` | preserved | `apps/server/src/oauth/http.ts:224` | `oauth-cimd.test.ts`, `identity-enterprise-policy.test.ts` |
| POST | `/userinfo` | preserved | `apps/server/src/oauth/http.ts:225` | `oauth-cimd.test.ts`, `identity-enterprise-policy.test.ts` |
| POST | `/v1/chat/completions` | rewritten | `apps/server/src/api/openai-gateway-routes.ts:572` | `gateway-key-catalog-lifecycle.test.ts` |
| POST | `/v1/messages` | rewritten | `apps/server/src/api/openai-gateway-routes.ts:820` | hosted full suite / module compatibility |
| GET | `/v1/models` | rewritten | `apps/server/src/api/openai-gateway-routes.ts:171` | `openai-gateway.test.ts`, `model-router.test.ts`, `gateway-key-catalog-lifecycle.test.ts` |
| POST | `/v1/responses` | rewritten | `apps/server/src/api/openai-gateway-routes.ts:244` | hosted full suite / module compatibility |
