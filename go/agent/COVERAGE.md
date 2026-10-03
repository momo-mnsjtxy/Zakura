# Runtime/tooling rewrite coverage ledger

## Substantially rewritten

| Area | New boundary | Validation |
|---|---|---|
| Go RPC routing | `internal/rpc/dispatch.go` separates system/update and filesystem method families from common response handling | `go test ./...`, `go vet ./...` |
| Host workspace confinement | `internal/host/jail.go` validates control-plane `spaceId`; RPC roots can no longer be supplied by callers | traversal/root-override regression in `internal/rpc/fs_paths_test.go` |
| OAuth process architecture | `apps/oauth-bridge/src/app.ts`, `state.ts`, and `index.ts` separate HTTP protocol, expiring state, and socket lifecycle | TypeScript typecheck/build; 4/4 local OAuth/state tests passed |
| OAuth authorization safety | Downstream PKCE S256, callback policy, delayed one-time-code consumption | `apps/oauth-bridge/test/oauth-bridge.test.ts` and `state.test.ts` |
| Core Docker transport | `packages/core/src/docker-mux.ts` isolates fragmented text frames and binary-safe frames; old export remains compatible | core typecheck/build; 17 focused shell-job/stdio transport tests passed via the tsx loader; direct mux checks passed |

## Intentionally preserved for compatibility

| Area | Reason |
|---|---|
| `mcps/**/tools/*.json` | Static externally defined tool descriptors; byte preservation avoids schema drift |
| Go JSON message codec and method names | Active control-plane wire contract |
| Platform service/install/update adapters | Already isolated per operating system and covered by platform-specific tests |
| Docker CLI operation semantics | Existing runtime contract; dispatch ownership changed without altering commands/results |
| `packages/core` public runtime, filesystem, runner, registry, and observability interfaces | Consumed by server/shared packages; compatibility is required |
| OAuth Google live exchange | Adapter is implemented; live verification requires deployer credentials and consent and is not claimed by local tests |
