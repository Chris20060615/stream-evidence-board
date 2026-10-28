# Device-grant lifecycle — injected development harness

Version0.12.0 adds `src/device-grant.mjs`. It models a device-authorization lifecycle with explicitly injected device and token-poll dependencies. It has no default fetch implementation, account/app registration, credential loader, real endpoint activation or browser navigation. The simulator and staged tally do not import or automatically bind this module.

## Interfaces and private ownership

`createDeviceGrantHarness(configuration)` requires `clientId`, `adapters.device`, `adapters.poll`, `onPrompt` and `onGrant`; the clock, timers and I/O timeout can be injected. Its frozen facade provides `start(options)`, `cancel()`, `stop()` and `getState()`. `start` accepts an optional native abort signal and settles at a terminal lifecycle outcome. A concurrent start is rejected rather than beginning another device request. Cancel ends the current attempt and permits a later explicit start; stop is terminal.

Device/poll dependencies receive fixed POST request proposals for the Twitch device/token endpoints and a per-operation native abort signal. The requested scope is exactly `user:read:chat`; the polling proposal uses the device grant type and keeps the device code private. These are proposals to trusted injected adapters, not outgoing service requests. Version0.13.0 adds separately injected [private HTTP ports](device-grant-http.md) for encoding, redirect policy and streamed response limits; they remain inactive unless explicitly supplied and are tested with fake fetch only.

Projected receipts use `{httpStatus,body}` with bounded own data fields. The device receipt carries a code, user instructions and expiry/interval; the poll receipt is either a bounded token shape or a recognized error. Unknown or malformed input ends the attempt without echoing the raw receipt or error. The implementation does not claim to accept every general OAuth response shape.

`onPrompt({userCode,verificationUri,expiresAt},{signal})` is a privileged local hook. Device/user codes and activation links must not enter controller/overlay state, chat, logs or recording. Activation addresses are restricted to the official HTTPS host/path and the documented bounded query form; this local allowlist does not prove service provenance. The harness never opens the address.

`onGrant(grant,{signal})` privately receives a projected vault-compatible object with `accessToken`, `refreshToken`, `expiresIn` and `scopes`. Requiring a refresh value and an exact read-scope array is local policy. This callback still needs separate identity validation and host-lifecycle binding; a matching injected token shape is not actual authorization. The harness returns no tokens or opaque credential handles.

Callback signals cover their pending I/O operation. Once a prompt hook returns, its signal is not a lifetime subscription to later flow cancellation; a future prompt UI must separately observe the owner's lifecycle and remove expired instructions. The one-hour bound applies to device lifetime and polling interval, while access-token lifetime accepts positive safe seconds with safe millisecond/deadline arithmetic, including a four-hour value. This module adds no minimum remaining access-lifetime policy; the later validation/coordinator boundary remains separate.

## Polling, expiry and cancellation

The original device deadline is conservatively computed from device-request start plus its returned lifetime. Request latency consumes that allowance. Pending and slowdown responses do not replace or extend the deadline. The exact deadline rejects late success, and an observed terminal outcome cannot be revived by clock rollback or an old callback.

The first poll waits for the returned interval, or five seconds if none was supplied. Only pending and slowdown permit another poll; slowdown permanently adds five seconds for subsequent requests. One owned poll is active at a time. Denial, code expiry, invalid code, unknown response, cancellation or timeout ends polling. Invalid-device-code and expiry remain distinct outcomes.

A timer wake alone cannot permit an early poll: the same absolute polling deadline is checked again and any remaining wait is rescheduled. The harness also rejects a backward local clock during an active flow. These are local timing protections, not evidence of server acceptance or a sandbox against arbitrary injected clock/timer code.

Device, poll and private callback waits are bounded and cancellable even if an injected dependency ignores its signal. I/O timeout is terminal here, with no automatic retry or exponential backoff implementation. This is a stricter local stop policy; it is not a claim that retries without frequency reduction comply with the RFC. Referenced operation deadlines ensure a standalone pending invocation can settle.

Timers, callbacks and result admission carry private generation/operation checks. Cancellation or replacement retires ownership before invoking abort/cleanup hooks. A late result cannot overwrite a newer attempt or call a new grant handoff. A callback already given a value may retain it or start its own work; cancellation cannot recall those copies or automatically revoke an external host. The owning integration must honor its signal and retire its own work.

## Public evidence and remaining work

Public state/results identify `device-grant-harness` and keep `networkConnected`, `authorizationVerified` and `realTwitchConnected` false, including after injected success. They contain lifecycle/deadline information rather than client identity, device/user codes, activation URLs, scopes, token values or callback results. Dropping references is not secure memory erasure, and injected clock/timer/dependency code is trusted rather than sandboxed.

The [source review](device-grant-sources-stage16.md) separates Twitch examples, RFC rules, retained documentation differences and stricter local choices. Actual saved checks and extraction records live in the private canonical workspace; its README links them. Portable candidates contain software inputs, not private audit records.

No real device request, token poll, consent screen, account permission, refresh acceptance or token identity validation is established by synthetic tests. Authorized participant account/application, actual HTTP service behavior, client/handshake/Pong, trusted platform ingress and real message-to-visible-overlay/browser/OBS evidence remain pending. No grant success is upgraded into real-Twitch or submission readiness.
