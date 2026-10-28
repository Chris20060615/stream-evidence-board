# Private credential/session composition — development harness

Version0.10.0 adds `src/credential-session-host.mjs`. It composes the existing in-memory credential vault, fixed-endpoint HTTP adapters and unverified transport coordinator. Version0.11.0 additionally passes private acknowledgement scope with an actually delivered event. The caller must explicitly supply dependencies. Importing the module and running the simulator do not acquire a grant, select a network client or activate this host.

## Interface and ownership

`createCredentialSessionHost(configuration)` requires `clientId`, `broadcasterId`, `readerId`, `fetchImpl`, `connect` and `exchange`. Broadcaster and reader must match under the local own-channel policy. Optional hooks are `onEvent`, `now`, `setTimer`, `clearTimer`, `ioTimeoutMs` and `refreshTimeoutMs`. There is no global-fetch fallback, default WebSocket factory, environment/file credential loader or default OAuth exchange.

The frozen facade provides `start(grant)`, `refresh(options)`, `revoke()`, `stop()` and `getState()`. A supplied grant follows the vault's exact local shape and read-scope policy. It is private host input, not controller JSON. Handles and token values are retained internally and are never returned in public operation results. Refresh accepts an optional native abort signal. A pending start or refresh excludes a concurrent operation; it does not launch a second refresh exchange.

`start` stores the supplied grant and starts a coordinator using the private handle. The HTTP adapter projects the validation receipt; the coordinator checks the fixed client, reader, scope and remaining lifetime before calling the supplied connection dependency. A successful start can still be awaiting welcome: it does not mean that a subscription is acknowledged or chat intake is active.

## Refresh, revocation and generations

Refresh first retires the old callback generation and synchronously stops/aborts the old coordinator. Only then may the explicitly injected exchange receive the private refresh value. A successful exchange produces a new vault handle. A fresh coordinator validates that handle before any new connection, and still requires its own welcome and subscription acknowledgement before delivery. Refresh is explicit; no background grant flow is installed.

Revoke retires the current binding, aborts work and clears module-owned credential references; a later explicit start can create a new binding. Stop is terminal for the host. Captured old bindings and their callbacks cannot replace or clear a newer binding. Late HTTP, connection or exchange results cannot restart retired intake.

The connection close wrapper invokes the supplied close method once, observes a returned rejection and returns without awaiting a closing handshake. This keeps cancellation responsive even if a dependency returns a never-settling close promise. It does not guarantee that underlying I/O stopped, that a physical socket closed or that arbitrary dependency code released its own copies. The dependency remains trusted private host code.

## Observation and private event delivery

The underlying coordinator owns its welcome, subscription, keepalive, validation and I/O timers. The host checks the vault/coordinator at operation and delivery boundaries; failure or expiry observation retires the binding. This is not an independent continuous monitor or a production authorization source. The injected clock/timers are trusted local dependencies, and no claim is made about arbitrary hostile host code or clock manipulation.

Private `onEvent` delivery is permitted only for the current receiving generation. The event is projected to `id`, `userId`, `text`, `timestamp` and `origin: transport-unverified`. Raw delivery metadata and additional protocol fields are omitted. Viewer identity and message text still belong to that privileged callback; do not expose it as controller state or a general HTTP route. Callback failure is handled without reflecting arbitrary error text.

In version0.11.0 the second private callback argument is a frozen scope object with `broadcasterId`, `readerId`, `sessionId` and `subscriptionId`. Its identity belongs to one coordinator run. It is captured from the fixed HTTP port's projected matching202 acknowledgement and request, but is supplied only when the coordinator actually delivers a current receiving event. The scope is not included in public results, snapshots or the five-field event. It is not an OAuth or service-provenance certificate. Only trusted host composition code may receive it.

While the host's start/refresh operation is still pending, events are conservatively dropped even if the coordinator has already entered its receiving phase. They are not queued for replay. The coordinator's `metrics.emittedEvents` counts its own callback attempts, not successful delivery to the host's private `onEvent`; this composition does not promise lossless delivery.

Public snapshots/results retain `mode: credential-session-host-harness` and false `networkConnected`, `realTwitchConnected` and `authorizationVerified` flags. They contain lifecycle/deadline/aggregate information rather than raw credentials, opaque handles, channel/session/subscription identities, viewer identifiers or messages. A valid receipt shape or successful injected dependency cannot establish service provenance.

## Evidence and remaining work

The stage-thirteen lifecycle checks and stage-fourteen private-scope bridge checks use the actual local composition modules with synthetic fetch/connect/exchange dependencies and synthetic credential canaries. The canonical README links the separately saved TAP and extraction record. The portable software candidate omits those private validation records and is not self-contained audit evidence.

The original0.10.0 module had no staged or live tally integration. The separate0.11.0 staged-session composition uses the private second callback argument to bind a synthetic tally; this base host still adds no board, simulator route or live issuer. OAuth grant acquisition, actual token refresh acceptance, real WebSocket construction/handshake/automatic Pong, trusted production ingress, graceful overlapping-socket handover, real Twitch operation and browser/OBS presentation remain pending. No actual credential, account authorization, audience outcome, public release or final submission is claimed.
