import test from 'node:test';
import assert from 'node:assert/strict';
import { createIngressIsolation } from '../src/ingress-isolation.mjs';
import { createBoard, DEFAULT_CARD } from '../src/engine.mjs';
import { createTwitchSession } from '../src/twitch-session.mjs';

// Synthetic local controls only: no real account, token, network or authorization.
// A capability exercises local namespace isolation; it does not prove OAuth provenance.
const BASE_TIME = Date.parse('2026-10-25T08:00:00.000Z');
const CHANNEL = '975310864209975310864209';
const VIEWER = '864209753108864209753108';
const SESSION = 'PRIVATE_SYNTHETIC_SESSION';
const SUBSCRIPTION = 'PRIVATE_SYNTHETIC_SUBSCRIPTION';
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deeplyFrozen(value) {
  if (value && typeof value === 'object') {
    assert.equal(Object.isFrozen(value), true);
    for (const child of Object.values(value)) deeplyFrozen(child);
  }
}

function assertPublic(state) {
  assert.equal(state.mode, 'staged-ingress-harness');
  assert.equal(state.networkConnected, false);
  assert.equal(state.realTwitchConnected, false);
  assert.equal(state.authorizationVerified, false);
  assert.equal(state.sourceCue.origin, 'ingress-harness');
  assert.doesNotMatch(JSON.stringify(state), /PRIVATE_SYNTHETIC_|975310864209975310864209|864209753108864209753108|!vote|!source|capability|access_token|Bearer /);
  function noFunctions(value) {
    if (value && typeof value === 'object') {
      for (const child of Object.values(value)) {
        assert.notEqual(typeof child, 'function');
        noFunctions(child);
      }
    }
  }
  noFunctions(state);
  deeplyFrozen(state);
}

function fixture(options = {}) {
  let time = BASE_TIME;
  let sequence = 0;
  const board = createIngressIsolation({ broadcasterId: CHANNEL, readerId: CHANNEL, now: () => time, ...options });
  const scope = (overrides = {}) => ({ broadcasterId: CHANNEL, readerId: CHANNEL, sessionId: SESSION, subscriptionId: SUBSCRIPTION, ...overrides });
  const packet = (text = '!vote a', overrides = {}, scopeOverrides = {}) => ({
    ...scope(scopeOverrides),
    event: { id: `private-event-${++sequence}`, userId: VIEWER, text, origin: 'transport-unverified', timestamp: time, ...overrides },
  });
  const issue = (overrides = {}) => board.host.issue(scope(overrides));
  const deliver = (capability, eventPacket) => {
    const result = board.host.deliver(capability, eventPacket);
    assertPublic(result.state);
    deeplyFrozen(result);
    return result;
  };
  return { ...board, scope, packet, issue, deliver, now: () => time, setTime: (value) => { time = value; }, advance: (ms) => { time += ms; } };
}

function ready(f, duration = 60_000) {
  assert.equal(f.staged.openVote(duration).code, 'vote_opened');
  const cap = f.issue();
  assert.equal(f.staged.getState().connection.status, 'connected');
  return cap;
}

function sameBoard(before, after) {
  assert.deepEqual(after.vote, before.vote);
  assert.deepEqual(after.sourceCue, before.sourceCue);
  assert.deepEqual(after.metrics, before.metrics);
}

test('public facades have separate duties and begin with no staged ingress', () => {
  const f = fixture();
  assert.equal(Object.isFrozen(createIngressIsolation({ broadcasterId: CHANNEL, readerId: CHANNEL })), true);
  assert.deepEqual(Object.keys(f).filter((key) => ['simulation', 'staged', 'host'].includes(key)).sort(), ['host', 'simulation', 'staged']);
  assert.deepEqual(Object.keys(f.staged).sort(), ['closeVote', 'getState', 'openVote', 'reset']);
  assert.deepEqual(Object.keys(f.host).sort(), ['deliver', 'issue', 'revoke', 'stop']);
  assert.equal(f.staged.processEvent, undefined);
  assert.equal(f.staged.setConnection, undefined);
  assert.equal(f.staged.issue, undefined);
  assert.equal(f.simulation.getState().mode, 'simulated');
  assert.equal(f.simulation.getState().realTwitchConnected, false);
  assert.equal(Object.isFrozen(f.staged), true);
  assert.equal(Object.isFrozen(f.host), true);
  assert.equal(f.staged.getState().ingress.phase, 'inactive');
  assert.equal(f.staged.getState().connection.status, 'disconnected');
  assertPublic(f.staged.getState());
});

