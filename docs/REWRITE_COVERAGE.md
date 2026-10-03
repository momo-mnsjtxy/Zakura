# Rewrite coverage ledger

Baseline: Moonrend/Zakura `210677c58a700dbaf58dbff86350d46fd7b9a3e1`.

This ledger separates rewritten implementation logic from compatibility material intentionally retained verbatim. “Present” is not equivalent to “rewritten.” Full product completion requires all behavior gates in `FEATURE_MATRIX.md`, not merely source-tree presence.

| Scope | Current treatment | Acceptance requirement |
|---|---|---|
| Root workspace, CI, integration tests, compatibility/ownership docs | New implementation | Pinned install, typecheck, tests, builds, and Go checks pass |
| `packages/shared` public contracts | Intentionally preserved compatibility interface; integration-owned | Existing shared test suite passes; consumers compile |
| Web assets/icons/WASM/service worker metadata | Intentionally preserved assets | Production build and browser smoke pass |
| Web HTTP/session/error/recovery and chat stream state | Substantively reorganized behind preserved API | Unit/component tests, typecheck, production build, browser interrupted/repeated-flow smoke |
| Server DB target/lifecycle foundation | Substantively reorganized behind preserved schema | Focused policy/lifecycle tests plus full server suite |
| Server routes/business services/providers | Identity, cloud queue/run/event, model routing/providers, connector/channel, skill/memory, Space/project/share, platform lifecycle and tenant cleanup are substantively rewritten; compatible auxiliary modules remain | 439-route manifest parity, all server tests and fake-upstream suites; preserved modules stay explicitly classified below |
| SaaS routes/admin logic | Registration, MFA issuance, tenant/member/owner and suspension lifecycle substantively rewritten; compatible admin operations remain | SaaS typecheck/tests and admin browser smoke |
| Go RPC dispatch/error/path boundary | Substantively reorganized behind preserved wire protocol | `go test ./...`, `go vet ./...`, traversal/lifecycle tests |
| OAuth bridge app/bootstrap/state/PKCE boundary | Substantively reorganized behind preserved endpoints | Typecheck/build and local no-network OAuth tests |
| Core Docker mux transport | Substantively extracted behind compatibility exports | Core full suite including fragmented and binary frames |
| Remaining core runtime orchestration | Runner request/stream/workspace/archive, process/container recovery and JSON-RPC transport substantively rewritten; OS-specific adapters preserved | Core suite and cancellation/timeout/process tests |
| MCP JSON tool manifests/catalog data | Intentionally preserved protocol data | Schema/catalog/conformance validation |
| Database migrations | Intentionally preserved ordered compatibility history | Fresh and upgrade migration tests on supported DB targets |
| Docker/Caddy/headscale/deployment definitions | Preserved operational interface, not executed locally | Static validation only until live-infrastructure authorization/environment exists |

## Live verification gates

Real third-party credentials and paid provider calls are intentionally excluded. Production adapters must be exercised with local fake servers. Live Google/OAuth, hosted model, external connector, Headscale, Docker network isolation/proxy, deployment, and remote publish remain environment/authorization gates and may not be reported as passed from local tests.

## Source delta snapshot (2026-10-03)

Generated build output is excluded. These counts prevent a carried-over compatibility floor from being mislabeled as a completed rewrite.

| Scope | Baseline-identical files | Changed files | Added files | Missing files |
|---|---:|---:|---:|---:|
| `apps/server` | 371 | 152 | 85 | 0 |
| `packages/saas` | 7 | 6 | 2 | 0 |
| `apps/web` | 236 | 62 | 50 | 0 |
| `packages/core` | 29 | 14 | 23 | 0 |
| `go` | 35 | 11 | 17 | 0 |
| `apps/oauth-bridge` | 1 | 3 | 5 | 0 |
| `mcps` | 128 | 0 | 0 | 0 |
| `packages/shared` | 53 | 0 | 1 | 0 |

Baseline-identical files are mostly presentation/assets, static protocol data, schemas, migrations and still-classified business modules. They are not counted as rewritten merely because the complete product remains present. Network/exposure, observability lifecycle, desktop/CDP state, automation, audit export, model upstream administration, local filesystem/image runtime lifecycle, and Go dial/Docker/host executor lifecycles are now migrated. Go system-update/platform shims remain intentionally preserved behind the rewritten dispatcher because they already provide staged hash/build validation, atomic replace/rollback and platform-specific compatibility coverage. Deployment/installer wrappers, remaining content/agent helpers and presentational web composition still require classification or migration. Follow `MIGRATION_PLAN.md` until those modules are substantively migrated or deliberately classified compatibility data and every Stage 9 gate is green.
