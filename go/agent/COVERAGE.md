# Runtime/tooling rewrite coverage ledger

## Substantially rewritten

| Area | New boundary | Validation |
|---|---|---|
| Go RPC routing | `internal/rpc/dispatch.go` separates system/update and filesystem method families from common response handling | `go test ./...`, `go vet ./...` |
| Host workspace confinement | `internal/host/jail.go` validates control-plane `spaceId`; RPC roots can no longer be supplied by callers | traversal/root-override regression in `internal/rpc/fs_paths_test.go` |
| OAuth process architecture | `apps/oauth-bridge/src/app.ts`, `state.ts`, and `index.ts` separate HTTP protocol, expiring state, and socket lifecycle | TypeScript typecheck/build; 4/4 local OAuth/state tests passed |
| OAuth authorization safety | Downstream PKCE S256, callback policy, delayed one-time-code consumption | `apps/oauth-bridge/test/oauth-bridge.test.ts` and `state.test.ts` |
| Core MCP JSON-RPC lifecycle | `packages/core/src/json-rpc-client.ts` provides bounded/cancellable request state, idempotent close, fragmented JSON-lines stdio and JSON/fragmented-SSE HTTP transports | core typecheck/build; 7/7 deterministic fake process/fetch protocol tests |
| Remote migration archive lifecycle | `packages/core/src/runner-archive.ts` uses jailed unique temp files, bounded tar/download/upload/extract operations, cancellation-safe eventual cleanup, binary-safe transfer, real embedded manifests/SHA/excludes, preflight verification, staged apply/rollback and exit validation while preserving tar.gz/public methods | core typecheck/build; 7/7 deterministic fake-hub archive/rollback tests |
| Local ContainerRuntime recovery | `packages/core/src/recovering-runtime.ts` decorates any local runtime with bounded operations, coalesced stop/remove, retry after interruption, and force cleanup for late create success | core typecheck/build; 5/5 deterministic fake-runtime recovery tests |
| Local process lifecycle | `packages/core/src/process-lifecycle.ts` coordinates natural exit, stop/kill, timeout and AbortSignal cleanup; ShellJob and StdioExec share idempotent finalization | core typecheck/build; 8 new deterministic lifecycle tests plus existing shell/stdio suites, 25/25 focused pass |
| Runner workspace filesystem | `packages/core/src/runner-workspace-fs.ts` isolates the WorkspaceFs-to-RPC adapter and rejects traversal/NUL paths before RPC while preserving aliases and binary encoding | core typecheck/build; 4/4 deterministic fake-hub adapter/jail tests |
| Runner duplex lifecycle | `packages/core/src/runner-stream.ts` owns start/write/exit/cancel/kill, idempotent close, subscription cleanup, late-start recovery, timeout forwarding, and binary wire encoding | core typecheck/build; 5/5 deterministic fake-hub lifecycle tests |
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
