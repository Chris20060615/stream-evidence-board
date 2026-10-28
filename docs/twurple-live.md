# Stream Evidence Board

A small own-channel Twitch board for deciding which source to inspect first. It keeps one claim, two original-source links, chat votes, a source cue and host-marked review status together. A viewed mark records an inspection, not a truth verdict or learning score.

## Run

Use Node.js24 or later. The checked environment is Windows/Node24.17. Install exact dependencies:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run start:twitch -- --client-id YOUR_PUBLIC_CLIENT_ID --channel YOUR_OWN_LOGIN --app-name "Your application label" --start
```

Use a Twitch Public application and only user:read:chat. No Client Secret is used. In a private unrecorded terminal, inspect the plan and type START followed by your own login, then Enter. Review the actual app and read-chat scope on Twitch's official activation page. Default/help/plan remain inert. The five-minute confirmation retries mismatched input and never auto-approves.

Temporary device instructions belong only in that private terminal. Tokens remain in memory; restart requires a new reviewed login. The app validates the client, login, user ID and exact read scope, then uses the same account as broadcaster and reader. It sends no Twitch chat messages. No paid model API or database is required.

After connection, manually open the read-only product display at http://127.0.0.1:4174/overlay. Terminal controls: open [seconds1..600], close, reset, source 1 viewed, source 2 pending, status, quit. Chat commands: !vote a, !vote b, !source. One current choice per voter can change; duplicate retention is bounded. The source cue lasts15 seconds. Disconnect pauses intake without extending the vote window. Twurple manages supported reconnect/refresh; missed messages are not replayed. Voting uses host receive time because the SDK callback omits original envelope timestamps.

The separate npm start simulator runs on loopback4173 with simulation labels. It cannot inject votes into the own-channel board. Older synthetic protocol modules/tests and the preserved native implementation remain for provenance; start:twitch selects Twurple.

## What has actually been checked

The identical0.22.1 source, CLI and lockfile passed539 software checks plus syntax after a fresh extraction/install. See the included saved [TAP](validation-stage31.tap) and [execution receipt](release-package-stage31.json). Focused/nested results and42 live samples are not added to539.

On2026-10-28, the participant's authorized knaaaris self-test produced actual receiving/auth,0 votes -> A1/B0 -> A0/B1 with total1, and a source cue. Two user-supplied screenshots were visually reviewed for readable counts and source cards across scroll positions. [The public observation summary](public-live-observation-stage34.json) retains that limited scope. No viewer study, educational improvement, latency metric, real reconnect result, polished video or award is claimed.

## Codex and reuse

Codex implemented the original board, controls, display, integration and checks. Twurple8.2 and dependencies are reused software, with exact lockfile versions and included [license notices](third-party-notices.md). AI_USAGE.md discloses the recorded build session and its final recheck requirement. The demonstration links to NASA sources; no NASA imagery or music is bundled. See NOTICE.md for attribution. This package does not assign a new license or certify ownership of the entrant's original work.

Source repository: [https://github.com/Chris20060615/stream-evidence-board](https://github.com/Chris20060615/stream-evidence-board). The source and run instructions are provided for judge review. A genuine English video under3minutes, final rights/contribution/session review and actual Submitted evidence remain to finish. No YouTube URL or submission result is claimed.
