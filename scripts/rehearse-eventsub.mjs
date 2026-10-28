import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { createEventSubInbox } from '../src/eventsub-inbox.mjs';
import { createBoard } from '../src/engine.mjs';

// This command opens only its bundled synthetic fixture; it has no network or
// credential path. Neither protocol parsing nor a fixture authenticates Twitch.
const fixture = JSON.parse(await readFile(new URL('../fixtures/synthetic-eventsub.json', import.meta.url), 'utf8'));
assert.equal(fixture.provenance, 'synthetic');
let clock = Date.parse(fixture.clockStart);
const startedAt = clock;
const inbox = createEventSubInbox({ ...fixture.configuration, now: () => clock });
const board = createBoard({ now: () => clock });
board.setConnection('connected');
board.openVote();
let normalized = 0;
let rejectedBySimulationBoundary = 0;
const steps = [];
for (const step of fixture.frames) {
  clock = startedAt + step.elapsedMs;
  const result = inbox.receive(JSON.stringify(step.frame));
  if (result.event) {
    normalized += 1;
    const boundary = board.processEvent(result.event);
    assert.equal(boundary.code, 'unsupported_origin');
    rejectedBySimulationBoundary += 1;
  }
  steps.push({ label: step.label, code: result.code, eventNormalized: Boolean(result.event) });
}
assert.equal(normalized, 1);
assert.equal(rejectedBySimulationBoundary, 1);
assert.equal(inbox.getState().networkConnected, false);
assert.equal(inbox.getState().phase, 'revoked');
assert.equal(board.getState().vote.total, 0);
console.log(JSON.stringify({
  provenance: 'synthetic',
  mode: 'offline-protocol-rehearsal',
  realTwitchConnected: false,
  normalizedSyntheticMessages: normalized,
  untrustedEventsRejectedByBoard: rejectedBySimulationBoundary,
  boardVotes: board.getState().vote.total,
  steps,
  finalProtocolState: inbox.getState(),
  assertions: 'passed'
}, null, 2));
