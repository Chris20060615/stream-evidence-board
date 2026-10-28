# Offline subscription preflight

Official Twitch documentation checked **2026-10-25, Asia/Shanghai**. This stage rehearses a synthetic validation receipt → request proposal → synthetic subscription acknowledgement. Local JSON cannot authenticate its sender. No credential is read, OAuth grant obtained, request sent, WebSocket opened or trusted vote-ingestion path enabled. Fixture client/user/session IDs are placeholders.

## Official facts

`GET https://id.twitch.tv/oauth2/validate` returns HTTP 200 for a valid token, with `client_id`, `scopes`, `expires_in` (seconds remaining), `user_id` and `login`. App access tokens have null user/login fields; invalid tokens return 401. Apps maintaining OAuth sessions must validate at startup and hourly, and end affected sessions after invalidation. These are future live-transport requirements; a synthetic 200 receipt establishes none of them. [Validating Tokens](https://dev.twitch.tv/docs/authentication/validate-tokens/)

An installed chat reader needs a user token with `user:read:chat`; writing chat additionally needs `user:write:chat`. Subscription conditions identify the channel broadcaster and the user reading as the bot, not each voter. [Chat authentication](https://dev.twitch.tv/docs/chat/authenticating/)

WebSocket subscription creation uses `POST https://api.twitch.tv/helix/eventsub/subscriptions`, a user bearer token and matching `Client-Id`. HTTP **202** means the request was accepted. The response's single `data` subscription includes ID, status, type, version, condition and transport; only `enabled` subscriptions receive events. For this board, match `channel.chat.message`, version `1`, configured broadcaster/reader, `websocket` transport and the welcomed session ID. HTTP 202 alone is not an enabled subscription. [Create EventSub Subscription](https://dev.twitch.tv/docs/api/reference/#create-eventsub-subscription)

By default, subscribe within **10 seconds after receiving welcome**. The welcome provides the socket session ID. This subscription window differs from `keepalive_timeout_seconds`, which governs silence detection after receiving events/keepalives. [WebSocket lifecycle](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/#welcome-message)

## Implemented local model

`src/subscription-preflight.mjs` exports `createSubscriptionPreflight({clientId, broadcasterId, readerId, now, ...policy})`. It pins the three identities. Own-channel policy defaults to reader = broadcaster; relaxing that option still pins the configured reader. No network, environment lookup or inbox/board dispatch exists.

- `acceptValidation({provenance: "synthetic", httpStatus: 200, body})` checks modeled client, user, scope and expiry. App-token null subjects fail. Replacing a receipt clears prior modeled validation, proposal and acknowledgement, even if the new receipt fails.
- `planSubscription({sessionId, welcomeReceivedAt})` returns a frozen POST proposal with the exact chat/version/condition/WebSocket body. It contains `requiresSecureAuthorization: true` and synthetic provenance, with no token, secret or headers. It sends nothing.
- `acceptAcknowledgement({provenance: "synthetic", httpStatus: 202, body})` requires exactly one enabled subscription with matching fields and a bounded ID. Acknowledgement before a proposal, malformed input or mismatches fail. The returned result does not expose the subscription ID.
- `invalidate()` clears modeled eligibility. Frozen public state reports phase and timing only, with `mode: "offline-subscription-rehearsal"`, `networkConnected: false` and `authorizationVerified: false` throughout. Recognized credential/header fields are rejected recursively without echoing their values; unrelated ordinary fields are discarded.

## Timing boundaries

Keep the clocks distinct:

- `welcomeReceivedAt`: local receipt time used for the modeled subscription window.
- `metadata.message_timestamp`: server envelope-send metadata; it must not start or extend that window.
- `keepalive_timeout_seconds`: liveness timeout; it must not silently become the subscription deadline.
- Validation receipt time plus `expires_in`: modeled token expiry, separate from the startup/hourly validation interval.
- Subscription `created_at`: server creation metadata; it must not replace acknowledgement receipt time.

The implementation requires proposal **and acknowledgement strictly before** the first local welcome receipt plus the subscription window (default/max 10 seconds). This stricter acknowledgement cutoff is **project policy**, not separately defined by the official wording. The first time/deadline is pinned per session across revalidation/invalidation; bounded history fails closed at capacity instead of permitting a replay reset. Metadata and `created_at` do not reset it.

Validation interval defaults to at most one hour; exact expiry/revalidation boundaries clear eligibility. Planning and acknowledgement also require a default 30 seconds of modeled remaining lifetime. That minimum is local policy. Once acknowledged, merely passing the subscription deadline does not invalidate the model; expiry/revalidation still does. A copied enabled acknowledgement remains unauthenticated.

## Review boundary

Local acceptance checks should reject wrong statuses, identities, scopes, transport/session, subscription fields, ordering and elapsed windows, while preserving a credential-free proposal and explicit offline provenance. Test results establish schema/state behavior only. Actual startup/hourly validation, secure token handling, subscription delivery, WebSocket lifecycle and real-channel operation remain separate work under applicable authorization. The existing inbox's structural `ready` state and the board's simulated connection control are not proof of those steps.
