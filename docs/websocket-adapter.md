# Restricted WebSocket port — injected development module

Version0.7.0 adds `src/twitch-websocket-adapter.mjs`. It requires an explicit synchronous `createSocket(url, options)` factory with the Node `ws` event interface. It imports no WebSocket client, reads no credentials and is not activated by the simulator. The separately recorded [client source review](websocket-source-review.md) describes a candidate host implementation; source inspection is not a run of that library or an actual Twitch connection.

## Connection boundary

`createTwitchWebSocketAdapter({createSocket, connectTimeoutMs, maxPendingFrames, setTimer, clearTimer})` returns the coordinator-compatible `connect({onFrame,onDisconnect,onError,signal})`. Connect resolves only after open, with a frozen handle whose `close()` returns promptly. The default connection deadline is five seconds and remains referenced until settlement. Cancellation, timeout, an error and closure before open reject with a fixed local error and no original cause. A late open cannot revive a stopped connection.

The only initial address is `wss://eventsub.wss.twitch.tv/ws`. Options require `maxPayload:65536`, `maxFragments:1024`, `maxBufferedChunks:1024`, `perMessageDeflate:false`, `followRedirects:false`, `autoPong:true`, `skipUTF8Validation:false` and a matching handshake timeout. The fragment/chunk counts are local policy verified in the reviewed client source, not Twitch requirements or a promise to prevent every allocation. No token, cookie, custom header, application send or URL parameter is accepted through this port. Automatic protocol Pong belongs to the selected client, not a chat-send feature.

The factory is inside the trusted host boundary. Passing an option cannot force an arbitrary injected implementation to honor it. The wrapper independently limits accepted message bytes **after delivery** and cannot prevent that implementation from allocating a large frame first. Source-reviewed receive limits and the separately recorded direct-client memory experiment have their own evidence scope; the latter does not integrate this restricted wrapper with an actual client or WSS/TLS service.

## Delivery and failure boundary

Only text messages are forwarded, using the `ws` `(data,isBinary)` signature. Byte data is decoded with strict UTF-8; accepted text is capped at64KiB of encoded bytes. Binary, malformed or oversized messages terminate intake. No arbitrary event objects, raw failures or close reasons are exported.

Version0.16.0 hardens this byte boundary. Intrinsic typed-array getters capture actual view byteLength, byteOffset and buffer; the65,536-byte check occurs before decoding. A new clean Uint8Array view over that exact span goes to TextDecoder, so input own buffer/offset/length properties, iterators and species are not consulted by decoding. Real Uint8Array and Buffer views keep their actual content/offset; a larger backing allocation is not itself the delivered message size. Proxied/revoked or invalid brands fail with fixed invalid_frame. Strings retain the existing encoded-byte and malformed-UTF16 checks.

After host-controlled brand/prototype interactions, callback admission rechecks connection activity and the pending-callback limit. A synchronous abort cannot be followed by delivery from that retired message, and a nested message cannot consume a slot while the outer message later bypasses the limit. This is a local admission check, not a sandbox against arbitrary factory or callback code. The same new regressions are executed against a preserved old source and the repaired source; baseline failures retain their actual observed callback lengths/errors.

`onFrame` is invoked promptly instead of being serialized behind its preceding promise. A pending welcome/subscription operation must not block a subsequent keepalive. Outstanding callbacks are bounded, by default32; overload or a thrown/rejected callback stops the connection and reports a fixed error. This is bounded concurrent delivery, not a durable queue or replay system. Host callbacks may retain their own references or ignore cancellation; the port cannot forcibly stop arbitrary host code.

On terminal state, listeners, timers and callback references are cleared, while a module-level no-op error listener prevents an otherwise unhandled late `error` event. It captures no session callbacks. Transport closure calls `onDisconnect` without raw data; transport/validation failure calls `onError` with a new fixed local error. A host-requested close does not call the disconnect hook. Close/terminate and cleanup errors cannot block settlement or echo private data.

## Evidence and remaining gaps

Tests use synthetic EventEmitters, byte buffers, clocks and HTTP replies. Composition with the actual HTTP adapter and coordinator modules remains offline. The coordinator still emits `transport-unverified`; a successful synthetic command cannot enter the current vote engine. The stage-nine report records the actual saved results after execution.

No production host or default network path, OAuth grant, trusted live ingress or graceful overlapping-socket handover is added. A reconnect request still freezes the coordinator. The separate stage-twenty direct ws client experiment observed memory HTTP upgrade and automatic matching masked Pong; it did not exercise this wrapper, OS networking, WSS/TLS or Twitch. Participant account/app authorization, real-channel message → tally → overlay capture, this wrapper's actual remote-service composition and browser/OBS checks remain pending. No audience, sent chat reply or service success is inferred from these tests.

## Separate actual-client memory composition (stage twenty-three)

The standalone wrapper-memory lab now executes this unchanged wrapper with the pinned actual ws client and unchanged constructor address/options, adding only a memory connection factory. Saved canonical results record actual memory upgrade, text delivery and automatic matching masked Pong plus failure/abort controls. This closes the narrow wrapper/client memory-composition gap; it does not activate this module in the simulator or establish TLS/certificate, remote platform, authorized identity/subscription, trusted live ingress or visible UI behavior. Historical direct-client evidence remains separate. See the input contract retained with the separate historical lab and the canonical README for actual result/review references. The lab archive preserves the earlier contract snapshot as reproducible input.
