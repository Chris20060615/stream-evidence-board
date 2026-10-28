# Offline EventSub protocol rehearsal

Version 0.2.0 adds a pure protocol guard and synthetic fixture runner. **There is no WebSocket connection, credential loading, OAuth flow, Helix subscription or Twitch message delivery.** The existing simulator still rejects real or unverified origins. This module is preparation for a later authorized adapter, not evidence that a platform integration works.

Run once after changing the guard or fixture:

```powershell
node scripts/rehearse-eventsub.mjs
```

The script opens only the bundled `fixtures/synthetic-eventsub.json`. Its provenance is explicitly `synthetic`; the numeric identifiers are hand-authored placeholders, not verified account identities. It uses an injected clock and makes no network request. Printed diagnostics omit raw chat text, viewer IDs, delivery IDs and session IDs.

## Guard boundary

`createEventSubInbox()` is pinned to a broadcaster, reader and subscription. `receive()` validates a text frame's bounds and structure, session lifecycle, expected subscription fields, channel, reader, time and both envelope/chat identities. It may return a normalized event with `origin: eventsub-unverified`. Parsed JSON cannot establish its sender, so this provenance must not be promoted to Twitch merely because it passed schema checks.

The existing board rejects that event with `unsupported_origin`. The rehearsal asserts this and verifies zero board votes. A future adapter must own a properly authorized transport, validate the actual subscription response, enforce the same identities and provide explicit connection/authorization evidence before any trusted ingestion route is enabled. No public HTTP endpoint is added for protocol frames.

## Local policies beyond the wire format

- The command text cap is 300 characters, matching this board. It is not a claim about Twitch's platform-wide message limit.
- A frame cap, delivery/cache capacities, TTL and maximum age bound local resources. Delivery IDs and chat-message IDs are deduplicated separately. These caches expire; this is not permanent exactly-once processing.
- Nanosecond RFC3339 text is retained; integer milliseconds are used for this prototype's clock comparisons. The metadata time is notification-envelope time, not a documented original chat send time.
- Notifications from another Shared Chat source are excluded even when delivered to the target channel.
- The watchdog uses local receive time and expires when silence exceeds the welcome timeout. A malformed frame cannot keep the guard alive. Ping/Pong belongs to a future WebSocket transport and does not count as an EventSub keepalive.
- This guard freezes after reconnect request, revocation, timeout or explicit close. It does not implement Twitch's graceful two-socket handover. Reconnect URLs are restricted to the official WSS host and returned unmodified for an action plan; no URL is followed.
- Welcome establishes only a structurally ready offline session. It does not prove a successful Helix subscription or satisfy the welcome-to-subscribe deadline. Those remain future transport responsibilities.

See [the verified adapter plan](twitch-adapter-plan.md) for primary Twitch references, the minimal read scope and the distinction between graceful migration and an unexpected connection loss. No new scope or account has been authorized here.
