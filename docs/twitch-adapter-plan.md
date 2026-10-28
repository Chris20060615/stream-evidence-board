# EventSub adapter contract: offline rehearsal

Official documentation checked **2026-10-25, Asia/Shanghai**. This document separates the implemented offline guard in `src/eventsub-inbox.mjs` from future transport work. No account, OAuth grant, socket connection, subscription or real channel test was created. See `protocol-rehearsal.md` for the fixture runner.

## Authorization path for a future installed reader

Use the installed-chatbot model: one **User Access Token**, with `user:read:chat` for receiving chat. `user:write:chat` is optional and belongs to a later approved chat-sending feature. `user:bot` and `channel:bot` requirements for cloud/app-token designs should not be copied into this installed reader. EventSub WebSocket subscriptions use user tokens, not app tokens. The subscription condition names the target broadcaster and the user reading chat. [Authenticating and EventSub](https://dev.twitch.tv/docs/chat/authenticating/)

The implemented inbox pins a configured broadcaster, reader and subscription; its numeric fixture IDs establish no account ownership. A future authorized transport must bind the reader to the validated token subject and the broadcaster to the approved channel. The reader is not each event's chatter. A first own-channel test may use the broadcaster as reader; the guard does not require that equality.

Real integration must validate at startup and hourly with `GET https://id.twitch.tv/oauth2/validate`. The response exposes `client_id`, `user_id`, `scopes` and `expires_in`; invalid tokens return 401. Check expected client and subject, required scope, and a positive expiry. Validation failure ends associated sessions. Do not store access tokens in board state, logs, fixture files or browser code. [Validating Tokens](https://dev.twitch.tv/docs/authentication/validate-tokens/)

Reading permission does not authorize sending a `!source` reply. The guard does not invoke the command engine or send replies. A future sender needs approved `user:write:chat`, a matching sender identity, and actual `is_sent`/drop-result checks. [Scope reference](https://dev.twitch.tv/docs/authentication/scopes/), [Send Chat Message](https://dev.twitch.tv/docs/api/reference/#send-chat-message)

## Future subscription work

The selected subscription is `channel.chat.message`, version string `"1"`; it requires `user:read:chat`. [Subscription type](https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelchatmessage)

The separate v0.3.0 offline preflight now proposes this body from synthetic validation and welcome timing. After a future authorized socket welcome, a real transport would securely send it:

```json
{
  "type": "channel.chat.message",
  "version": "1",
  "condition": {
    "broadcaster_user_id": "CONFIGURED_CHANNEL_USER_ID",
    "user_id": "VALIDATED_READER_USER_ID"
  },
  "transport": {
    "method": "websocket",
    "session_id": "WELCOME_SESSION_ID"
  }
}
```

The real operation is `POST https://api.twitch.tv/helix/eventsub/subscriptions` with the user bearer token and matching Client-Id. Expected creation response is 202; verify the returned subscription identity, fields and enabled status. The inbox itself has no HTTP or acknowledgement path; the separate [offline preflight](subscription-preflight.md) checks synthetic proposals/receipts only. No actual request is sent or authorization verified. The inbox's `ready` phase proves frame structure only. [Create EventSub Subscription](https://dev.twitch.tv/docs/api/reference/#create-eventsub-subscription)

## Envelope and chat normalization

`receive(rawString)` accepts a bounded JSON **string** containing object `metadata` and `payload`. It dispatches welcome, keepalive, notification, reconnect and revocation; unsupported kinds fail without refreshing the watchdog. Twitch envelope IDs identify at-least-once deliveries: redelivery keeps `metadata.message_id`. Timestamps support RFC3339 nanosecond precision. [WebSocket message reference](https://dev.twitch.tv/docs/eventsub/websocket-reference/)

For chat, require both metadata and subscription type/version to match `channel.chat.message` / `1`; require subscription status enabled, the configured broadcaster/reader condition, and the expected WebSocket session transport. Require the event broadcaster to match. The source fields are `event.chatter_user_id`, `event.message_id` and `event.message.text`; the chat ID differs from the envelope ID. `metadata.message_timestamp` is the envelope send time, not a separately documented chat-creation time. Shared chat may populate `source_broadcaster_user_id` and `source_message_id`. [EventSub condition and event fields](https://dev.twitch.tv/docs/eventsub/eventsub-reference/#channel-chat-message-event)

The following are **implemented local guard policies**, beyond the wire format:

1. Validate structure, lengths, identities and timestamp before replay-cache insertion. Malformed input still increments rejection diagnostics. Defaults cap frames at 65,536 UTF-8 bytes and chat text at 300 characters. Conditions must contain exactly the configured broadcaster and reader keys.
2. Retain `timestampRaw`; emit integer `timestamp` milliseconds with submillisecond truncation. Freshness comparisons preserve nanoseconds against the injected millisecond clock. Default maximum age is 60 seconds; future tolerance is five seconds. Reject invalid calendar timestamps and leap seconds. These are local admission rules, not delivery guarantees.
3. Deduplicate envelope IDs and chat IDs separately, with default capacity 2,000 per cache and five-minute TTL. Each inbox pins one broadcaster, so chat IDs need no additional channel namespace. Valid fresh duplicates refresh local liveness but emit no event. The caches do not provide permanent exactly-once processing.
4. Exclude an external Shared Chat source. A notification's broadcaster, reader, subscription ID and session transport must match configuration.
5. Emit exactly `{id: event.message_id, userId: event.chatter_user_id, text: event.message.text, timestamp, timestampRaw: metadata.message_timestamp, deliveryId: metadata.message_id, origin: "eventsub-unverified"}`. This provenance is intentionally rejected by the existing board with `unsupported_origin`; fixture normalization must produce zero votes.
6. There is no engine dispatch, HTTP intake route, credential loading, URL navigation or fragment rendering. State always reports `mode: "protocol-rehearsal"` and `networkConnected: false`.

## Lifecycle facts and local actions

The service endpoint is `wss://eventsub.wss.twitch.tv/ws`. Initial welcome supplies the session ID; subscribe within the default **10 seconds**. Notifications and keepalive reset the welcome-specified keepalive timer; if silence exceeds it, assume loss and resubscribe after a fresh connection. Ping/Pong is separate and does not reset that timer. Unexpected loss has no replay of missed events. A server `session_reconnect` gives **30 seconds**: use the supplied URL unchanged, retain the old socket until new welcome, and migrate existing subscriptions. Sending application messages on the socket is prohibited. [Handling WebSocket events](https://dev.twitch.tv/docs/eventsub/handling-websocket-events/)

Implemented phases are `awaiting_welcome` → `ready` after structural welcome, followed by terminal `reconnect_requested`, `revoked`, `timed_out` or `closed` when applicable. Keepalive refreshes the local receive-clock watchdog. Silence must exceed the exact deadline to time out. Reconnect returns an unmodified URL action only after validating the official WSS host, then conservatively freezes intake. Further frames require a new rehearsal instance; no second socket or migration is implemented. Rehearsal state never changes the board's simulated connection control.

A revocation identifies the subscription and reason. Known statuses include `authorization_revoked`, `user_removed` and `version_removed`. The guard freezes for any matching non-enabled status satisfying its bounded lowercase/underscore format. [Revocation schema](https://dev.twitch.tv/docs/eventsub/websocket-reference/#revocation-message)

## Acceptance evidence still required

Offline checks cover frame rejection, identity/time guards, replay handling, welcome ordering, watchdog boundary, terminal states and rejected board intake. Their output proves local behavior only. OAuth validation, the welcome-to-subscribe deadline, subscription acknowledgements, Ping/Pong, graceful two-socket handoff, token renewal and any chat-sending feature remain future transport work. A later authorized channel test must separately prove real subject/scope, successful subscription, actual chat command, tally update and OBS/Twitch-visible overlay without exposing credentials or unrelated chat.
