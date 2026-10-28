import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoard, DEFAULT_CARD, parseCommand } from '../src/engine.mjs';

function fixture(options = {}) {
  let time = 1_000_000;
  let sequence = 0;
  const board = createBoard({ now: () => time, ...options });
  return {
    board,
    advance: (milliseconds) => { time += milliseconds; },
    at: (milliseconds) => { time = milliseconds; },
    event: (text = '!vote a', overrides = {}) => ({
      id: `event-${++sequence}`, userId: 'simulated-viewer', text,
      origin: 'simulated', timestamp: time, ...overrides,
    }),
    open: (duration = 60_000) => {
      board.setConnection('connected');
      return board.openVote(duration);
    },
  };
}

function assertTotals(state, a, b) {
  assert.deepEqual(state.vote.counts, { a, b });
  assert.equal(state.vote.total, a + b);
  assert.equal(state.vote.uniqueVoters, a + b);
}

test('parser accepts complete, case-insensitive commands and ordinary chat is ignored', () => {
  assert.deepEqual(parseCommand('  !VoTe   A  '), { type: 'vote', choice: 'a' });
  assert.deepEqual(parseCommand('!vote b'), { type: 'vote', choice: 'b' });
  assert.deepEqual(parseCommand(' !SOURCE '), { type: 'source' });
  assert.deepEqual(parseCommand('!HELP'), { type: 'help' });
  for (const text of ['', 'hello', 'I prefer !vote a', '<img src=x onerror=alert(1)>']) {
    assert.equal(parseCommand(text).type, 'ignore');
  }
});

test('parser rejects ambiguous choices, trailing arguments, unsupported commands and oversized input', () => {
  for (const text of ['!vote', '!vote c', '!vote 1', '!vote ab', '!vote a extra', '!source extra', '!help a', '!eval 2+2', '!vote a\n!vote b']) {
    const result = parseCommand(text);
    assert.equal(result.type, 'invalid', text);
    assert.equal(typeof result.reason, 'string');
  }
  assert.equal(parseCommand('!vote a' + ' '.repeat(293)).type, 'vote');
  assert.equal(parseCommand('!vote a' + ' '.repeat(294)).type, 'invalid');
  for (const value of [null, undefined, 12, {}, ['!vote a']]) assert.equal(parseCommand(value).type, 'invalid');
});

test('new board is explicitly simulated and a connection change never claims Twitch access', () => {
  const { board } = fixture();
  assert.equal(board.getState().mode, 'simulated');
  assert.equal(board.getState().realTwitchConnected, false);
  assert.equal(board.getState().connection.status, 'disconnected');
  assert.equal(board.getState().vote.phase, 'idle');
  assert.equal(board.getState().vote.opensAt, null);
  assertTotals(board.getState(), 0, 0);
  board.setConnection('connected');
  assert.equal(board.getState().realTwitchConnected, false);
});

