# Scoped session to staged tally — synthetic composition

Version0.11.0 adds `src/staged-session-host.mjs`, composing the private credential/session host with the separate staged-ingress harness. This is an offline development composition using explicitly supplied dependencies. The source of an accepted event remains unverified; no local receipt, scope object or capability establishes OAuth or Twitch provenance.

## Interfaces and first-event binding

`createStagedSessionHost(configuration)` requires `clientId`, `broadcasterId`, `readerId`, `fetchImpl`, `connect` and `exchange`. The configured broadcaster and reader must match. Optional settings are `now`, `setTimer`, `clearTimer`, `ioTimeoutMs`, `refreshTimeoutMs`, `leaseMs`, `card` and `boardOptions`. There is no public event callback setting and no default fetch, WebSocket client, grant exchange, credential loader or network activation.

The frozen facade supplies `start`, `refresh`, `revoke`, `stop`, `getState`, `openVote`, `closeVote` and `reset`, plus a separate `simulation` facade. It exports no generic event-ingestion method, private scope, capability, credential handle or ingress host facade. Do not pass it into the simulator's generic HTTP application. The existing server and UI do not import this module.

The credential host validates its private grant, connects, requires a welcome and checks the subscription acknowledgement. Only an actually delivered event carries the private frozen scope of that run. The first such event binds a scoped, expiring capability and is then projected into the staged board. Until that first event, the staged board remains disconnected even if the transport has received an acknowledgement. This is deliberately first-event binding, not a claim that an acknowledgement alone established an active tally.

The exact private scope pins broadcaster, reader, socket session and subscription. Its object identity belongs to one run. The five-field copied event retains `origin: transport-unverified` at the bridge, and only the isolated internal synthetic board uses its private simulation representation. All exported staged totals and source cues stay visibly identified as harness data.

## Retirement, windows and replay

Refresh retires the staged capability before an exchange can run; a concurrent busy refresh cannot independently replace the valid operation. A new validated coordinator run supplies a new private scope. Old callbacks and disconnect/error notifications cannot revoke or mutate a newer run's scope. Scope retirement is permanent for that identity; matching strings or another message from that same old scope cannot automatically renew a lease.

Observed transport failure, disconnect, reconnect request, credential expiry or capability lease expiry retires intake and clears its active source cue. Lease expiry is checked at operation/delivery boundaries using the trusted local clock; it is not a continuous platform monitor. A fresh explicit lifecycle is required after retirement. Stop is terminal. Reset revokes the session and scope and clears the staged round, requiring a later explicit start; reset preserves staged replay memory.

Rebinding does not extend an existing voting deadline or clear retained event IDs. A new event can change a viewer's current choice, while retained replays leave counts unchanged. Underlying TTL/capacity bounds still apply; this is not permanent exactly-once processing. Original event timestamps remain part of admission, so earlier-round messages cannot enter a later round merely because a connection changed.

The simulation and staged boards keep separate caches and tallies. A simulated ID cannot preempt a staged event or vice versa. Source requests use the existing fixed15-second cue; repeated fresh requests do not extend it. Retirement clears the cue without extending the vote window. Source/help behavior remains local and sends no Twitch chat.

## Privacy and execution limits

Public top-level snapshots identify `staged-session-host-harness`; the board remains `staged-ingress-harness`. Network, real-Twitch and authorization flags remain false. Public state contains aggregate counts and lifecycle/deadline information, not private scopes, token values, handles, capabilities, viewer identities or raw messages. The separate simulation facade retains its existing explicitly simulated contract.

Injected callbacks, timers, clock and connection implementations remain trusted host code. This composition is not a sandbox. It cannot recall values already delivered to dependency code, prove physical socket shutdown or erase JavaScript memory securely. The credential host drops events during a pending start/refresh; no queue or lossless reconnect is promised. Coordinator emitted-event metrics count attempts rather than successful staged votes.

When snapshot reads fail, aggregate values and the last session phase can be cached. If private admission has been retired, the public board remains projected as disconnected with an inactive cue even when the failed clock later recovers. A failed inner revoke cannot restore the old callback ticket or scope. This is the wrapper's admission state, not a claim that every inner cleanup or physical transport action completed.

Saved tests and extraction evidence live in the private canonical workspace, whose README links them. Portable packages exclude private TAP/release records and do not provide independent audit proof. The new checks use synthetic fetch/connect/exchange dependencies and token canaries. Actual OAuth acquisition/refresh, real WebSocket handshake/automatic Pong, graceful handover, a trusted live issuer, Twitch message-to-visible-overlay operation and browser/OBS evidence remain pending. No audience, user-study, learning or competition-submission outcome is asserted.