test('constructor pins one own channel and bounded lease/configuration', () => {
  const base = { broadcasterId: CHANNEL, readerId: CHANNEL, now: () => BASE_TIME };
  for (const extra of [
    { broadcasterId: '' }, { broadcasterId: '0' }, { readerId: '100' },
    { leaseMs: 0 }, { leaseMs: 3_600_001 }, { leaseMs: 1.5 }, { leaseMs: Infinity },
    { boardOptions: { now: () => BASE_TIME } }, { boardOptions: { maxEventIds: 0 } },
    { unknown: true }, { now: () => -1 }, { now: () => Number.MAX_SAFE_INTEGER + 1 },
  ]) assert.throws(() => createIngressIsolation({ ...base, ...extra }));
  assert.doesNotThrow(() => createIngressIsolation({ ...base, leaseMs: 1 }));
  assert.doesNotThrow(() => createIngressIsolation({ ...base, leaseMs: 3_600_000 }));
});

test('constructor descriptors are checked without invoking getters', () => {
  let reads = 0;
  const options = { broadcasterId: CHANNEL, readerId: CHANNEL };
  Object.defineProperty(options, 'now', { enumerable: true, get() { reads += 1; throw new Error('PRIVATE_SYNTHETIC_GETTER'); } });
  assert.throws(() => createIngressIsolation(options), /invalid_configuration/);
  const boardOptions = {};
  Object.defineProperty(boardOptions, 'sourceCueMs', { enumerable: true, get() { reads += 1; return 1_000; } });
  assert.throws(() => fixture({ boardOptions }), /invalid_configuration/);
  assert.equal(reads, 0);
});

test('issue returns only an inert frozen function whose identity cannot survive JSON or cloning', () => {
  const f = fixture(); const cap = f.issue();
  assert.equal(typeof cap, 'function');
  assert.equal(Object.isFrozen(cap), true);
  assert.deepEqual(Object.keys(cap), []);
  assert.equal(JSON.stringify(cap), undefined);
  assert.equal(JSON.stringify({ capability: cap }), '{}');
  assert.throws(() => structuredClone(cap));
  const before = f.staged.getState();
  assert.equal(cap(f.packet()), undefined);
  assert.deepEqual(f.staged.getState(), before);
  assert.equal(before.ingress.issuedAt, BASE_TIME);
  assert.equal(before.ingress.expiresAt, BASE_TIME + 60_000);
  assertPublic(before);
});

test('valid scoped ingress records a staged vote and another vote from that viewer changes it', () => {
  const f = fixture(); const cap = ready(f);
  assert.equal(f.deliver(cap, f.packet()).code, 'vote_recorded');
  assert.equal(f.deliver(cap, f.packet('!vote b')).code, 'vote_changed');
  assert.equal(f.deliver(cap, f.packet('!vote b')).code, 'vote_unchanged');
  const state = f.staged.getState();
  assert.deepEqual(state.vote.counts, { a: 0, b: 1 });
  assert.equal(state.vote.total, 1);
  assert.equal(state.vote.uniqueVoters, 1);
  assert.equal(state.metrics.acceptedVotes, 2);
  assert.equal(f.simulation.getState().vote.total, 0);
  assertPublic(state);
});

test('simulation keeps the original origin/connection semantics without staged authority', () => {
  const f = fixture(); f.staged.openVote();
  f.simulation.setConnection('connected'); f.simulation.openVote();
  assert.equal(f.simulation.processEvent({ id: 'simulated-origin', userId: VIEWER, text: '!vote a', origin: 'transport-unverified' }).code, 'unsupported_origin');
  assert.equal(f.simulation.processEvent({ id: 'simulated-accepted', userId: VIEWER, text: '!vote a', origin: 'simulated' }).code, 'vote_recorded');
  assert.equal(f.deliver(undefined, f.packet()).code, 'invalid_capability');
  assert.equal(f.staged.getState().vote.total, 0);
  assert.equal(f.staged.getState().connection.status, 'disconnected');
  assert.equal(f.staged.getState().metrics.invalidEvents, 0);
});

