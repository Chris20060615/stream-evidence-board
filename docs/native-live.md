# Native own-channel Twitch entry

The explicit native entry composes memory-only device authorization, login/client/scope validation, the pinned native WebSocket client, EventSub acknowledgement and a private aggregate tally. The simulator and injected staged harness remain separate. A shipped entry and synthetic checks are not actual Twitch, OAuth or visible-overlay evidence.

## Start only after concrete operator review

`npm run start:twitch -- --help` is inert. Supply the dedicated public client ID, own public channel login and an app label to print a public plan. App labels are operator supplied; the person checks the actual registered app and scope on Twitch.

Adding `--start` requires private input/output TTYs and exact `START <own-login>` confirmation. Then the runtime requests only `user:read:chat` and displays a temporary user code in that private terminal. Open Twitch's normal activation page in the person's browser, enter the code and check the actual application before authorizing. Do not record the terminal or copy instructions into an artifact. Tokens never appear in the public outcome, aggregate API or a credential file. The runtime cannot prevent an external terminal emulator/recorder from retaining displayed instructions.

The native validation receipt must match the configured public login, client and read-only scope. The numeric user ID is derived from that receipt and fixed as both broadcaster and reader. No third-party ID lookup or pasted token is required. No outgoing chat request is implemented.

## Tally and read-only display

Only the current receiving coordinator's post-ack scoped callback can reach the live tally. Pre-ack, stale, wrong-session/channel, duplicate or retired deliveries are not treated as new votes. One current choice per viewer, changed votes, a half-open round and bounded replay retention are preserved. Source requests expose the link with a fixed15-second cue. Public state contains totals/source/status, not messages, voter lists or credentials.

The operator terminal controls `open [seconds]`, `close`, `reset`, `status`, `quit`. The loopback display is read-only GET/assets; POST, simulator/event/connection/vote-write routes are absent. It binds127.0.0.1:4174 only and checks the Host header. The native receiving/authorization state drives the connected badge; connection loss leaves a visible stale-state warning and pauses intake. The localhost product component must not be opened by the agent to evade a blocked file preview; browser/OBS rendering remains unverified.

## Lifetime and shutdown

The coordinator validates at startup and during its lifetime. Expiry, revocation, failed validation, transport loss or a server reconnect request retires intake and local ownership. Refresh and overlapping-socket handover are not implemented: a fresh reviewed restart is required and missed events are not replayed. Closing input, Ctrl+C, SIGTERM or quit owns shutdown. Local token retirement does not revoke the server-side Twitch app grant or prove secure erasure.

The reviewed CLI cancellation regression protects the waits around host start and server binding; a cancellation cannot publish an owner display then wait forever for an abort that already happened. Saved checks use synthetic host/server/terminal inputs, not a physical shutdown observation.

## Dependency and evidence scope

The bundled ws8.22.0 client preserves the exact pinned source commit297202cdae9b0590629821373b3b679c407f3431 index/library/MIT bytes. Its minimal local package.json explicitly declares CommonJS and is generated integration metadata. See [vendor pins](vendor-ws-stage29.json) and [the included MIT license](../vendor/ws/LICENSE). No npm dependency download is required.

Current focused and fresh-extraction records are linked by the canonical README. Composition tests replace external native fetch/ws with synthetic stand-ins and instrument physical network attempts as zero. Actual-client historical memory labs have a separate scope and are not rerun or added to product totals. The actual native service, private terminal authorization, physical TLS, viewer command and visible overlay still need their own observed acceptance.