test('source and help remain available while disconnected and before a vote opens', () => {
  const { board, event } = fixture();
  const source = board.processEvent(event('!source'));
  assert.equal(source.ok, true);
  assert.equal(source.code, 'source');
  assert.match(source.reply, /https:\/\/science.nasa.gov\/moon\/facts\//);
  assert.match(source.reply, /NASA Science/);
  assert.equal(board.processEvent(event('!help')).code, 'help');
  assertTotals(board.getState(), 0, 0);
});

test('votes require an open window and an established simulated connection', () => {
  const { board, event } = fixture();
  assert.equal(board.processEvent(event()).code, 'vote_closed');
  assert.equal(board.openVote().ok, true);
  assert.equal(board.processEvent(event()).code, 'disconnected');
  board.setConnection('connecting');
  assert.equal(board.processEvent(event()).code, 'disconnected');
  board.setConnection('connected');
  assert.equal(board.processEvent(event()).code, 'vote_recorded');
  assertTotals(board.getState(), 1, 0);
});

test('one viewer contributes one vote, can change choice, and repeats do not inflate totals', () => {
  const { board, event, open } = fixture();
  open();
  assert.equal(board.processEvent(event()).code, 'vote_recorded');
  assert.equal(board.processEvent(event()).code, 'vote_unchanged');
  assert.equal(board.processEvent(event('!vote b')).code, 'vote_changed');
  assertTotals(board.getState(), 0, 1);
  assert.equal(board.processEvent(event('!vote a', { userId: 'second-viewer' })).code, 'vote_recorded');
  assertTotals(board.getState(), 1, 1);
});

test('duplicate event IDs cannot change viewer or choice to count twice', () => {
  const { board, event, open } = fixture();
  open();
  const original = event();
  board.processEvent(original);
  assert.equal(board.processEvent({ ...original, text: '!vote b', userId: 'imposter' }).code, 'duplicate_event');
  assertTotals(board.getState(), 1, 0);
  assert.equal(board.getState().metrics.duplicates, 1);
});

test('rejected disconnected events stay rejected when replayed after reconnect', () => {
  const { board, event } = fixture();
  board.openVote();
  const original = event();
  assert.equal(board.processEvent(original).code, 'disconnected');
  board.setConnection('connected');
  assert.equal(board.processEvent(original).code, 'duplicate_event');
  assertTotals(board.getState(), 0, 0);
});

test('malformed events, missing identities, oversized text and unsafe timestamps never count', () => {
  const { board, event, open } = fixture();
  open();
  const invalid = [
    null, [], 'not an event', event('', { id: '' }), event('', { userId: '' }),
    event('', { id: '../private' }), event('', { userId: '<script>' }),
    event('', { id: 'x'.repeat(129) }), event('', { text: 'x'.repeat(301) }),
    event('', { text: null }), event('', { timestamp: NaN }),
    event('', { timestamp: -1 }), event('', { timestamp: 1.5 }),
    event('', { timestamp: 1_005_001 }),
  ];
  for (const input of invalid) assert.equal(board.processEvent(input).code, 'invalid_event');
  assertTotals(board.getState(), 0, 0);
  assert.equal(board.getState().metrics.invalidEvents, invalid.length);
});

test('untrusted Twitch origin cannot be used to present simulated input as platform integration', () => {
  const { board, event, open } = fixture();
  open();
  for (const origin of ['twitch', 'real', undefined]) {
    assert.equal(board.processEvent(event('!vote a', { origin })).code, 'unsupported_origin');
  }
  assert.equal(board.getState().realTwitchConnected, false);
  assertTotals(board.getState(), 0, 0);
});

test('invalid commands and arbitrary chat do not mutate vote totals or execute input', () => {
  const { board, event, open } = fixture();
  open();
  assert.equal(board.processEvent(event('!vote c')).code, 'invalid_command');
  assert.equal(board.processEvent(event('<script>throw Error("executed")</script>')).code, 'ignored');
  assert.equal(board.processEvent(event('!vote a; process.exit()')).code, 'invalid_command');
  assertTotals(board.getState(), 0, 0);
});

test('window admits a vote immediately before deadline and rejects at the exact deadline', () => {
  const { board, event, advance, open } = fixture();
  open(1_000);
  advance(999);
  assert.equal(board.processEvent(event()).code, 'vote_recorded');
  advance(1);
  assert.equal(board.processEvent(event('!vote b', { userId: 'late-viewer' })).code, 'vote_closed');
  assert.equal(board.getState().vote.phase, 'closed');
  assertTotals(board.getState(), 1, 0);
});

test('reading overlay state expires a round even if no further chat arrives', () => {
  const { board, advance, open } = fixture();
  open(1_000);
  advance(1_000);
  assert.equal(board.getState().vote.phase, 'closed');
});

test('disconnect does not pause the window or admit queued votes after its deadline', () => {
  const { board, advance, event, open } = fixture();
  open(1_000);
  board.processEvent(event());
  board.setConnection('disconnected');
  advance(1_001);
  board.setConnection('connected');
  assert.equal(board.processEvent(event('!vote b', { userId: 'late-viewer' })).code, 'vote_closed');
  assertTotals(board.getState(), 1, 0);
});

test('events stamped outside current round are rejected even during its open window', () => {
  const { board, event, open } = fixture();
  open(1_000);
  assert.equal(board.processEvent(event('!vote a', { timestamp: 999_999 })).code, 'stale_event');
  assert.equal(board.processEvent(event('!vote a', { timestamp: 1_001_000 })).code, 'stale_event');
  assertTotals(board.getState(), 0, 0);
  assert.equal(board.processEvent(event()).code, 'vote_recorded');
});

test('manual close freezes totals and reopening creates a new round while retaining replay protection', () => {
  const { board, event, advance, open } = fixture();
  open();
  const original = event();
  board.processEvent(original);
  assert.equal(board.closeVote().ok, true);
  assert.equal(board.processEvent(event('!vote b')).code, 'vote_closed');
  assertTotals(board.getState(), 1, 0);
  advance(1);
  board.openVote();
  assertTotals(board.getState(), 0, 0);
  assert.equal(board.processEvent(original).code, 'duplicate_event');
  assert.equal(board.processEvent(event('!vote b')).code, 'vote_recorded');
  assertTotals(board.getState(), 0, 1);
});

test('reset removes round totals but does not permit replay of an already accepted event', () => {
  const { board, event, open } = fixture();
  open();
  const original = event();
  board.processEvent(original);
  board.reset();
  assert.equal(board.getState().vote.phase, 'idle');
  assert.equal(board.getState().connection.status, 'connected');
  assertTotals(board.getState(), 0, 0);
  board.openVote();
  assert.equal(board.processEvent(original).code, 'duplicate_event');
  assertTotals(board.getState(), 0, 0);
});

test('invalid duration, status and attempts to open an existing window preserve active round', () => {
  const { board, event, open } = fixture();
  open();
  board.processEvent(event());
  const before = board.getState();
  for (const duration of [0, -1, 999, 600_001, NaN, Infinity, '60000', 1_000.5]) {
    assert.equal(board.openVote(duration).code, 'invalid_duration');
    assert.deepEqual(board.getState(), before);
  }
  assert.equal(board.openVote().code, 'vote_already_open');
  assert.equal(board.setConnection('twitch-live').code, 'invalid_connection');
  assert.deepEqual(board.getState(), before);
});

test('dedupe TTL has an explicit boundary and replay after expiration is still one vote per viewer', () => {
  const { board, event, open, advance } = fixture({ eventTtlMs: 1_000 });
  open();
  const original = event();
  board.processEvent(original);
  advance(999);
  assert.equal(board.processEvent(original).code, 'duplicate_event');
  advance(1);
  assert.equal(board.processEvent(original).code, 'vote_unchanged');
  assertTotals(board.getState(), 1, 0);
});

test('bounded dedupe cache evicts old IDs and preserves unique-voter rules', () => {
  const { board, event, open } = fixture({ maxEventIds: 2 });
  open();
  const original = event();
  board.processEvent(original);
  board.processEvent(event('!help'));
  board.processEvent(event('!source'));
  assert.equal(board.processEvent(original).code, 'vote_unchanged');
  assertTotals(board.getState(), 1, 0);
});

test('expired dedupe entries cannot revive a previous-round timestamp', () => {
  const { board, event, open, advance } = fixture({ eventTtlMs: 1_000 });
  open(1_000);
  const original = event();
  board.processEvent(original);
  advance(1_001);
  board.openVote(1_000);
  assert.equal(board.processEvent(original).code, 'stale_event');
  assertTotals(board.getState(), 0, 0);
});

test('snapshots and constructor inputs cannot mutate private card or counts', () => {
  const card = structuredClone(DEFAULT_CARD);
  const { board, event, open } = fixture({ card });
  card.claim = 'Mutated external object';
  card.source.url = 'https://example.org/changed';
  const snapshot = board.getState();
  assert.equal(snapshot.card.claim, DEFAULT_CARD.claim);
  assert.throws(() => { snapshot.vote.counts.a = 99; }, TypeError);
  assert.throws(() => { snapshot.card.source.url = 'javascript:alert(1)'; }, TypeError);
  open();
  board.processEvent(event());
  assertTotals(snapshot, 0, 0);
  assertTotals(board.getState(), 1, 0);
});

test('public state never contains individual event IDs, viewer IDs or raw messages', () => {
  const { board, event, open } = fixture();
  open();
  board.processEvent(event('!vote a', { id: 'sensitive-event-identity', userId: 'private-viewer-identity' }));
  board.processEvent(event('raw private message do not persist'));
  assert.doesNotMatch(JSON.stringify(board.getState()), /sensitive-event-identity|private-viewer-identity|raw private message/);
});

test('card construction requires two choices and a bounded credential-free HTTPS source', () => {
  for (const url of ['javascript:alert(1)', 'http://example.org', 'https://user:password@example.org', 'not a URL']) {
    const card = structuredClone(DEFAULT_CARD);
    card.source.url = url;
    assert.throws(() => createBoard({ card }), TypeError);
  }
  for (const choices of [{ a: 'Only one' }, { a: 'One', b: 'Two', c: 'Three' }]) {
    assert.throws(() => createBoard({ card: { ...DEFAULT_CARD, choices } }), TypeError);
  }
});

test('invalid clocks and resource limits fail before a board is handed out', () => {
  for (const now of [() => NaN, () => -1, () => 1.5]) assert.throws(() => createBoard({ now }), RangeError);
  for (const options of [{ voteWindowMs: 999 }, { eventTtlMs: 0 }, { maxEventIds: 0 }, { maxEventIds: 100_001 }]) {
    assert.throws(() => createBoard(options), RangeError);
  }
});

test('many deterministic interleaved viewer changes preserve tally invariants', () => {
  const { board, event, open } = fixture();
  open();
  const expected = new Map();
  for (let index = 0; index < 500; index += 1) {
    const userId = `viewer-${index % 37}`;
    const choice = index % 7 < 3 ? 'a' : 'b';
    const input = event(`!vote ${choice}`, { userId });
    assert.equal(board.processEvent(input).ok, true);
    expected.set(userId, choice);
    if (index % 11 === 0) assert.equal(board.processEvent(input).code, 'duplicate_event');
    const a = [...expected.values()].filter((value) => value === 'a').length;
    assertTotals(board.getState(), a, expected.size - a);
  }
});