test('both namespaces own independent event replay caches and viewer totals', () => {
  const f = fixture(); const cap = ready(f);
  f.simulation.setConnection('connected'); f.simulation.openVote();
  const staged = f.packet('!vote a', { id: 'shared-id-a' });
  const sim = { ...staged.event, origin: 'simulated' };
  assert.equal(f.simulation.processEvent(sim).code, 'vote_recorded');
  assert.equal(f.deliver(cap, staged).code, 'vote_recorded');
  const stagedSecond = f.packet('!vote b', { id: 'shared-id-b', userId: '200' });
  assert.equal(f.deliver(cap, stagedSecond).code, 'vote_recorded');
  assert.equal(f.simulation.processEvent({ ...stagedSecond.event, origin: 'simulated' }).code, 'vote_recorded');
  assert.equal(f.deliver(cap, staged).code, 'duplicate_event');
  assert.equal(f.simulation.processEvent(sim).code, 'duplicate_event');
  assert.deepEqual(f.staged.getState().vote.counts, { a: 1, b: 1 });
  assert.deepEqual(f.simulation.getState().vote.counts, { a: 1, b: 1 });
});

test('fake, JSON-derived, bound and foreign capabilities cannot consume a valid event ID', () => {
  const f = fixture(); const cap = ready(f);
  const other = fixture(); const foreign = other.issue();
  const candidates = [undefined, null, {}, JSON.parse(JSON.stringify({ capability: cap })), () => {}, cap.bind(null), foreign];
  for (const [index, fake] of candidates.entries()) {
    const packet = f.packet('!vote a', { id: `fake-cap-${index}`, userId: String(200 + index) });
    const before = f.staged.getState();
    assert.equal(f.deliver(fake, packet).code, 'invalid_capability');
    assert.deepEqual(f.staged.getState(), before);
    assert.equal(f.deliver(cap, packet).code, 'vote_recorded');
  }
});

test('all four packet pins are enforced before engine metrics or replay state change', () => {
  const f = fixture(); const cap = ready(f);
  for (const [index, changed] of [
    { broadcasterId: '200' }, { readerId: '200' }, { sessionId: 'foreign-session' }, { subscriptionId: 'foreign-subscription' },
  ].entries()) {
    const packet = f.packet('!vote a', { id: `pin-${index}`, userId: String(200 + index) });
    const before = f.staged.getState();
    assert.equal(f.deliver(cap, { ...packet, ...changed }).code, 'scope_mismatch');
    assert.deepEqual(f.staged.getState(), before);
    assert.equal(f.deliver(cap, packet).code, 'vote_recorded');
  }
});

test('packet and event allowlists reject malformed input without reading getters or poisoning replay', () => {
  const f = fixture(); const cap = ready(f); let reads = 0;
  const good = f.packet('!vote a', { id: 'descriptor-replay' });
  const packetGetter = { ...good };
  Object.defineProperty(packetGetter, 'event', { enumerable: true, get() { reads += 1; return good.event; } });
  const eventGetter = { ...good.event };
  Object.defineProperty(eventGetter, 'text', { enumerable: true, get() { reads += 1; return '!vote a'; } });
  const withSymbol = { ...good, [Symbol('private')]: 'PRIVATE_SYNTHETIC_SYMBOL' };
  const cycle = { ...good }; cycle.event = cycle;
  const missingTimestamp = { ...good.event }; delete missingTimestamp.timestamp;
  const malformed = [null, [], { ...good, extra: true }, { ...good, sessionId: undefined }, packetGetter,
    { ...good, event: eventGetter }, { ...good, event: missingTimestamp }, { ...good, event: { ...good.event, extra: true } }, withSymbol, cycle,
    Object.assign(Object.create({ inherited: true }), good)];
  for (const packet of malformed) {
    const before = f.staged.getState();
    assert.equal(f.deliver(cap, packet).code, 'invalid_input');
    assert.deepEqual(f.staged.getState(), before);
  }
  assert.equal(reads, 0);
  assert.equal(f.deliver(cap, good).code, 'vote_recorded');
});

