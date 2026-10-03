# Cross-package contracts

This file is the coordination point for stable contracts between the server, web application, runtime/agent, and integration layers.

## Ownership

- Backend: `apps/server/**` and `packages/saas/**`, including route modules, persistence, providers, model gateway, auth, realtime server, and backend tests
- Frontend: `apps/web/**`
- Runtime and tools: `packages/core/**`, `go/**`, `apps/oauth-bridge/**`, and `mcps/**`
- Integration: `packages/shared/**`, root configuration, `.github/**`, `docker/**`, `docs/**`, and `integration-tests/**`

Cross-boundary changes require notifying the owning worker. The acceptance target is compatibility with every upstream route, event, job, provider, setting, error, and recovery behavior at the pinned baseline.

## API compatibility

The backend owns the canonical manifest. It must retain each upstream HTTP method and path, response status and body shape, authentication/authorization requirement, SSE frame shape, Socket.IO event, Yjs/presence behavior, and idempotency/error semantics.

## Shared types

Integration owns `packages/shared`. Backend, frontend, and runtime/tools consume its exported types. Changes to shared exports must remain additive until all consumers migrate.
