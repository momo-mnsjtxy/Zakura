# Runner runtime architecture

The runner remains wire-compatible with the pinned Zakura control plane. JSON messages use the existing `sys.*`, `host.fs.*`, `host.exec.*`, `host.pty.*`, and `docker.*` method names.

## Rewritten boundaries

- `internal/rpc/dispatch.go` owns protocol-family routing for system/update and jailed filesystem operations. `handler.go` owns common reply/error behavior and the remaining execution transports.
- `internal/host/jail.go` treats `spaceId` as untrusted input. Workspace roots are derived beneath `StorageRoot`; RPC callers cannot override the host root.
- Cancellation still flows through Go contexts into downloads, updates, host commands, and Docker operations. Streaming progress remains base64-framed on the caller-provided stream ID.

## Intentionally preserved components

Platform-specific service installation, PTY implementations, Docker CLI semantics, self-update replacement logic, and the JSON codec are retained because they are already isolated adapters with operating-system tests. MCP tool descriptor JSON under `mcps/` is static protocol data and is preserved byte-for-byte.

Run `go test ./...` and `go vet ./...` with Go 1.23 or newer. Provider credentials and external services are not required by the test suite.
