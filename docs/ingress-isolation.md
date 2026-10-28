# Simulation and staged ingress isolation — synthetic harness

Version0.8.0 adds `src/ingress-isolation.mjs`. It separates two board instances and their caches behind distinct interfaces. **Both remain synthetic.** No capability or supplied receipt establishes OAuth, Twitch authenticity or a trusted production host. There is no new HTTP route or default activation.

## Ownership and admission

`createIngressIsolation({broadcasterId,readerId,now,card,boardOptions,leaseMs})` returns `simulation`, `staged` and `host`. The simulation facade is the original board. Staged exposes only `getState`, `openVote`, `closeVote` and `reset`, without event-ingestion or connection setters. Host owns `issue`, `deliver`, `revoke` and `stop`; it must never be exported through HTTP/controller JSON.

`host.issue({broadcasterId,readerId,sessionId,subscriptionId})` returns a frozen function tracked by private WeakMap identity. It has no JSON representation and structured cloning rejects it. Matching-looking objects, strings, another harness's capability and retired capabilities cannot substitute. Configured broadcaster/reader are pinned and must match for own-channel mode. A replacement first revokes the prior capability, even if replacement validation fails.

`host.deliver(capability,{broadcasterId,readerId,sessionId,subscriptionId,event})` requires exact scope and bounded primitive event fields `id`, `userId`, `text`, `timestamp` and `origin: transport-unverified`. Capability/scope/generation/expiry checks precede cache mutation. Admission is rechecked after inspecting input, so synchronous revoke/reissue/stop during descriptor inspection cannot let an old operation reach counting.

After admission, only a copied event enters the private second simulation engine with its internal simulated origin. Every public staged result is remapped to `mode: staged-ingress-harness`, cue origin `ingress-harness` and false network/authenticity flags. This is a synthetic tally, not an authentication upgrade.

The host facade is a local authority boundary, not a sandbox against arbitrary code in the process. Do not pass staged/host into the current generic `createApp` simulation service. Current coordinator events also contain `timestampRaw`/`deliveryId`; direct forwarding is intentionally rejected by the exact schema. A future host must privately project primitive fields and bind scope. No such automatic composition is claimed here.

## Lease, windows and replay

The default lease is60 seconds, bounded from1 millisecond to1 hour. Lease checks are lazy at operation boundaries and depend on the injected local clock. An observed expiry at the exact deadline permanently retires that capability; later clock rollback cannot revive it. This is not a guarantee against all host-clock manipulation.

Reissue preserves staged votes, the vote deadline and replay memory. Namespace caches are separate before counting: a retained ID in simulation cannot suppress a new staged event or vice versa. Within staged generations, replay protection retains the underlying TTL/capacity bounds, not permanent exactly-once processing.

Revoke, expiry and stop disconnect staged intake and clear its active cue without extending the vote window. Staged reset additionally clears the round and revokes the capability, while retaining replay memory; a fresh issue is required. Stop is terminal for that host lifetime. Staged operations never reset the simulation namespace.

Public snapshots expose aggregates, deadlines and a generation number, without scope identities, viewer IDs, raw messages or capabilities. Source/help behavior is local; no chat message is sent.

## Evidence and remaining gates

The stage-eleven checks exercise this boundary using synthetic data. The complete saved output is linked after actual execution. The earlier14-case actual Receiver experiment remains separate and is not rerun or added to the product count.

The original server/UI and unverified transport coordinator retain their prior boundaries. Production live ingress, OAuth host, real Twitch message→tally→visible overlay evidence, client handshake/automatic Pong, graceful handover and permitted browser/OBS verification remain pending.
