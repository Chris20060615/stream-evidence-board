import test from 'node:test';
import assert from 'node:assert/strict';
import { createBoard } from '../src/engine.mjs';

// Every request is synthetic local chat. These tests do not contact Twitch,
// authorize a viewer, render OBS, or claim that an overlay was seen on stream.
const BASE_TIME = 1_000_000;
const DEFAULT_CUE_MS = 15_000;

function fixture(options = {}) {
  let time = BASE_TIME;
  let sequence = 0;
  const board = createBoard({ now: () => time, ...options });
  const event = (overrides = {}) => ({
    id: `synthetic-source-${++sequence}`, userId: 'synthetic-viewer',
    text: '!source', origin: 'simulated', timestamp: time, ...overrides,
  });
  function source(overrides = {}) { return board.processEvent(event(overrides)); }
  function connected() { board.setConnection('connected'); }
  return {
    board, event, source, connected,
    advance: (milliseconds) => { time += milliseconds; },
  };
}

function assertInactive(cue, count = 0) {
  assert.deepEqual(cue, {
    active: false, requestedAt: null, expiresAt: null,
    requestCount: count, origin: 'simulated',
  });
}

function assertLocalReply(result) {
  assert.equal(result.ok, true);
  assert.equal(result.code, 'source');
  assert.match(result.reply, /NASA Science/);
  assert.match(result.reply, /https:\/\/science.nasa.gov\/moon\/facts\//);
}

test('initial source cue is inactive with explicit simulation provenance', () => {
  const f = fixture();
  assertInactive(f.board.getState().sourceCue);
  assert.equal(f.board.getState().mode, 'simulated');
  assert.equal(f.board.getState().realTwitchConnected, false);
});

test('connected source command opens a 15-second cue while voting remains idle', () => {
  const f = fixture(); f.connected();
  const result = f.source();
  assertLocalReply(result);
  assert.equal(result.sourceCuePublished, true);
  assert.equal(result.sourceCueReason, 'opened');
  assert.deepEqual(result.state.sourceCue, {
    active: true, requestedAt: BASE_TIME, expiresAt: BASE_TIME + DEFAULT_CUE_MS,
    requestCount: 1, origin: 'simulated',
  });
  assert.equal(result.state.vote.phase, 'idle');
  assert.equal(result.state.vote.total, 0);
});

test('disconnected and connecting source commands retain the local source reply without publishing', () => {
  for (const status of ['disconnected', 'connecting']) {
    const f = fixture(); f.board.setConnection(status);
    const result = f.source();
    assertLocalReply(result);
    assert.equal(result.sourceCuePublished, false);
    assert.equal(result.sourceCueReason, 'disconnected');
    assertInactive(result.state.sourceCue);
  }
});

test('replaying an offline source request after reconnect cannot publish a cue', () => {
  const f = fixture();
  const event = f.event();
  assertLocalReply(f.board.processEvent(event));
  f.connected();
  assert.equal(f.board.processEvent(event).code, 'duplicate_event');
  assertInactive(f.board.getState().sourceCue);
});

test('cue expires at its exact deadline even without more incoming events', () => {
  const f = fixture(); f.connected(); f.source();
  f.advance(DEFAULT_CUE_MS - 1);
  assert.equal(f.board.getState().sourceCue.active, true);
  f.advance(1);
  assertInactive(f.board.getState().sourceCue, 1);
});

test('duplicate source events do not refresh time or inflate the request count', () => {
  const f = fixture(); f.connected();
  const event = f.event(); f.board.processEvent(event);
  f.advance(10_000);
  assert.equal(f.board.processEvent(event).code, 'duplicate_event');
  assert.deepEqual(f.board.getState().sourceCue, {
    active: true, requestedAt: BASE_TIME, expiresAt: BASE_TIME + DEFAULT_CUE_MS,
    requestCount: 1, origin: 'simulated',
  });
});

test('unique source requests during an active window count without extending its first deadline', () => {
  const f = fixture(); f.connected(); f.source();
  f.advance(DEFAULT_CUE_MS - 1);
  const next = f.source({ userId: 'second-synthetic-viewer' });
  assertLocalReply(next);
  assert.equal(next.sourceCuePublished, true);
  assert.equal(next.sourceCueReason, 'already_active');
  assert.equal(next.state.sourceCue.requestCount, 2);
  assert.equal(next.state.sourceCue.requestedAt, BASE_TIME);
  assert.equal(next.state.sourceCue.expiresAt, BASE_TIME + DEFAULT_CUE_MS);
  f.advance(1);
  assertInactive(f.board.getState().sourceCue, 2);
});

test('first new source event after expiry starts another window and retains the cumulative count', () => {
  const f = fixture(); f.connected(); f.source();
  f.advance(DEFAULT_CUE_MS);
  const result = f.source();
  assert.equal(result.sourceCueReason, 'opened');
  assert.equal(result.state.sourceCue.active, true);
  assert.equal(result.state.sourceCue.requestedAt, BASE_TIME + DEFAULT_CUE_MS);
  assert.equal(result.state.sourceCue.expiresAt, BASE_TIME + 2 * DEFAULT_CUE_MS);
  assert.equal(result.state.sourceCue.requestCount, 2);
});

test('a duplicate arriving at the cue deadline does not reopen the expired window', () => {
  const f = fixture(); f.connected();
  const event = f.event(); f.board.processEvent(event); f.advance(DEFAULT_CUE_MS);
  assert.equal(f.board.processEvent(event).code, 'duplicate_event');
  assertInactive(f.board.getState().sourceCue, 1);
});

test('disconnect and connecting clear active cue timestamps while retaining the request count', () => {
  for (const status of ['disconnected', 'connecting']) {
    const f = fixture(); f.connected(); f.source();
    f.board.setConnection(status);
    assertInactive(f.board.getState().sourceCue, 1);
    f.connected();
    assertInactive(f.board.getState().sourceCue, 1);
    const result = f.source();
    assert.equal(result.sourceCueReason, 'opened');
    assert.equal(result.state.sourceCue.requestCount, 2);
  }
});

test('invalid connection values and redundant connected status cannot clear an active cue', () => {
  const f = fixture(); f.connected(); f.source();
  const before = f.board.getState().sourceCue;
  assert.equal(f.board.setConnection('twitch-live').code, 'invalid_connection');
  assert.deepEqual(f.board.getState().sourceCue, before);
  f.connected();
  assert.deepEqual(f.board.getState().sourceCue, before);
});

test('reset clears source cue and its count while preserving event replay protection', () => {
  const f = fixture(); f.connected();
  const event = f.event(); f.board.processEvent(event); f.board.reset();
  assertInactive(f.board.getState().sourceCue);
  assert.equal(f.board.processEvent(event).code, 'duplicate_event');
  assertInactive(f.board.getState().sourceCue);
  assert.equal(f.source().state.sourceCue.requestCount, 1);
});

test('old optional timestamps retain source reply without opening a cue', () => {
  const f = fixture(); f.connected();
  const result = f.source({ timestamp: BASE_TIME - DEFAULT_CUE_MS - 1 });
  assertLocalReply(result);
  assert.equal(result.sourceCuePublished, false);
  assert.equal(result.sourceCueReason, 'stale_event');
  assertInactive(result.state.sourceCue);
});

test('timestamp freshness admits its exact configured age boundary', () => {
  for (const sourceCueMs of [1_000, 5_000, 60_000]) {
    const f = fixture({ sourceCueMs }); f.connected();
    assert.equal(f.source({ timestamp: BASE_TIME - sourceCueMs }).sourceCueReason, 'opened');
    const g = fixture({ sourceCueMs }); g.connected();
    const result = g.source({ timestamp: BASE_TIME - sourceCueMs - 1 });
    assertLocalReply(result);
    assert.equal(result.sourceCueReason, 'stale_event');
    assertInactive(result.state.sourceCue);
  }
});

test('a stale source event cannot be corrected and replayed under the same event ID', () => {
  const f = fixture(); f.connected();
  const event = f.event({ timestamp: BASE_TIME - DEFAULT_CUE_MS - 1 });
  assertLocalReply(f.board.processEvent(event));
  assert.equal(f.board.processEvent({ ...event, timestamp: BASE_TIME }).code, 'duplicate_event');
  assertInactive(f.board.getState().sourceCue);
});

test('omitted timestamp and tolerated future timestamp use receive time for the cue deadline', () => {
  for (const timestamp of [undefined, BASE_TIME + 5_000]) {
    const f = fixture(); f.connected();
    const result = f.source({ timestamp });
    assert.equal(result.sourceCueReason, 'opened');
    assert.equal(result.state.sourceCue.requestedAt, BASE_TIME);
    assert.equal(result.state.sourceCue.expiresAt, BASE_TIME + DEFAULT_CUE_MS);
  }
});

test('unsafe or too-future event timestamps fail before source publication', () => {
  for (const timestamp of [NaN, -1, BASE_TIME + 0.5, BASE_TIME + 5_001, 'now']) {
    const f = fixture(); f.connected();
    const result = f.source({ timestamp });
    assert.equal(result.code, 'invalid_event');
    assertInactive(f.board.getState().sourceCue);
  }
});

test('an overflowing cue deadline preserves the local source reply without publishing', () => {
  const board = createBoard({ now: () => Number.MAX_SAFE_INTEGER - 1_000 });
  board.setConnection('connected');
  const result = board.processEvent({
    id: 'synthetic-overflow', userId: 'synthetic-viewer', text: '!source', origin: 'simulated',
  });
  assertLocalReply(result);
  assert.equal(result.sourceCuePublished, false);
  assert.equal(result.sourceCueReason, 'unsafe_deadline');
  assertInactive(result.state.sourceCue);
});

test('Twitch and unverified EventSub origins still cannot publish source cues', () => {
  for (const origin of ['twitch', 'eventsub-unverified', undefined]) {
    const f = fixture(); f.connected();
    assert.equal(f.source({ origin }).code, 'unsupported_origin');
    assertInactive(f.board.getState().sourceCue);
  }
});

test('invalid, ordinary and help commands do not publish a source cue', () => {
  const f = fixture(); f.connected();
  for (const text of ['!source extra', '!vote c', 'Please use !source', '!help']) {
    f.source({ text });
    assertInactive(f.board.getState().sourceCue);
  }
});

test('source requests leave vote counts unchanged while vote lifecycle leaves the cue independent', () => {
  const f = fixture(); f.connected(); f.board.openVote(1_000);
  f.source({ text: '!vote a' });
  const before = f.board.getState().vote;
  f.source();
  assert.deepEqual(f.board.getState().vote, before);
  f.advance(1_000);
  assert.equal(f.board.getState().vote.phase, 'closed');
  assert.equal(f.board.getState().sourceCue.active, true);
  assert.deepEqual(f.board.getState().vote.counts, { a: 1, b: 0 });
  f.board.openVote(1_000);
  assert.equal(f.board.getState().sourceCue.active, true);
  f.board.closeVote();
  assert.equal(f.board.getState().sourceCue.active, true);
});

test('source cue snapshots are immutable, independent and contain no viewer or raw-message identity', () => {
  const f = fixture(); f.connected();
  const result = f.source({ id: 'private-source-id', userId: 'private-viewer-id', text: '  !SOURCE  ' });
  const cue = result.state.sourceCue;
  assert.throws(() => { cue.expiresAt = Number.MAX_SAFE_INTEGER; }, TypeError);
  assert.throws(() => { cue.requestCount = 99; }, TypeError);
  assert.doesNotMatch(JSON.stringify(result.state), /private-source-id|private-viewer-id|!SOURCE/);
  f.advance(DEFAULT_CUE_MS);
  assertInactive(f.board.getState().sourceCue, 1);
  assert.equal(cue.active, true);
  assert.equal(cue.expiresAt, BASE_TIME + DEFAULT_CUE_MS);
});

test('source cue duration is configurable only within safe integer bounds', () => {
  for (const sourceCueMs of [0, -1, 999, 60_001, 1_000.5, '15000', NaN, Infinity]) {
    assert.throws(() => createBoard({ sourceCueMs }), RangeError);
  }
  for (const sourceCueMs of [1_000, 60_000]) {
    const f = fixture({ sourceCueMs }); f.connected();
    assert.equal(f.source().state.sourceCue.expiresAt, BASE_TIME + sourceCueMs);
    f.advance(sourceCueMs);
    assertInactive(f.board.getState().sourceCue, 1);
  }
});