test('only bounded transport-unverified normalized events can enter staged engine', () => {
  const f = fixture(); const cap = ready(f);
  const bad = [
    { origin: 'simulated' }, { origin: 'twitch' }, { origin: 'eventsub-unverified' }, { origin: undefined },
    { id: '' }, { id: 'unsafe id' }, { id: 'x'.repeat(129) }, { userId: 'viewer-name' }, { userId: '0' },
    { text: 'x'.repeat(301) }, { timestamp: -1 }, { timestamp: BASE_TIME + 5_001 },
    { timestamp: Number.MAX_SAFE_INTEGER + 1 }, { timestamp: 1.5 }, { deliveryId: 'private-delivery' },
  ];
  for (const [index, changed] of bad.entries()) {
    const packet = f.packet('!vote a', { id: `event-validation-${index}`, ...changed });
    const before = f.staged.getState();
    assert.equal(f.deliver(cap, packet).code, 'invalid_input');
    assert.deepEqual(f.staged.getState(), before);
    assert.equal(f.deliver(cap, f.packet('!vote a', { id: `event-validation-${index}`, userId: String(200 + index) })).code, 'vote_recorded');
  }
  assert.equal(f.deliver(cap, f.packet('x'.repeat(300), { timestamp: BASE_TIME + 5_000 })).code, 'ignored');
});

test('an invalid issue revokes the old capability and clears cue while preserving vote/window/cache', () => {
  const f = fixture(); const old = ready(f); const vote = f.packet();
  f.deliver(old, vote); f.deliver(old, f.packet('!source'));
  const before = f.staged.getState();
  assert.throws(() => f.host.issue(f.scope({ sessionId: 'unsafe session' })), /invalid_input/);
  const after = f.staged.getState();
  assert.equal(after.connection.status, 'disconnected');
  assert.equal(after.sourceCue.active, false);
  assert.equal(after.sourceCue.requestCount, 1);
  assert.deepEqual(after.vote, before.vote);
  assert.equal(f.deliver(old, f.packet()).code, 'capability_revoked');
  const next = f.issue();
  assert.equal(f.deliver(next, vote).code, 'duplicate_event');
  assert.equal(f.staged.getState().vote.total, 1);
});

test('issue validates full own scope without invoking getters and fails closed on each malformed attempt', () => {
  let reads = 0;
  const f = fixture();
  const getter = f.scope();
  Object.defineProperty(getter, 'sessionId', { enumerable: true, get() { reads += 1; return SESSION; } });
  for (const scope of [null, [], f.scope({ broadcasterId: '200' }), f.scope({ readerId: '200' }),
    f.scope({ subscriptionId: '' }), { ...f.scope(), extra: true }, getter]) {
    const old = f.issue();
    assert.throws(() => f.host.issue(scope), /invalid_input|scope_mismatch/);
    assert.equal(f.staged.getState().connection.status, 'disconnected');
    assert.equal(f.deliver(old, f.packet()).code, 'capability_revoked');
  }
  assert.equal(reads, 0);
});

test('reissue replaces local authority while retaining fixed round deadline, votes and replay cache', () => {
  const f = fixture(); const old = ready(f); const packet = f.packet();
  f.deliver(old, packet); const before = f.staged.getState();
  f.advance(5_000); const next = f.issue({ sessionId: 'next-session', subscriptionId: 'next-subscription' });
  const state = f.staged.getState();
  assert.ok(state.ingress.generation > before.ingress.generation);
  assert.equal(state.ingress.expiresAt, BASE_TIME + 65_000);
  assert.deepEqual(state.vote, before.vote);
  assert.equal(f.deliver(old, packet).code, 'capability_revoked');
  const reScoped = { ...packet, sessionId: 'next-session', subscriptionId: 'next-subscription' };
  assert.equal(f.deliver(next, reScoped).code, 'duplicate_event');
  assert.equal(f.deliver(next, f.packet('!vote b', {}, { sessionId: 'next-session', subscriptionId: 'next-subscription' })).code, 'vote_changed');
});

