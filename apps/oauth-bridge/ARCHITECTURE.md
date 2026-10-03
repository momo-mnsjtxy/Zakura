# OAuth bridge runtime

- `src/app.ts` implements the OAuth 2.1/DCR HTTP protocol and can be embedded in deterministic tests without opening a port.
- `src/state.ts` owns short-lived pending authorization and one-time grant state.
- `src/index.ts` is the process adapter only: structured readiness logging and socket binding.

Both upstream and downstream authorization legs use PKCE S256. Redirects are limited to HTTPS or loopback HTTP. Authorization codes are consumed only after verifier validation. The built-in store is process-local and bounded to 15 minutes; multi-instance production deployments need a shared encrypted implementation.

Automated tests use local requests and fake state only. The Google adapter is implemented but live credential verification is deployment work and is not claimed by this repository.
