# Private typed-review confirmation

The own-channel CLI still requires actual input/output TTYs and explicit local typed review before constructing the Twitch host or requesting a device code. Type `START <own-login>` and press Enter. Surrounding whitespace is ignored; the exact phrase and own login are required. Type `CANCEL` to stop.

The fixed review deadline is five minutes. Invalid/blank lines reprompt without echoing or returning their content and never extend the original deadline. Expired input is rejected even before a delayed timer callback. Timeout, closed input and cancellation return fixed `confirmation_timeout`, `confirmation_input_closed`, or `confirmation_cancelled` codes with networkAttempted:false. The device authorization phase has its separate expiry after review succeeds.

A participant-supplied console transcript showed the old review returning generic cancelled before any device instructions. The old code used a60-second wait and collapsed mismatch/timeout/EOF/abort into one result; the transcript cannot distinguish them. No specific human mistake, network fault or Twitch authorization rejection is inferred. The new checks use synthetic event emitters/clocks and imported CLI lifecycle stand-ins, not a physical private terminal or real Twitch grant.
