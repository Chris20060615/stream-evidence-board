# Fixed-endpoint HTTP adapters — dependency-injected development module

Version0.6.0 adds `src/twitch-http-adapters.mjs`. It implements the two HTTP ports used by the session coordinator: token validation and read-chat subscription creation. Importing the module performs no request. Its factory requires an explicitly injected fetch function and synchronous private credential resolver; it has no global-fetch fallback, environment/file credential reader, OAuth grant, refresh operation or WebSocket implementation. The simulator does not import or activate it.

## Request boundary

`createTwitchHttpAdapters({fetch, resolveCredential, clientId, broadcasterId, readerId, timeoutMs, setTimer, clearTimer})` returns `validate({credential,signal})` and `subscribe({credential,request,signal})`. The coordinator supplies an opaque credential handle; only the resolver knows its private mapping. The resolved value is used in the outgoing Authorization header. No token is accepted from an HTTP/controller field or put into an endpoint URL.

Validation is a fixed GET to `https://id.twitch.tv/oauth2/validate`, using **Authorization: OAuth**. Subscription is a fixed POST to `https://api.twitch.tv/helix/eventsub/subscriptions`, using **Authorization: Bearer**, pinned **Client-Id**, and JSON. The request must have the exact read-chat type/version, configured broadcaster/reader and WebSocket session; unsupported endpoints, extra request fields and accessor properties are rejected before resolving credentials or calling fetch. Redirects are rejected and cookies omitted. These rules do not authorize a caller to activate the module.

Successful receipts are frozen projections, sufficient for the coordinator's existing checks. Validation returns pinned client/reader, required read scope and expiry. Other granted scopes and service fields are not copied. Subscription returns only one matching enabled acknowledgement and its pinned condition/transport fields. Non-success statuses expose an empty body; arbitrary error bodies, headers, dependency exceptions and nested causes are not returned.

## Cancellation and response boundary

The default operation deadline is five seconds. An external abort and the local timeout cover both fetch and streaming body reads. Races settle even if the injected implementation ignores its signal. Per-operation deadlines keep a standalone Node process alive until settlement, then are cleared; the coordinator's adapter-I/O deadlines use the same rule. Late responses are cancelled; cleanup does not wait forever on an uncooperative cancellation promise. A stream is read as bytes with a cumulative64KiB limit, strict UTF-8 decoding and JSON parsing. This cap bounds accepted/retained body data; it does not claim to prevent a fetch implementation allocating one oversized chunk before delivering it.

The module drops private references after the operation. JavaScript memory cannot be certified as securely erased. A host-supplied fetch/resolver can observe the secret by design and remains inside the trusted host boundary; this module is not a sandbox for malicious host code. The checks use synthetic canaries, never a real credential.

## Body-boundary hardening in0.14.0

The validation and subscription ports share the repaired stream path. Each read result must be an own-data object containing boolean `done` and optional `value`; normal `done:true` results may omit a value. Accessor fields, extra fields and invalid result shapes are rejected with a fixed error. The chunk view is captured once, then used for brand checking, native size counting and decoding. The implementation rechecks cancellation after inspecting externally supplied descriptors and brands.

The cumulative65,536-byte limit uses the native typed-array `byteLength` getter rather than a chunk's shadowable property. That counting step cannot be changed by an own length property/getter and does not invoke it. Subarray offsets count the actual delivered view, without charging an unrelated backing-buffer allocation. Invalid or proxied typed-array brands are rejected. The size check precedes UTF-8 decoding; a rejected oversized chunk is not admitted for decoding. There remain at most65,537 read attempts. These limits apply to accepted/decoded stream bytes, not memory already allocated by a fetch implementation. Counting alone did not isolate the subsequent original-view streaming decode; version0.17.0 below addresses that separate boundary.

Both owned-reader and late-response fallback `releaseLock` returns are observed when they are native promises, with rejection suppressed and no wait for completion. Other cleanup returns are also observed using native Promise operations; arbitrary cleanup thenables/getters are not assimilated. The earlier fetch/read Promise assimilation remains unchanged. This patch does not sandbox injected readers, fetch, timers or other host code, nor guarantee physical cancellation or secure erasure.

The stage-eighteen regression record preserves actual pre-fix execution against the immutable prior source and a separate repaired-source execution. All responses and credential values in those checks are synthetic. The old0.13.0 archive is preserved; this repair does not retroactively change its behavior or evidence.

## Clean streaming spans in0.17.0

After counting each chunk's actual bytes, the ports use intrinsic typed-array buffer and byteOffset getters to construct a clean Uint8Array over precisely that bounded span. Only this clean view reaches the streaming decoder. Caller-provided buffer/offset/length properties, accessors, iterators and species cannot substitute other bytes or execute during decoding. The decoder still preserves UTF-8/BOM state between chunks, and cumulative limits are unchanged.

Native span construction and host-controlled descriptor/brand interactions are followed by active-state checks. Detached, proxied or invalid view brands have fixed response errors; real decoding failures retain fixed UTF-8 errors. This does not make fetch/reader code a sandbox, freeze backing bytes or establish actual service provenance.

The same new synthetic regression file runs against preserved old modules and the repair. It distinguishes view-content substitution or getter effects from an actual byte-cap bypass; earlier actual cumulative limits remain separate. The canonical README links saved observations and the new extraction record. No real token or endpoint is used.

## Evidence and remaining gaps

Tests inject in-memory responses and timers; no Twitch endpoint is contacted. The stage-eight report records the actual check result after execution. These checks establish local request construction, projection, bounds, cancellation and fixed-error behavior. They do not prove that Twitch accepted a token or created a subscription.

The session coordinator still emits `transport-unverified`, which the board rejects. There is no production host, installed/activated WebSocket client, trusted live ingress, graceful two-socket handover, participant account/app/OAuth authorization, or actual Twitch/browser/OBS evidence. Version0.7.0 adds a separate injected socket port and a client source review; this does not supply actual client/network evidence. `npm start` remains the simulator. The stage-seven implementation contract is a preserved plan snapshot; this module completes only its HTTP-port work segment.

Request semantics were checked against primary documentation on2026-10-25: [validate tokens](https://dev.twitch.tv/docs/authentication/validate-tokens/), [create EventSub subscription](https://dev.twitch.tv/docs/api/reference/#create-eventsub-subscription), [chat authentication](https://dev.twitch.tv/docs/chat/authenticating/). The documented scopes and separate send-chat permission remain distinct. No outbound chat capability is added.
