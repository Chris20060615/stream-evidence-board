# Private device and token HTTP ports

Version0.13.0 adds `src/device-grant-http.mjs` for the injected [device-grant harness](device-grant.md). The new module has no default fetch, browser navigation, account/application registration, credential store or automatic host binding. Checks use an injected fake fetch and synthetic values. No actual OAuth request or consent is established.

## Interface and request ownership

`createDeviceGrantHttpAdapters({clientId,fetch,timeoutMs?,setTimer?,clearTimer?})` returns a frozen `{device,poll}` facade. Both functions accept `{request,signal?}` and privately resolve to `{httpStatus,body}`. Fetch injection is required; client IDs are bounded alphanumeric strings. The default operation timeout is five seconds, with an allowed range of one millisecond to sixty seconds. A native caller AbortSignal is optional.

The request must match the harness's own-data proposal exactly: `POST https://id.twitch.tv/oauth2/device` with `client_id` and `scopes`, or `POST https://id.twitch.tv/oauth2/token` with those fields plus `device_code` and `grant_type`. The client must match the configured value, scope is exactly `user:read:chat`, and the token grant type is `urn:ietf:params:oauth:grant-type:device_code`. Unknown request/body fields, accessors and changed pins fail before fetch. Copied primitive fields are serialized once with URLSearchParams; caller objects are not reread during serialization.

Fetch receives fixed POST options: one `application/x-www-form-urlencoded` content header, `redirect: error`, `credentials: omit`, `cache: no-store` and the operation's private native abort signal. There is no client secret, Authorization header, cookie injection or caller-controlled URL/header option. This is the selected public-client device/poll boundary, not a general OAuth or refresh client.

## Private responses and errors

**The returned receipts are private adapter-to-harness inputs.** Successful device receipts contain the device/user codes and activation URI; successful token receipts contain access and refresh values. They must not be logged, exposed as public state or sent to the controller, overlay or chat. This module does not make a private successful grant safe for public disclosure. The harness separately projects its public state and keeps all authenticity/network flags false after synthetic success.

Only bounded own-data shapes are accepted. A device200 response projects the code, user code, official activation address, expiry and optional interval. Device expiry/interval are bounded to one hour; only the documented bounded activation query form is allowed. A token200 response requires bounded access/refresh strings, safe positive access-lifetime seconds, exact one-element read-scope array and bearer type. Requiring refresh and this exact array is local policy, not acceptance of every possible service shape. The [source review](device-grant-sources-stage16.md) retains official-document differences and policy distinctions.

Poll400 responses retain only recognized RFC error codes, or Twitch's documented pending/invalid-device-code message shapes. Service error descriptions and error URIs are discarded, including when accepted as bounded input. Unknown error bodies become an empty projected body so the harness terminates them. Other valid HTTP statuses project an empty body without reading it. These receipts do not echo arbitrary service text. Malformed successful responses and transport/decode failures throw fixed local error messages without raw causes, responses, request values or credentials.

## Streaming, cancellation and cleanup

Relevant response bodies must expose a reader. The accepted cumulative byte limit is65,536 bytes, with at most65,537 read attempts, fatal UTF-8 decoding and JSON parsing after the bounded read. Actual typed-array view length is counted through the native getter, which does not consult an own `byteLength` property or invoke its getter. Counting alone did not isolate original-view streaming decode in earlier versions. Invalid chunk brands, malformed UTF-8/JSON and oversized bodies fail with fixed errors. The limit bounds accepted/decoded bytes here; it does not bound allocations already made by the injected fetch implementation.

Version0.17.0 passes only clean native spans to the streaming decoder: after cumulative size checks, intrinsic buffer/byteOffset getters and the captured actual length construct a new Uint8Array over that exact range. Original view properties/accessors, iterators and species cannot redirect decoded bytes. Native offsets and split UTF-8/BOM state are retained. Descriptor, brand and span inspection recheck cancellation; proxy/revoked brands fail with fixed invalid_response, and cancellation observed at those boundaries prevents subsequent owned reads or receipt publication. Backing bytes are not frozen or securely erased, and the injected host remains trusted.

One referenced operation deadline covers both fetch and the complete body read. A pre-aborted caller never starts fetch. Cancellation or timeout retires admission, aborts the owned signal and requests nonblocking stream/reader cancellation. Late responses are observed and discarded; late reads cannot revive a retired operation. Rejected cleanup promises are observed without waiting for them, and cleanup cannot replace a fixed public error with dependency text. A fetch implementation that ignores abort or a callback that already retained private values cannot be physically cancelled or recalled by this module.

Injected fetch/reader/timer code remains trusted rather than sandboxed. Native promises and synchronous dependency values are supported; arbitrary thenables are not invoked. Own references are dropped on settlement, without a secure-erasure or dependency-copy guarantee. No browser preview workaround is used.

## Evidence boundary and next work

The new focused checks cover exact form bytes/pins, malformed and oversized streams, cancellation/deadlines, private projection and a fake-fetch port-to-harness-to-vault composition. Fresh-candidate product checks and syntax records are linked from the canonical README. They are software evidence only: no endpoint, real grant, refresh acceptance, identity validation, WebSocket handshake/Pong, Twitch message or browser/OBS result follows from them.

At stage seventeen/version0.13.0, the older validation/subscription HTTP module remained unchanged. Static review identified that its byte cap still read a shadowable chunk `byteLength`; the new port's intrinsic-getter hardening did not apply to that older module. That historical snapshot retained a separate source/test followup before real-host integration. Actual account/application/OAuth consent and publishing/submission remain separate human-authorized gates.

Version0.14.0 addressed that retained followup in the [validation/subscription HTTP module](http-adapters.md#body-boundary-hardening-in0140), with separate pre-fix and repaired synthetic regressions; this device/token source stayed unchanged at that time. Version0.17.0 separately repairs streaming view isolation in both HTTP modules. Old archives remain unchanged, and neither local repair supplies actual service or authorization evidence.
