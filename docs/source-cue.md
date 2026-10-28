# Simulated source request cue

This is a local product-flow rehearsal. The source link remains available on the controller and overlay regardless of cue or vote state. `!source` returns a local source string; no Twitch reply, outbound API call, account authorization or real viewer request is established.

## Engine contract

`createBoard()` adds `sourceCueMs`, default **15,000 ms**, bounded to integer 1,000–60,000 ms. Public `sourceCue` is `{active, requestedAt, expiresAt, requestCount, origin: "simulated"}`. It contains no viewer ID, message text or event ID.

A valid, unique simulated `!source` event while the simulator is connected opens a cue until a fixed deadline. Further fresh requests while active increment the cumulative request counter but **do not extend** that deadline. Duplicate events do not refresh or increment it. `requestCount` is an engineering event counter, not unique viewers, engagement evidence or research.

The existing `source` result and reply are preserved, with `sourceCuePublished` and `sourceCueReason`: `opened`, `already_active`, `disconnected`, `stale_event`, `unsafe_deadline` or `counter_limit`. A disconnected source request still returns the source locally without a cue. An optional timestamp older than one cue duration likewise produces a reply without cue/count; the exact age boundary is allowed. Invalid/future input and unsupported origins remain rejected.

At server time `now >= expiresAt`, the cue becomes inactive and its times become null. Disconnect or connecting state clears active cue/times; reset also clears its counter. Event replay protection survives reset. Opening/closing a vote does not control this independent source cue, and source requests never change vote totals.

## Controller and overlay behavior

Both pages display **“Simulated source request · source shown locally”** beside the existing link and a source-section highlight. They show no viewer name or request count, render with `textContent`, preserve keyboard focus and never auto-open a source or move the page. The polite status label is written only when its text changes, so polling does not repeatedly rewrite it. Idle, expired and unverified-origin cues are hidden; the static link stays visible. Actual assistive-technology announcements have not been tested.

Disconnect, reset and unavailable-server handling remove the cue and highlight. Polls normally refresh state every 500 ms. Each page also schedules a local hide timer for the existing `expiresAt` and refuses an active snapshot at or past that deadline. Timer replacement/clearing follows cue state and errors, so an unresolved request cannot preserve an expired cue. These timers do not create requests, extend the server deadline or imply fresh server state. Browser scheduling can delay rendering, so exact server expiry is not a claim of exact visual timing.

Requests have a five-second deadline covering both fetch and JSON decoding, using abort and a raced timeout. Unavailable state clears the cue; recovery requires a fresh successful response. The controller suppresses an older failed poll after a newer response has rendered, and a retry while unavailable does not briefly restore its cached cue.

## Verification boundary

The engine checks cover cue creation, fixed deadline under repeated requests, replay, age boundaries, expiry, disconnect/connecting/reset, unsupported origin and unchanged vote totals. The root agent reports **18/18 client contract checks passed**, including hanging requests, local cue deadlines, stale failure ordering, recovery, stable status text and hidden unverified-origin cues. These use a fake DOM and injected timing; they establish script behavior only. Browser layout, assistive-technology announcements, OBS display and real Twitch operation remain unverified.

A future authorized read-only Twitch adapter could display a source locally without sending chat. That route and any separately authorized chat-sending feature remain future work; the offline inbox and synthetic subscription preflight do not authorize either.