test('lease is usable just before its deadline and expires exactly at it without pausing the vote', () => {
  const f = fixture({ leaseMs: 1_000 }); const cap = ready(f, 10_000);
  f.advance(999);
  assert.equal(f.deliver(cap, f.packet()).code, 'vote_recorded');
  f.deliver(cap, f.packet('!source')); f.advance(1);
  const before = f.staged.getState();
  assert.equal(before.ingress.phase, 'expired');
  assert.equal(before.connection.status, 'disconnected');
  assert.equal(before.sourceCue.active, false);
  assert.equal(before.sourceCue.requestCount, 1);
  assert.equal(before.vote.phase, 'open');
  assert.equal(before.vote.closesAt, BASE_TIME + 10_000);
  const rejected = f.packet('!vote b', { id: 'expiry-not-cached', userId: '201' });
  assert.equal(f.deliver(cap, rejected).code, 'capability_expired');
  sameBoard(before, f.staged.getState());
  const next = f.issue();
  assert.equal(f.deliver(next, rejected).code, 'vote_recorded');
});

test('unsafe lease deadline fails closed rather than issuing an overflowing capability', () => {
  const f = fixture({ leaseMs: 2 }); const old = f.issue();
  f.setTime(Number.MAX_SAFE_INTEGER - 1);
  assert.throws(() => f.issue(), /unsafe_deadline/);
  assert.notEqual(f.staged.getState().ingress.phase, 'issued');
  assert.equal(f.staged.getState().connection.status, 'disconnected');
  assert.equal(f.deliver(old, f.packet()).ok, false);
  assertPublic(f.staged.getState());
});

test('unknown and old revoke attempts do not revoke a current replacement', () => {
  const f = fixture(); const old = ready(f); const current = f.issue();
  assert.equal(f.host.revoke(() => {}).code, 'invalid_capability');
  assert.equal(f.host.revoke(old).code, 'capability_revoked');
  assert.equal(f.staged.getState().ingress.phase, 'issued');
  assert.equal(f.deliver(current, f.packet()).code, 'vote_recorded');
  assert.equal(f.host.revoke(current).ok, true);
  assert.equal(f.staged.getState().ingress.phase, 'revoked');
  assert.equal(f.deliver(current, f.packet()).code, 'capability_revoked');
});

test('a queued revoked callback cannot poison the next generation replay cache', async () => {
  const f = fixture(); const old = ready(f);
  const event = f.packet('!vote a', { id: 'queued-same-id' });
  const queued = Promise.resolve().then(() => f.deliver(old, event));
  f.host.revoke(old); const current = f.issue();
  const before = f.staged.getState();
  assert.equal((await queued).code, 'capability_revoked');
  assert.deepEqual(f.staged.getState(), before);
  assert.equal(f.deliver(current, event).code, 'vote_recorded');
});

test('descriptor-trap reentry cannot deliver through a capability revoked or replaced during inspection', () => {
  for (const action of ['revoke', 'replace', 'stop']) {
    const f = fixture(); const old = ready(f); let current; let entered = false;
    const packet = f.packet('!vote a', { id: `reentrant-${action}` });
    const proxy = new Proxy(packet, {
      getOwnPropertyDescriptor(target, key) {
        if (!entered && key === 'event') {
          entered = true;
          if (action === 'stop') f.host.stop();
          else if (action === 'replace') current = f.issue();
          else f.host.revoke(old);
        }
        return Reflect.getOwnPropertyDescriptor(target, key);
      },
    });
    assert.equal(f.deliver(old, proxy).code, action === 'stop' ? 'stopped' : 'capability_revoked');
    assert.equal(f.staged.getState().vote.total, 0);
    assert.deepEqual(f.staged.getState().metrics, { acceptedVotes: 0, duplicates: 0, invalidEvents: 0 });
    if (action !== 'stop') {
      current ??= f.issue();
      assert.equal(f.deliver(current, packet).code, 'vote_recorded');
    }
  }
});

