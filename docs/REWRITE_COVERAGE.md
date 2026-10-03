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
| Server routes/business services/providers | Compatibility baseline currently retained except fixes discovered by tests | 439-route manifest parity, all server tests, fake-upstream suites; further coherent rewrites required before claiming complete rewrite |
| SaaS routes/admin logic | Compatibility baseline retained | SaaS typecheck/tests and admin browser smoke; further rewrite required before claiming complete rewrite |
| Go RPC dispatch/error/path boundary | Substantively reorganized behind preserved wire protocol | `go test ./...`, `go vet ./...`, traversal/lifecycle tests |
| OAuth bridge app/bootstrap/state/PKCE boundary | Substantively reorganized behind preserved endpoints | Typecheck/build and local no-network OAuth tests |
| Core Docker mux transport | Substantively extracted behind compatibility exports | Core full suite including fragmented and binary frames |
| Remaining core runtime orchestration | Compatibility baseline retained | Core suite, cancellation/timeout/process tests; further rewrite required before claiming complete rewrite |
| MCP JSON tool manifests/catalog data | Intentionally preserved protocol data | Schema/catalog/conformance validation |
| Database migrations | Intentionally preserved ordered compatibility history | Fresh and upgrade migration tests on supported DB targets |
| Docker/Caddy/headscale/deployment definitions | Preserved operational interface, not executed locally | Static validation only until live-infrastructure authorization/environment exists |

## Live verification gates

Real third-party credentials and paid provider calls are intentionally excluded. Production adapters must be exercised with local fake servers. Live Google/OAuth, hosted model, external connector, Headscale, Docker network isolation/proxy, deployment, and remote publish remain environment/authorization gates and may not be reported as passed from local tests.

## Source delta snapshot (2026-10-03)

Generated build output is excluded. These counts prevent a carried-over compatibility floor from being mislabeled as a completed rewrite.

| Scope | Baseline-identical files | Changed files | Added files | Missing files |
|---|---:|---:|---:|---:|
| `apps/server` | 513 | 10 | 15 | 0 |
| `packages/saas` | 13 | 0 | 3 | 0 |
| `apps/web` | 280 | 18 | 27 | 0 |
| `packages/core` | 38 | 5 | 12 | 0 |
| `go` | 43 | 3 | 3 | 0 |
| `apps/oauth-bridge` | 1 | 3 | 8 | 0 |
| `mcps` | 128 | 0 | 0 | 0 |
| `packages/shared` | 53 | 0 | 3 | 0 |

The large baseline-identical counts mean the repository is currently a compatibility-preserving foundation plus targeted architectural rewrites. It is not yet a complete rewrite of all business logic. Follow `MIGRATION_PLAN.md` stage by stage until the remaining logic has been replaced and every acceptance gate is green.
