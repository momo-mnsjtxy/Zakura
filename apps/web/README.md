# Zakura web

The web client keeps Zakura's established information architecture and complete
route surface while separating the implementation into explicit boundaries:

- `src/lib/api-session.ts` owns browser authentication state
- `src/lib/api-error.ts` owns typed failure semantics
- `src/lib/api-transport.ts` owns HTTP authorization, decoding and suspension handling
- `src/lib/api.ts` coordinates caching and in-flight request de-duplication
- `src/lib/socket.ts` owns the shared realtime connection and reconnection lifecycle
- `src/lib/chat-state.js` owns session request arbitration and event/history ordering
- `src/components/chat/*` renders chat, projects, files, tasks, approvals and streaming state
- `src/app/**` provides route-level composition for auth, agents, spaces, stores, settings,
  infrastructure, administration and callback flows

The recognizable upstream components and route feature modules remain intentionally
compatible rather than replacing working product functionality with placeholders.
Rewritten infrastructure modules are covered by package-local Node tests; route-level
contract tests prevent deep-link, cancellation, reconnect, retry and navigation regressions.

## Validation

```sh
pnpm --filter @zakura/web test
pnpm --filter @zakura/web typecheck
pnpm --filter @zakura/web build
```
