# Operator login and identity preflight

This is a real operator entry point for a one-time device login and own-channel identity check. It stops before EventSub, chat intake, a board or an overlay. The simulator remains separate. No actual OAuth request or Twitch connection has been executed for the saved verification.

## Default and explicit authorization

`node scripts/authorize-twitch.mjs --help` prints usage without network activity. With public client ID, own numeric channel/user ID and an operator-supplied app label, it prints the fixed read-chat plan. There is no token/secret argument, credential file or saved-browser-credential reader.

Adding `--authorize` requires both input and output to be interactive terminals, then the exact typed review `AUTHORIZE <own numeric id>` within60seconds. Device requests begin only after that review. The operator must independently check the actual application name and `user:read:chat` scope on Twitch's authorization page; an operator-supplied label is not verified app identity. Do not record the terminal or copy temporary codes into project artifacts. The private prompt prints only a temporary user code and the fixed Twitch activation address. A terminal emulator or external recorder may retain displayed instructions.

Existing bounded device/token/validation ports use native fetch only in the explicit executable. The validation adapter checks the configured client/user ID, expiry and read-chat scope. Ctrl+C, cancelled review and failed identity validation end local work. Success still reports `chatConnected:false`, `boardStarted:false`, `credentialsPersisted:false`.

## Grant lifetime and limits

This preflight intentionally discards its tokens and cannot carry a logged-in session into a later live board. Local vault retirement is not a remote OAuth revocation; the application grant may remain on Twitch until the operator disconnects it in Twitch connection settings. The command makes no remote-revocation request and does not claim secure memory erasure. Use a future complete live entry for a reusable chat session rather than treating this diagnostic as setup completion.

## Saved checks and sources

The [focused output](validation-stage28-focused.tap) records9 passing checks using synthetic streamed HTTP, manual timing and pretend in-memory TTYs, plus CLI help/redirected-input behavior. No real device code/token, service request, terminal recording, browser or audience is evidence here. The [implementation record](operator-login-stage28.json) and [source review](operator-login-review-stage28.json) retain scope. The fresh package proof is linked from the canonical README.

Official sources reread2026-10-26: [device code grant](https://dev.twitch.tv/docs/authentication/getting-tokens-oauth/#device-code-grant-flow), [token validation and connection settings](https://dev.twitch.tv/docs/authentication/validate-tokens/). A future maintained OAuth session must validate at startup and hourly thereafter; this diagnostic exits after its single validation.
