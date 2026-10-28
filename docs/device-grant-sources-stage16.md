# Device-grant sources — stage sixteen

Checked **2026-10-25 (Asia/Shanghai)** against the primary sources below. This reviews a default-disabled development lifecycle harness with injected dependencies. Only documentation pages were fetched. No device/token/validation endpoint, account, login, consent page or OAuth grant was activated.

## Twitch contract and unresolved differences

The [Twitch device-flow section](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#device-code-grant-flow) supports public clients without a client secret.

- Device request: POST `https://id.twitch.tv/oauth2/device`; fields `client_id`, `scopes`.
- Device response: string `device_code`, `user_code`, `verification_uri`; integer `expires_in`, `interval`.
- Token request: POST `https://id.twitch.tv/oauth2/token`; `client_id`, `scopes`, `device_code`, `grant_type=urn:ietf:params:oauth:grant-type:device_code`. The table's `location` denotes the endpoint, not an additional grant value.
- Success: `access_token`, `refresh_token`, `expires_in`, `scope`, `token_type`.

The documented pending body uses `status:400` plus `message:authorization_pending`; reused-device and reused-refresh examples use `invalid device code` and `Invalid refresh token`. These are not a complete denial/slowdown error catalogue. The main polling table uses plural `scopes`, while the final example uses singular `scope`. The response table labels `scope` a string but illustrates an array. Interval prose describes requesting another code rather than clearly specifying polling. The activation example places `public=true` and `device-code` in `verification_uri`. Preserve these differences; no service response has been observed by this review. [Twitch source](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#device-code-grant-flow)

## RFC polling and user interaction

[RFC8628 sections3.1–3.5](https://datatracker.ietf.org/doc/html/rfc8628#section-3) specify TLS and form-encoded requests; generic scope spelling is singular. `interval` is optional, defaulting to five seconds. `verification_uri_complete` is optional and distinct from `verification_uri`; user-code display remains required when using the complete URI optimization.

Only `authorization_pending` and `slow_down` permit continued polling. Pending preserves the required interval; slowdown adds five seconds for that and every subsequent request. `access_denied`, `expired_token` and other errors stop polling. Before repeated requests, respect the returned/default interval and accumulated increases. Connection timeouts require a reduced polling frequency; exponential backoff is recommended. Automatic restart after expiration is discouraged without user interaction. These are RFC rules, not a claim that Twitch documents every matching wire error. [RFC8628 section3.5](https://datatracker.ietf.org/doc/html/rfc8628#section-3.5)

The verification URI is an authorization-server user-interaction location, not this project's localhost callback. RFC discourages putting the code in ordinary `verification_uri`; Twitch's shown URI does contain it. An implementation must preserve that documented case without accepting arbitrary destinations. [RFC8628 sections3.2–3.3.1](https://datatracker.ietf.org/doc/html/rfc8628#section-3.2)

RFC8628 incorporates [RFC6749 sections5.1–5.2](https://datatracker.ietf.org/doc/html/rfc6749#section-5.1): standard errors use `error`, with optional `error_description`/`error_uri`. Token type is case-insensitive; refresh tokens are optional, expiry is recommended and identical requested scope can be omitted. A strict projected-receipt harness is narrower than this general response format; optional diagnostic fields must not become public error text or navigation targets.

## Refresh source and limits

The [refresh reference](https://dev.twitch.tv/docs/authentication/refresh-tokens/#how-to-use-a-refresh-token) specifies POST to the token endpoint with `client_id`, `grant_type=refresh_token` and URL-encoded `refresh_token`; `client_secret` is unnecessary for a registered public client. Store replacement values because refresh tokens may change. Its overview's authorization-code-only wording conflicts with the device section's public-client refresh support. Its public-token lifetime is described from generation; the device page describes inactivity. Do not hardcode a refresh-token lifetime or claim either interpretation was service-tested. Access lifetime comes from the returned `expires_in`. The refresh reference recommends one refresh owner for concurrent consumers. [Refresh source](https://dev.twitch.tv/docs/authentication/refresh-tokens/)

## Local policy, separate from the sources

The following source-reviewed harness restrictions are local choices, not universal Twitch/RFC requirements or completed OAuth integration. The separate [lifecycle contract](device-grant.md) describes the API and limits.

- Explicit injected device/poll adapters returning bounded projected receipts, no default fetch or activation. Fixed POST proposals do not make a network call. Private prompt/grant hooks are distinct from public state. Any later validation uses the separate existing validation boundary.
- Exact `user:read:chat` and a refresh token are local restrictions. Access lifetime requires positive safe seconds and safe deadline arithmetic, without the device's one-hour cap. This harness adds no minimum-remaining gate; the existing coordinator's later minimum-remaining check is separate local policy, alongside identity validation.
- A conservative wait before the first poll, one-hour device-lifetime cap and finite field/interval limits are local restrictions. Device expiry uses device-request start plus `expires_in`, not response receipt. Device/poll/callback timeout is terminal with no automatic retry; RFC backoff applies if retries are later implemented.
- Restrict activation to HTTPS `www.twitch.tv/activate`, without credentials, ports or fragments. Any permitted `public`/`device-code` query must be bounded, unique and consistent with the received user code. Exact host/path/query rules are local allowlisting, not provenance proof. Never open a browser automatically.
- Keep device codes and token values private; deliver any user-code/activation instructions only through a privileged local hook, not public state/logs. Use fixed error projections, one outstanding poll, an unchanged code deadline, abort/deadline races and generation checks that reject late results.

A token-shaped injected success still needs separate identity/scope validation and applicable human authorization. It must not set real/authenticity flags or activate the staged tally, simulator HTTP/UI or a production issuer. Source review does not replace saved synthetic checks or actual service validation.
