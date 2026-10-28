# Memory-only credential lifecycle — development harness

Version0.9.0 adds `src/credential-vault.mjs`. It stores only explicitly supplied grant values in process memory and gives private host code opaque object handles. It does not read saved credentials, files, browser storage or environment secrets. It has no default exchange implementation, OAuth/device-code request, HTTP route, network connection or activation from `npm start`.

## Interfaces and provenance

`createCredentialVault({now,refreshTimeoutMs,setTimer,clearTimer})` provides `store`, `resolveAccess`, `refresh`, `revoke`, `stop` and `getState`. A local grant has exactly `accessToken`, `refreshToken`, `expiresIn` and `scopes`. Tokens are bounded header-safe strings, expiry must fit the local safe clock, and this harness's scope policy permits only `user:read:chat`. That is a local restriction, not a claim about every Twitch grant format.

Supplied fields and local checks do not establish client/user identity, account permission or service provenance. Public state remains a credential-memory harness with network/authenticity flags false. The tests use synthetic canaries; no actual token is acquired or used.

The returned handle is an object compatible with the current HTTP adapter's synchronous credential resolver. Its identity is private; JSON/clone-shaped substitutes cannot resolve it. Handles and snapshots contain no token values, token prefixes or lengths. `resolveAccess` is a privileged private-host operation that intentionally returns the access value to an adapter. It must never be exposed as a public API or used in controller/overlay state.

## Replacement, refresh and cancellation

Store/refresh replacement uses a new handle and retires the old record. Token fields in retired records are cleared even when external code retains an old handle. Invalid replacement fails closed. Old or foreign handle operations cannot revoke a newer grant. Observed expiry at its exact deadline is terminal for that handle; clock rollback does not revive it. Lease/expiry logic depends on the trusted local clock rather than proving a platform fact.

`refresh(handle,{exchange,signal})` calls only an explicitly injected private callback. One operation may be outstanding; a concurrent refresh is rejected, so it cannot independently consume the same refresh value. Access resolution pauses during replacement. The callback returns a projected local grant, not a raw arbitrary service response.

A referenced deadline and native abort signal bound the pending operation. Timeout, abort, revoke, stop, replacement or observed old-access expiry retires it; a late response cannot revive the old operation or overwrite a new grant. Errors use fixed local codes without an arbitrary cause or service body. A successful refresh returns a new handle that a future host must validate and bind before reuse.

No grant protocol, token endpoint form encoding, identity validation or transport rebinding is implemented by the vault. The existing session coordinator retains its original handle; automatic refresh/rebinding is not claimed. A future production host must coordinate validation, intake pause, run cancellation and the new handle.

## Private-reference limits

Dropping references is not secure memory erasure. The trusted host callback can retain a refresh value, and an HTTP adapter may already have resolved an access value into a header. Vault revoke/stop cannot recall those copies or cancel their work by itself. The owning host must abort in-flight adapters and retire the corresponding receive generation. JavaScript/runtime and arbitrary host code are outside this vault's isolation guarantee.

The stage-twelve checks exercise replacement, cancellation, expiry, privacy surfaces and synthetic HTTP-adapter composition. Their actual saved result is linked after execution. They do not establish successful OAuth, refresh acceptance, Twitch connectivity, a client handshake or a real audience outcome.
