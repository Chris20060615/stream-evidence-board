# Local host entry gate — activation remains unavailable

Version0.18.0 adds a lifecycle boundary before constructing an injected device/session owner. It supplies no owner, fetch, WebSocket implementation, credential input, environment reader, browser opener, human-review UI or trusted live issuer. The simulator is unchanged. A local review callback is not proof of human permission, OAuth or Twitch operation; every authenticity/network flag remains false.

## Public plan and private decision

`createHostEntryGate` requires public client/broadcaster/reader IDs, a trusted `review` callback and a synchronous `createOwner` factory. The reader must equal the broadcaster under the current own-channel policy. The immutable plan fixes only `user:read:chat`, no chat sending and no credential persistence. Unknown fields or configurable scopes are rejected. Public IDs are for the operator's review; do not paste secrets into ID fields. Validation is not a universal secret detector.

Construction and `getPlan()` are inert. `start({signal})` enters a bounded review, passing the plan and private `{signal, expiresAt, accept}` metadata only to the injected callback. A current, unexpired first call to accept produces an opaque per-run identity. The callback must return that exact identity. JSON booleans, approval-shaped objects, an old run's decision and another gate's decision cannot substitute. A serialized HTTP parameter cannot provide this decision through the facade.

The injected callback remains trusted: it can accept mechanically or leak its private values. No actual human review provider is implemented here, and identity equality cannot establish human intent or account authorization. A future production host must bind this private callback to the specifically authorized operator/application/channel workflow before invoking real effects. This module does not grant that authorization.

## Owner lifetime and stop behavior

Only a current accepted decision constructs the explicit owner. The factory receives the same immutable public plan and must supply own-data start/stop methods. The gate calls start with its owned native abort signal. The existing device/session owner is compatible through a future host-supplied factory; tests compose that actual owner with a fake pending HTTP dependency.

Review and owner start have separate referenced deadlines, default60seconds and5seconds. Cancellation, abort, denial, timeout, failure and terminal stop retire the current run before invoking owned teardown. Late review/start results cannot revive it. Factory reentry cannot start a retired owner, and teardown blocks a replacement start during synchronous cleanup. Stop is observed without waiting for its returned promise; a malicious synchronous host function still cannot be preempted by JavaScript. Timer hooks must follow the ordinary asynchronous timer contract. Injected clocks/factories/callbacks are trusted code, not a sandbox.

An active state means the gate owns a locally started owner, not that the underlying coordinator is receiving or its grant is authorized. Subsequent credential/session expiry and transport liveness remain the owner's responsibility. No refresh or board-control shortcut is exposed by this gate. Cancellation/stop revoke the held lifetime. The public result drops raw factory/start/review diagnostics and receipt fields; private prompts, grants and owner snapshots are not forwarded. Clearing references is not secure-erasure proof.

Version0.19.0 also checks the same fixed start deadline at operation boundaries: after the synchronous owner factory returns, before invoking owner start, around success-receipt inspection and after timer cleanup. The closing instant is excluded even if timer delivery is delayed. Factory and cleanup time consume the original start budget; a late factory owner is disposed without invoking start. A late start result retires ownership rather than publishing active state. This cannot preempt a synchronous factory or undo an owner side effect already started before expiry. The start deadline does not become a lease after a timely successful start. Ownership and clock are checked again after clearing the deadline, so a reentrant cancellation or elapsed cleanup cannot republish the active flag.

## Review-only CLI

```text
node scripts/review-host-entry.mjs --help
node scripts/review-host-entry.mjs --client-id PUBLIC_CLIENT_ID --broadcaster-id NUMERIC_CHANNEL_ID --reader-id SAME_NUMERIC_CHANNEL_ID
```

These are command forms, not evidence of a real configured application. The CLI accepts only public identifiers, prints the plan with activationAvailable:false and never calls start. There is no activation/approve/token/secret option, account creation, saved-password read, network dependency or preview route. Invalid/duplicate/unknown fields fail with a fixed message without echoing supplied values. The CLI does not read environment or credential files; Node itself still runs in the caller's process environment.

The canonical README links the actual focused and fresh-extraction checks. Synthetic review decisions and fake owner/HTTP behavior are software evidence only. The frozen0.17.0 review package and earlier memory labs retain their own source inventories/results; they are not relabeled0.18.0 or rerun to validate this gate. Real account/app consent, secure human prompt, trusted live admission, graceful handover, channel-to-visible-overlay, permitted UI/OBS and external release remain separate pending work.
