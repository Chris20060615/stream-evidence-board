# Stream Evidence Board

Keep the claim, original sources, and chat's next step together.

A small tool for knowledge streams: one claim, two original-source links, a timed Twitch chat vote on which source to inspect first, a source-request cue and host-marked inspection status.

**[Watch the 92.5-second English demo](https://www.youtube.com/watch?v=jZAATw1ZT_w)** · [Source repository](https://github.com/Chris20060615/stream-evidence-board)

## Recorded behavior

The genuine own-channel take shows zero votes, `!vote a` producing A1/B0, then `!vote b` producing A0/B1 while the total stays1. `!source` brings the links into focus. Chat and board are synchronized crops from the same continuous29-second recording, at original speed and order. The video also includes actual Codex development history, labelled source/check material and a clearly labelled recorded still.

This is a single-account self-test. It does not establish an audience size, a learning effect, a latency metric or general reliability. Marking a source viewed records a host inspection, not a truth verdict. The example links to NASA Science Moon Facts and a JPL lunar laser-ranging article.

## Install

Target verified environment: Windows and Node.js24. The browser display uses ordinary HTML/CSS/JavaScript; OBS is not required.

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run start:twitch -- --help
```

Dependencies are pinned in package-lock.json. The three Twurple entry packages are8.2.0. No paid model API is used by the app.

## Own-channel Twitch test

Use your own Twitch account/channel and a Twitch **Public** application Client ID. A Client ID identifies an app; no Client Secret is used. See [Twitch's application registration documentation](https://dev.twitch.tv/docs/authentication/register-app/). Then run the following in a private interactive terminal, replacing the placeholders:

```sh
npm run start:twitch -- --client-id YOUR_PUBLIC_CLIENT_ID --channel YOUR_OWN_LOGIN --app-name "YOUR_APP_LABEL" --start
```

The default/help/plan path is inert. Explicit start asks for `START YOUR_OWN_LOGIN`; review the real app and only `user:read:chat` on Twitch's official device-activation page. The app label is operator supplied. Never publish the terminal's temporary code, credentials or tokens. Credentials remain in process memory, so restarting requires a fresh reviewed authorization. Local cleanup does not revoke the remote grant or guarantee secure memory erasure.

When the host reports receiving, open `http://127.0.0.1:4174/overlay`. This is the app's read-only aggregate display. In the private terminal type `open 120`, then send `!vote a`, `!vote b` and `!source` in that account's own channel. Expected result: A1/B0, then A0/B1 with total1, followed by a15-second source cue. Do not record the login terminal.

Other terminal commands: `close`, `reset`, `source 1 viewed`, `source 2 pending`, `status`, `quit`. Source reviews require an explicit host mark. The public display exposes aggregate counts/status, not voter IDs or raw chat. The live server has no simulated event or connection-override route.

## Boundaries and checks

One current choice is kept per account. Message-ID replay retention is bounded by five minutes/2000 entries. Intake pauses on disconnection while the original round deadline continues; missed messages are not replayed. Voting uses host receive time because the SDK callback does not provide the original EventSub envelope timestamp. Twurple handles its supported authorization/EventSub lifecycle.

The saved fresh-extraction run in `docs/validation-stage31.tap` passed539 software checks. These include synthetic external ports and SDK composition, and are distinct from the real recording. Runtime0.22.1, CLI, test, fixture, vendor and lockfile bytes match the executed build; documentation/media updates did not rerun the unchanged suite. No OBS, source-link navigation, viewed transition or outage-recovery recording is claimed.

`npm start` runs a separately labelled simulator at `http://127.0.0.1:4173/`. It cannot feed the live tally and is not presented as real Twitch evidence.

## Codex, contribution and access

Wu Dingzhou is the sole human entrant. His direction, account authorization, own-channel commands, UI feedback and supplied recordings are recorded. Codex and AI agents implemented/reviewed the code, tests and materials. See [AI usage](AI_USAGE.md), [notices](NOTICE.md) and [judge instructions](JUDGE_GUIDE.md).

Principal build session: `01a171c7-d41b-7e50-8b3c-48b3c9987dc7`. It was verified from actual local session metadata matching the original project workspace; no private transcript is bundled.

Source is shared for free evaluation under the competition rules; no new general-purpose MIT license is assigned to the entrant's original code. Third-party components retain their own licenses. YouTube publication is complete; actual Devpost submission is tracked separately and is not asserted by this source README.