test('expiry is rechecked after descriptor inspection and a clock rollback cannot revive an expired identity', () => {
  const f = fixture({ leaseMs: 1_000 }); const cap = ready(f);
  const packet = f.packet('!vote a', { id: 'expiry-during-inspection' }); let entered = false;
  const proxy = new Proxy(packet, {
    getOwnPropertyDescriptor(target, key) {
      if (!entered && key === 'event') { entered = true; f.advance(1_000); }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
  });
  assert.equal(f.deliver(cap, proxy).code, 'capability_expired');
  assert.equal(f.staged.getState().vote.total, 0);
  f.setTime(BASE_TIME);
  assert.equal(f.deliver(cap, packet).code, 'capability_expired');
  const fresh = f.issue();
  assert.equal(f.deliver(fresh, packet).code, 'vote_recorded');
});

test('failed replacement also revokes a capability minted reentrantly during malformed scope inspection', () => {
  const f = fixture(); ready(f); let reentrant; let entered = false;
  const scope = new Proxy({ ...f.scope(), extra: true }, {
    ownKeys(target) {
      if (!entered) { entered = true; reentrant = f.issue(); }
      return Reflect.ownKeys(target);
    },
  });
  assert.throws(() => f.host.issue(scope), /invalid_input/);
  assert.equal(typeof reentrant, 'function');
  assert.equal(f.staged.getState().connection.status, 'disconnected');
  const packet = f.packet('!vote a', { id: 'reentrant-issue-no-cache' });
  assert.equal(f.deliver(reentrant, packet).code, 'capability_revoked');
  const current = f.issue();
  assert.equal(f.deliver(current, packet).code, 'vote_recorded');
});

test('stop is terminal/idempotent and leaves simulation independent', async () => {
  const f = fixture(); const cap = ready(f); f.deliver(cap, f.packet());
  const queued = Promise.resolve().then(() => f.deliver(cap, f.packet('!vote b')));
  assert.equal(f.host.stop().code, 'stopped');
  const state = f.staged.getState();
  assert.equal(state.ingress.phase, 'stopped');
  assert.equal(state.connection.status, 'disconnected');
  assert.equal((await queued).code, 'stopped');
  assert.equal(f.host.stop().code, 'stopped');
  assert.deepEqual(f.staged.getState(), state);
  assert.throws(() => f.issue(), /stopped/);
  f.simulation.setConnection('connected'); f.simulation.openVote();
  assert.equal(f.simulation.processEvent({ id: 'after-staged-stop', userId: VIEWER, text: '!vote a', origin: 'simulated' }).code, 'vote_recorded');
  assertPublic(f.staged.getState());
});

test('source cue belongs only to staged ingress, with a fixed window and no vote requirement', () => {
  const f = fixture({ boardOptions: { sourceCueMs: 1_000 } }); const cap = f.issue();
  const first = f.packet('!source'); const result = f.deliver(cap, first);
  assert.equal(result.code, 'source'); assert.equal(result.sourceCuePublished, true);
  assert.equal(result.sourceCueReason, 'opened'); assert.equal(typeof result.reply, 'string');
  const deadline = f.staged.getState().sourceCue.expiresAt;
  f.advance(500);
  assert.equal(f.deliver(cap, first).code, 'duplicate_event');
  assert.equal(f.deliver(cap, f.packet('!source')).sourceCueReason, 'already_active');
  assert.equal(f.staged.getState().sourceCue.expiresAt, deadline);
  assert.equal(f.staged.getState().sourceCue.requestCount, 2);
  assert.equal(f.staged.getState().vote.total, 0);
  assert.equal(f.simulation.getState().sourceCue.active, false);
  assert.equal(f.simulation.getState().sourceCue.requestCount, 0);
  f.advance(500);
  assert.equal(f.staged.getState().sourceCue.active, false);
  assert.equal(f.deliver(cap, f.packet('!source')).sourceCueReason, 'opened');
  assert.equal(f.staged.getState().sourceCue.expiresAt, deadline + 1_000);
});

test('revocation clears staged source cue but retains request count and vote deadline', () => {
  const f = fixture(); const cap = ready(f);
  f.deliver(cap, f.packet('!source')); const before = f.staged.getState();
  f.advance(500); const result = f.host.revoke(cap);
  assertPublic(result.state); deeplyFrozen(result);
  assert.equal(result.state.sourceCue.active, false);
  assert.equal(result.state.sourceCue.requestedAt, null);
  assert.equal(result.state.sourceCue.expiresAt, null);
  assert.equal(result.state.sourceCue.requestCount, 1);
  assert.deepEqual(result.state.vote, before.vote);
  const next = f.issue();
  assert.equal(f.deliver(next, f.packet('!source')).sourceCueReason, 'opened');
  assert.equal(f.staged.getState().sourceCue.requestCount, 2);
});

test('new issue clears active cue without zeroing its cumulative count or extending a vote', () => {
  const f = fixture(); const old = ready(f);
  f.deliver(old, f.packet('!source')); const before = f.staged.getState();
  f.advance(500); f.issue();
  const state = f.staged.getState();
  assert.equal(state.sourceCue.active, false);
  assert.equal(state.sourceCue.requestCount, before.sourceCue.requestCount);
  assert.deepEqual(state.vote, before.vote);
});

test('staged reset revokes current capability, clears totals/cue and preserves replay protection', () => {
  const f = fixture(); const cap = ready(f); const packet = f.packet();
  f.deliver(cap, packet); f.deliver(cap, f.packet('!source'));
  const reset = f.staged.reset(); assertPublic(reset.state); deeplyFrozen(reset);
  assert.equal(reset.code, 'reset'); assert.equal(reset.state.vote.phase, 'idle');
  assert.equal(reset.state.vote.total, 0); assert.equal(reset.state.sourceCue.requestCount, 0);
  assert.equal(reset.state.connection.status, 'disconnected');
  assert.equal(f.deliver(cap, f.packet()).code, 'capability_revoked');
  f.staged.openVote(); const next = f.issue();
  assert.equal(f.deliver(next, packet).code, 'duplicate_event');
  assert.equal(f.deliver(next, f.packet()).code, 'vote_recorded');
});

test('opening/closing staged rounds preserves lease and does not confer simulation authority', () => {
  const f = fixture(); const cap = f.issue(); const lease = f.staged.getState().ingress;
  assert.equal(f.deliver(cap, f.packet()).code, 'vote_closed');
  const opened = f.staged.openVote(1_000); assertPublic(opened.state); deeplyFrozen(opened);
  assert.deepEqual(opened.state.ingress, lease);
  assert.equal(f.deliver(cap, f.packet()).code, 'vote_recorded');
  const closed = f.staged.closeVote(); assertPublic(closed.state); deeplyFrozen(closed);
  assert.deepEqual(closed.state.ingress, lease);
  assert.equal(f.simulation.getState().connection.status, 'disconnected');
  assert.equal(f.simulation.getState().vote.phase, 'idle');
});

test('configured bounded staged replay eviction does not affect simulation cache', () => {
  const f = fixture({ boardOptions: { maxEventIds: 2, eventTtlMs: 1_000 } }); const cap = ready(f);
  f.simulation.setConnection('connected'); f.simulation.openVote();
  const first = f.packet('!vote a', { id: 'bounded-replay' });
  assert.equal(f.deliver(cap, first).code, 'vote_recorded');
  f.simulation.processEvent({ ...first.event, origin: 'simulated' });
  f.deliver(cap, f.packet('!help')); f.deliver(cap, f.packet('!help'));
  assert.equal(f.deliver(cap, first).code, 'vote_unchanged');
  assert.equal(f.simulation.processEvent({ ...first.event, origin: 'simulated' }).code, 'duplicate_event');
  f.advance(1_000);
  assert.equal(f.deliver(cap, first).code, 'vote_unchanged');
});

test('snapshots and retained card inputs cannot mutate either namespace or disclose capability data', () => {
  const card = structuredClone(DEFAULT_CARD); const f = fixture({ card }); const cap = ready(f);
  card.claim = 'PRIVATE_SYNTHETIC_CHANGED_CARD'; card.choices.a = 'mutated';
  const initial = f.staged.getState();
  assert.throws(() => { initial.vote.counts.a = 99; });
  assert.throws(() => { initial.ingress.expiresAt = Number.MAX_SAFE_INTEGER; });
  assert.throws(() => { initial.card.choices.a = 'mutated'; });
  f.deliver(cap, f.packet('!vote a'));
  assert.equal(initial.vote.total, 0);
  assert.equal(f.staged.getState().vote.total, 1);
  assert.equal(f.staged.getState().card.claim, DEFAULT_CARD.claim);
  assert.equal(f.simulation.getState().card.choices.a, DEFAULT_CARD.choices.a);
  assertPublic(initial); assertPublic(f.staged.getState());
});

test('old transport coordinator cannot enter staged or original board without an explicit local capability', async () => {
  const f = fixture(); f.staged.openVote();
  const original = createBoard({ now: f.now }); original.setConnection('connected'); original.openVote();
  const attempts = []; const direct = []; let callbacks; let closes = 0; let timerId = 0;
  const timers = new Map();
  const session = createTwitchSession({
    clientId: 'synthetic-client', broadcasterId: CHANNEL, readerId: CHANNEL, now: f.now,
    setTimer: (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); return id; },
    clearTimer: (id) => timers.delete(id),
    adapters: {
      validate: async () => ({ httpStatus: 200, body: { client_id: 'synthetic-client', user_id: CHANNEL, scopes: ['user:read:chat'], expires_in: 7_200 } }),
      connect: async (input) => { callbacks = input; return { close() { closes += 1; } }; },
      subscribe: async () => ({ httpStatus: 202, body: { data: [{ id: SUBSCRIPTION, status: 'enabled', type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: CHANNEL, user_id: CHANNEL }, transport: { method: 'websocket', session_id: SESSION } }] } }),
    },
    onEvent(event) {
      assert.equal(event.origin, 'transport-unverified');
      direct.push(original.processEvent(event));
      attempts.push(f.deliver(undefined, { ...f.scope(), event: { id: event.id, userId: event.userId, text: event.text, origin: event.origin, timestamp: event.timestamp } }));
    },
  });
  try {
    assert.equal((await session.start(Object.freeze({ synthetic: true }))).code, 'started');
    await callbacks.onFrame(JSON.stringify({ metadata: { message_id: 'welcome-delivery', message_type: 'session_welcome', message_timestamp: new Date(BASE_TIME).toISOString() }, payload: { session: { id: SESSION, status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null } } }));
    assert.equal(session.getState().phase, 'receiving');
    await callbacks.onFrame(JSON.stringify({
      metadata: { message_id: 'chat-delivery', message_type: 'notification', message_timestamp: new Date(BASE_TIME).toISOString(), subscription_type: 'channel.chat.message', subscription_version: '1' },
      payload: {
        subscription: { id: SUBSCRIPTION, status: 'enabled', type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: CHANNEL, user_id: CHANNEL }, transport: { method: 'websocket', session_id: SESSION } },
        event: { broadcaster_user_id: CHANNEL, chatter_user_id: VIEWER, message_id: 'old-harness-chat', message: { text: '!vote a', fragments: [] } },
      },
    }));
    await flush();
    assert.equal(attempts.length, 1); assert.equal(attempts[0].code, 'invalid_capability');
    assert.equal(direct[0].code, 'unsupported_origin');
    assert.equal(f.staged.getState().vote.total, 0);
    assert.equal(f.staged.getState().metrics.invalidEvents, 0);
    assert.equal(original.getState().vote.total, 0);
    assert.equal(session.getState().realTwitchConnected, false);
    assert.equal(session.getState().authorizationVerified, false);
    const cap = f.issue();
    assert.equal(f.deliver(cap, f.packet('!vote a', { id: 'old-harness-chat' })).code, 'vote_recorded');
    assertPublic(f.staged.getState());
  } finally { await session.stop(); }
  assert.equal(closes, 1); assert.equal(timers.size, 0);
});
