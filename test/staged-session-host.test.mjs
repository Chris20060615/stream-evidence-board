import test from 'node:test';
import assert from 'node:assert/strict';
import { createStagedSessionHost } from '../src/staged-session-host.mjs';
import { createCredentialSessionHost } from '../src/credential-session-host.mjs';

// Full local module composition with synthetic fetch/socket/exchange only.
// No real token, Twitch account, network, OAuth verification or HTTP board route.
const CLIENT = 'syntheticstaged01';
const CHANNEL = '100';
const ACCESS = 'SYNTHETIC_ACCESS_CANARY_NOT_A_REAL_TOKEN';
const REFRESH = 'SYNTHETIC_REFRESH_CANARY_NOT_A_REAL_TOKEN';
const RAW_ERROR = 'SYNTHETIC_RAW_ERROR_CANARY_DO_NOT_PUBLISH';
const BASE_TIME = Date.parse('2026-10-25T08:00:00.000Z');
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function grant(overrides = {}) {
  return { accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 3_600, scopes: ['user:read:chat'], ...overrides };
}
function manualClock() {
  let time = BASE_TIME; let sequence = 0; const timers = new Map();
  return {
    now: () => time,
    set: (value) => { time = value; },
    setTimer(callback, delay) { const id = ++sequence; timers.set(id, { callback, deadline: time + delay }); return id; },
    clearTimer: (id) => timers.delete(id),
    pending: () => timers.size,
    async advance(ms) {
      const target = time + ms; let count = 0;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.deadline <= target).sort((a, b) => a[1].deadline - b[1].deadline)[0];
        if (!next) break;
        if (++count > 1_000) throw new Error('Synthetic timer loop bound.');
        const [id, timer] = next; timers.delete(id); time = timer.deadline;
        await timer.callback(); await flush();
      }
      time = target; await flush();
    },
  };
}
function streamResponse(body, { status = 200, read, cancel } = {}) {
  let sent = false; const stats = { reads: 0, cancels: 0, releases: 0 };
  const reader = {
    async read() {
      stats.reads += 1; if (read) return read(stats.reads);
      if (sent) return { done: true }; sent = true;
      return { done: false, value: new TextEncoder().encode(JSON.stringify(body)) };
    },
    cancel() { stats.cancels += 1; return cancel?.(); },
    releaseLock() { stats.releases += 1; },
  };
  return { response: { status, body: { getReader: () => reader, cancel: () => reader.cancel() } }, stats };
}
function validationBody(overrides = {}) {
  return { client_id: CLIENT, user_id: CHANNEL, scopes: ['user:read:chat'], expires_in: 3_600, ...overrides };
}
function subscriptionBody(sessionId) {
  return { data: [{ id: `PRIVATE_SUB_${sessionId}`, status: 'enabled', type: 'channel.chat.message', version: '1',
    condition: { broadcaster_user_id: CHANNEL, user_id: CHANNEL }, transport: { method: 'websocket', session_id: sessionId } }] };
}
function deeplyFrozen(value) {
  if (value && typeof value === 'object') {
    assert.equal(Object.isFrozen(value), true);
    for (const child of Object.values(value)) { assert.notEqual(typeof child, 'function'); deeplyFrozen(child); }
  }
}
function assertPrivate(value) {
  assert.doesNotMatch(JSON.stringify(value), /SYNTHETIC_(ACCESS|REFRESH|RAW_ERROR)_CANARY|PRIVATE_SESSION_|PRIVATE_SUB_|!vote|!source|accessToken|refreshToken|Authorization|headers|user:read:chat|scopes|capability/);
}
function assertPublic(state) {
  assert.equal(state.mode, 'staged-session-host-harness');
  for (const object of [state, state.session, state.board]) {
    assert.equal(object.networkConnected, false); assert.equal(object.authorizationVerified, false); assert.equal(object.realTwitchConnected, false);
  }
  assert.equal(state.session.mode, 'credential-session-host-harness');
  assert.equal(state.board.mode, 'staged-ingress-harness');
  assert.equal(state.board.sourceCue.origin, 'ingress-harness');
  deeplyFrozen(state); assertPrivate(state);
}
function assertResult(result, code) {
  assert.equal(typeof result.ok, 'boolean'); assert.equal(typeof result.code, 'string');
  if (code) assert.equal(result.code, code);
  assertPublic(result.state); deeplyFrozen(result); assertPrivate(result);
}

function fixture({ config = {}, fetchImpl, connectImpl, exchangeImpl, factory = createStagedSessionHost, onEvent, fixedSessionId } = {}) {
  const clock = manualClock(); const calls = { fetch: [], connect: [], exchange: [], close: [] }; let delivery = 0;
  const host = factory({
    clientId: CLIENT, broadcasterId: CHANNEL, readerId: CHANNEL,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    fetchImpl: async (url, options) => {
      const kind = url === VALIDATE_URL ? 'validate' : 'subscribe';
      const call = { url, options, kind, body: options.body ? JSON.parse(options.body) : undefined };
      calls.fetch.push(call);
      if (fetchImpl) return fetchImpl(call, calls.fetch.filter((item) => item.kind === kind).length);
      return streamResponse(kind === 'validate' ? validationBody() : subscriptionBody(call.body.transport.session_id), { status: kind === 'validate' ? 200 : 202 }).response;
    },
    connect: async (callbacks) => {
      const number = calls.connect.length + 1;
      const connection = { callbacks, number, handle: { close() { calls.close.push(number); } } };
      calls.connect.push(connection);
      return connectImpl ? connectImpl(callbacks, connection) : connection.handle;
    },
    exchange: (input) => { calls.exchange.push(input); return exchangeImpl ? exchangeImpl(input) : grant({ accessToken: `${ACCESS}_ROTATED`, refreshToken: `${REFRESH}_ROTATED` }); },
    ...(factory === createCredentialSessionHost ? { onEvent } : {}),
    ...config,
  });
  const sessionId = (number = calls.connect.length) => fixedSessionId ?? `PRIVATE_SESSION_${number}`;
  const metadata = (type, sub = false, timestamp = clock.now()) => ({
    message_id: `delivery-${++delivery}`, message_type: type, message_timestamp: new Date(timestamp).toISOString(),
    ...(sub ? { subscription_type: 'channel.chat.message', subscription_version: '1' } : {}),
  });
  const welcome = (number = calls.connect.length) => ({ metadata: metadata('session_welcome'), payload: { session: { id: sessionId(number), status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null } } });
  function notification({ number = calls.connect.length, text = '!vote a', id, userId = '200', timestamp = clock.now(), event = {}, subscription } = {}) {
    const meta = metadata('notification', true, timestamp);
    return { metadata: meta, payload: {
      subscription: subscription ?? subscriptionBody(sessionId(number)).data[0],
      event: { broadcaster_user_id: CHANNEL, chatter_user_id: userId, message_id: id ?? `private-chat-${delivery}`, message: { text, fragments: [] }, ...event },
    } };
  }
  const socket = (number = calls.connect.length) => calls.connect[number - 1].callbacks;
  const emit = (frame, number = calls.connect.length) => socket(number).onFrame(typeof frame === 'string' ? frame : JSON.stringify(frame));
  async function receiving(input = grant()) {
    assert.equal((await host.start(input)).ok, true);
    assert.equal((await emit(welcome())).ok, true);
  }
  async function voting(input = grant(), duration = 60_000) { host.openVote(duration); await receiving(input); }
  return { host, calls, clock, socket, emit, sessionId, welcome, notification, receiving, voting };
}

test('public facade is frozen and has no raw event, scope, capability or private callback path', () => {
  const f = fixture();
  assert.equal(Object.isFrozen(f.host), true);
  assert.deepEqual(Object.keys(f.host).sort(), ['closeVote', 'getState', 'openVote', 'refresh', 'reset', 'revoke', 'simulation', 'start', 'stop']);
  for (const key of ['processEvent', 'setConnection', 'issue', 'deliver', 'onEvent', 'scope', 'host', 'staged']) assert.equal(f.host[key], undefined);
  assert.equal(f.calls.fetch.length + f.calls.connect.length + f.calls.exchange.length, 0);
  const state = f.host.getState(); assertPublic(state);
  assert.equal(state.board.connection.status, 'disconnected'); assert.equal(state.board.vote.total, 0);
  assert.equal(f.host.simulation.getState().mode, 'simulated'); f.host.stop();
});

test('constructor requires own-channel explicit dependencies and forbids a user-supplied onEvent bridge', () => {
  const base = { clientId: CLIENT, broadcasterId: CHANNEL, readerId: CHANNEL, fetchImpl: () => {}, connect: () => {}, exchange: () => {} };
  for (const input of [null, {}, { ...base, readerId: '200' }, { ...base, onEvent: () => {} }, { ...base, scope: {} },
    { ...base, leaseMs: 0 }, { ...base, leaseMs: 3_600_001 }, { ...base, boardOptions: { processEvent() {} } }, { ...base, fetchImpl: undefined }]) {
    assert.throws(() => createStagedSessionHost(input));
  }
  let reads = 0; const getter = { ...base };
  Object.defineProperty(getter, 'connect', { enumerable: true, get() { reads += 1; throw new Error(RAW_ERROR); } });
  assert.throws(() => createStagedSessionHost(getter)); assert.equal(reads, 0);
});

test('credential host private bridge emits frozen checked202 scope identity per run, including equal-valued fresh scope', async () => {
  const delivered = [];
  const f = fixture({ factory: createCredentialSessionHost, fixedSessionId: 'PRIVATE_SESSION_REUSED', onEvent: (event, scope) => delivered.push({ event, scope }) });
  try {
    await f.receiving(); await f.emit(f.notification()); await f.emit(f.notification({ userId: '201' }));
    assert.equal(delivered.length, 2); const scope = delivered[0].scope;
    assert.deepEqual(Object.keys(scope).sort(), ['broadcasterId', 'readerId', 'sessionId', 'subscriptionId']);
    assert.deepEqual(scope, { broadcasterId: CHANNEL, readerId: CHANNEL, sessionId: f.sessionId(), subscriptionId: `PRIVATE_SUB_${f.sessionId()}` });
    assert.equal(Object.isFrozen(scope), true); assert.equal(delivered[1].scope, scope);
    assert.deepEqual(Object.keys(delivered[0].event).sort(), ['id', 'origin', 'text', 'timestamp', 'userId']);
    assert.equal((await f.host.refresh()).ok, true); await f.emit(f.welcome(2), 2); await f.emit(f.notification({ number: 2 }), 2);
    assert.equal(delivered.length, 3); assert.notEqual(delivered[2].scope, scope); assert.deepEqual(delivered[2].scope, scope);
    assertPrivate(f.host.getState()); assert.equal(f.host.getState().authorizationVerified, false);
  } finally { f.host.stop(); }
});

test('GET validation, welcome and pinnedPOST202 alone never connect the staged board or tally a vote', async () => {
  const f = fixture();
  try {
    assertResult(f.host.openVote(60_000), 'vote_opened');
    assertResult(await f.host.start(grant()), 'started');
    assert.equal(f.host.getState().board.connection.status, 'disconnected');
    assert.equal((await f.emit(f.welcome())).ok, true);
    const state = f.host.getState(); assertPublic(state);
    assert.equal(state.session.phase, 'receiving'); assert.equal(state.binding.phase, 'awaiting_scope');
    assert.equal(state.board.connection.status, 'disconnected'); assert.equal(state.board.ingress.phase, 'inactive');
    assert.equal(state.board.vote.total, 0); assert.equal(state.board.sourceCue.active, false);
    assert.equal(f.calls.fetch.length, 2); assert.equal(f.calls.fetch[0].options.headers.Authorization, `OAuth ${ACCESS}`);
    assert.equal(f.calls.fetch[1].options.headers.Authorization, `Bearer ${ACCESS}`);
    assert.deepEqual(f.calls.fetch[1].body.transport, { method: 'websocket', session_id: f.sessionId() });
  } finally { f.host.stop(); }
});

test('first actually delivered chat binds scope then counts a vote; same viewer changes one unique choice', async () => {
  const f = fixture();
  try {
    await f.voting(); await f.emit(f.notification());
    const initial = f.host.getState(); assertPublic(initial);
    assert.equal(initial.binding.phase, 'bound'); assert.equal(initial.board.connection.status, 'connected');
    assert.deepEqual(initial.board.vote.counts, { a: 1, b: 0 });
    assert.equal(initial.board.ingress.issuedAt, BASE_TIME);
    await f.emit(f.notification({ text: '!vote b' }));
    const state = f.host.getState(); assert.deepEqual(state.board.vote.counts, { a: 0, b: 1 });
    assert.equal(state.board.vote.total, 1); assert.equal(state.board.vote.uniqueVoters, 1);
    assert.equal(state.board.metrics.acceptedVotes, 2); assert.equal(state.board.ingress.generation, initial.board.ingress.generation);
  } finally { f.host.stop(); }
});

test('ordinary chat may bind first scope without creating votes or source requests', async () => {
  const f = fixture();
  try {
    await f.receiving(); await f.emit(f.notification({ text: 'ordinary synthetic chat' }));
    const state = f.host.getState(); assert.equal(state.binding.phase, 'bound');
    assert.equal(state.board.vote.total, 0); assert.equal(state.board.sourceCue.requestCount, 0);
    assert.equal(state.board.vote.phase, 'idle'); assertPublic(state);
  } finally { f.host.stop(); }
});

test('delivery/chat replays do not change staged tally or extend the first lease', async () => {
  const f = fixture();
  try {
    await f.voting(); const packet = f.notification({ id: 'replayed-chat' }); await f.emit(packet);
    const before = f.host.getState(); await f.clock.advance(500);
    await f.emit(packet); await f.emit(f.notification({ id: 'replayed-chat', text: '!vote b' }));
    const state = f.host.getState(); assert.deepEqual(state.board.vote, before.board.vote);
    assert.deepEqual(state.board.ingress, before.board.ingress); assertPublic(state);
  } finally { f.host.stop(); }
});

test('original metadata timestamp remains authoritative for votes made before the round opened', async () => {
  const f = fixture();
  try {
    await f.receiving(); await f.clock.advance(100); f.host.openVote(1_000);
    await f.emit(f.notification({ timestamp: BASE_TIME, id: 'before-round' }));
    assert.equal(f.host.getState().binding.phase, 'bound'); assert.equal(f.host.getState().board.vote.total, 0);
    await f.emit(f.notification({ timestamp: f.clock.now(), id: 'inside-round' }));
    assert.equal(f.host.getState().board.vote.total, 1); assertPublic(f.host.getState());
  } finally { f.host.stop(); }
});

test('vote closes exactly at its deadline while ingress lease and transport remain separate', async () => {
  const f = fixture();
  try {
    await f.voting(grant(), 1_000); await f.clock.advance(999);
    await f.emit(f.notification({ userId: '200' })); assert.equal(f.host.getState().board.vote.total, 1);
    await f.clock.advance(1); await f.emit(f.notification({ userId: '201' }));
    const state = f.host.getState(); assert.equal(state.board.vote.phase, 'closed'); assert.equal(state.board.vote.total, 1);
    assert.equal(state.binding.phase, 'bound'); assert.equal(state.session.phase, 'receiving'); assertPublic(state);
  } finally { f.host.stop(); }
});

test('simulation retains its original API, counts and caches independently in both directions', async () => {
  const f = fixture();
  try {
    await f.voting(); const sim = f.host.simulation; sim.openVote(); sim.setConnection('connected');
    const event = { id: 'same-id-one', userId: '200', text: '!vote a', origin: 'simulated', timestamp: BASE_TIME };
    assert.equal(sim.processEvent(event).code, 'vote_recorded'); await f.emit(f.notification({ id: event.id }));
    await f.emit(f.notification({ id: 'same-id-two', userId: '201', text: '!vote b' }));
    assert.equal(sim.processEvent({ ...event, id: 'same-id-two', userId: '201', text: '!vote b' }).code, 'vote_recorded');
    assert.deepEqual(f.host.getState().board.vote.counts, { a: 1, b: 1 }); assert.deepEqual(sim.getState().vote.counts, { a: 1, b: 1 });
    sim.reset(); assert.equal(f.host.getState().board.vote.total, 2); assert.equal(sim.getState().vote.total, 0);
    assert.equal(sim.processEvent({ ...event, origin: 'transport-unverified' }).code, 'unsupported_origin'); assertPublic(f.host.getState());
  } finally { f.host.stop(); }
});

test('source requests use only staged fixed cue window without requiring a vote', async () => {
  const f = fixture({ config: { boardOptions: { sourceCueMs: 1_000 } } });
  try {
    await f.receiving(); const first = f.notification({ text: '!source' }); await f.emit(first);
    const opened = f.host.getState(); assert.equal(opened.board.sourceCue.active, true);
    assert.equal(opened.board.sourceCue.origin, 'ingress-harness'); assert.equal(opened.board.sourceCue.requestCount, 1);
    await f.clock.advance(500); await f.emit(first); await f.emit(f.notification({ text: '!source' }));
    const active = f.host.getState(); assert.equal(active.board.sourceCue.requestCount, 2);
    assert.equal(active.board.sourceCue.expiresAt, opened.board.sourceCue.expiresAt);
    assert.equal(active.board.vote.total, 0); assert.equal(f.host.simulation.getState().sourceCue.requestCount, 0);
    await f.clock.advance(500); assert.equal(f.host.getState().board.sourceCue.active, false);
    await f.emit(f.notification({ text: '!source' })); assert.equal(f.host.getState().board.sourceCue.requestCount, 3);
    f.socket().onDisconnect(); const disconnected = f.host.getState();
    assert.equal(disconnected.board.connection.status, 'disconnected'); assert.equal(disconnected.board.sourceCue.active, false);
    assert.equal(disconnected.board.sourceCue.requestCount, 3); assertPublic(disconnected);
  } finally { f.host.stop(); }
});

test('stale source command preserves the original timestamp and cannot open a cue', async () => {
  const f = fixture({ config: { boardOptions: { sourceCueMs: 1_000 } } });
  try {
    await f.receiving(); await f.clock.advance(1_001); await f.emit(f.notification({ text: '!source', timestamp: BASE_TIME }));
    const state = f.host.getState(); assert.equal(state.binding.phase, 'bound'); assert.equal(state.board.sourceCue.active, false);
    assert.equal(state.board.sourceCue.requestCount, 0); assertPublic(state);
  } finally { f.host.stop(); }
});

test('refresh retires old cue immediately and binds only after a new run actually delivers an event', async () => {
  const pending = deferred(); const f = fixture({ exchangeImpl: () => pending.promise });
  try {
    await f.voting(); await f.emit(f.notification()); await f.emit(f.notification({ text: '!source' }));
    const before = f.host.getState(); const task = f.host.refresh(); await flush();
    const waiting = f.host.getState(); assert.equal(waiting.board.connection.status, 'disconnected'); assert.equal(waiting.board.sourceCue.active, false);
    assert.equal(waiting.board.sourceCue.requestCount, 1); assert.deepEqual(waiting.board.vote, before.board.vote);
    assert.equal(f.socket(1).signal.aborted, true);
    pending.resolve(grant({ accessToken: `${ACCESS}_NEW` })); assertResult(await task, 'refreshed');
    await f.emit(f.welcome(2), 2); assert.equal(f.host.getState().binding.phase, 'awaiting_scope');
    assert.equal(f.host.getState().board.connection.status, 'disconnected');
    await f.emit(f.notification({ number: 2, text: '!vote b' }), 2);
    const state = f.host.getState(); assert.deepEqual(state.board.vote.counts, { a: 0, b: 1 });
    assert.equal(state.board.vote.closesAt, before.board.vote.closesAt); assert.ok(state.board.ingress.generation > before.board.ingress.generation); assertPublic(state);
  } finally { f.host.stop(); }
});

test('fresh scope after refresh preserves staged replay memory and old callbacks cannot clear new cue or tally', async () => {
  const f = fixture({ fixedSessionId: 'PRIVATE_SESSION_REUSED' });
  try {
    await f.voting(); await f.emit(f.notification({ id: 'persistent-staged-replay' })); const old = f.socket(1);
    const before = f.host.getState(); assert.equal((await f.host.refresh()).ok, true); await f.emit(f.welcome(2), 2);
    await f.emit(f.notification({ number: 2, id: 'persistent-staged-replay', text: '!vote b' }), 2);
    assert.deepEqual(f.host.getState().board.vote, before.board.vote);
    assert.equal(f.host.getState().board.metrics.duplicates, before.board.metrics.duplicates + 1);
    await f.emit(f.notification({ number: 2, text: '!source' }), 2); const active = f.host.getState();
    old.onError(new Error(RAW_ERROR)); old.onDisconnect(); await old.onFrame(JSON.stringify(f.notification({ number: 1, text: '!vote b' })));
    assert.deepEqual(f.host.getState(), active); assert.equal(active.board.sourceCue.active, true); assertPublic(active);
  } finally { f.host.stop(); }
});

test('busy lifecycle calls preserve active scope, cue, lease and the outstanding refresh operation', async () => {
  const pending = deferred(); const f = fixture({ exchangeImpl: () => pending.promise });
  try {
    await f.voting(); await f.emit(f.notification({ text: '!source' })); const before = f.host.getState();
    assertResult(await f.host.start(grant()), 'busy'); assert.deepEqual(f.host.getState(), before);
    const refresh = f.host.refresh(); await flush(); const during = f.host.getState();
    assertResult(await f.host.refresh(), 'busy'); assertResult(await f.host.start(grant()), 'busy');
    assert.deepEqual(f.host.getState(), during); assert.equal(f.calls.exchange.length, 1);
    pending.resolve(grant()); assert.equal((await refresh).ok, true);
  } finally { f.host.stop(); }
});

test('lease expires at its exact deadline and further old-scope events cannot silently renew it', async () => {
  const f = fixture({ config: { leaseMs: 1_000 } });
  try {
    await f.voting(); await f.emit(f.notification()); const first = f.host.getState();
    await f.clock.advance(999); await f.emit(f.notification({ userId: '201' })); assert.equal(f.host.getState().board.vote.total, 2);
    assert.equal(f.host.getState().board.ingress.expiresAt, first.board.ingress.expiresAt);
    await f.clock.advance(1); const expired = f.host.getState();
    assert.equal(expired.binding.phase, 'expired'); assert.equal(expired.board.connection.status, 'disconnected'); assert.equal(expired.board.vote.total, 2);
    assert.equal(expired.board.vote.closesAt, first.board.vote.closesAt); assert.equal(f.socket().signal.aborted, true);
    await f.emit(f.notification({ userId: '202' }));
    assert.equal(f.host.getState().board.vote.total, 2); assert.equal(f.host.getState().board.ingress.generation, first.board.ingress.generation);
    assertResult(await f.host.refresh(), 'not_started');
    assert.equal((await f.host.start(grant())).ok, true); await f.emit(f.welcome(2), 2); await f.emit(f.notification({ number: 2, userId: '202' }), 2);
    assert.equal(f.host.getState().board.vote.total, 3); assertPublic(f.host.getState());
  } finally { f.host.stop(); }
});

test('reset clears round/cue and revokes scope; reopening alone cannot authorize old callbacks', async () => {
  const f = fixture();
  try {
    await f.voting(); await f.emit(f.notification({ id: 'reset-replay' })); await f.emit(f.notification({ text: '!source' })); const old = f.socket();
    assertResult(f.host.reset(), 'reset'); const reset = f.host.getState();
    assert.equal(reset.board.vote.total, 0); assert.equal(reset.board.vote.phase, 'idle'); assert.equal(reset.board.sourceCue.requestCount, 0);
    assert.equal(reset.board.connection.status, 'disconnected'); assert.equal(reset.binding.phase, 'retired');
    f.host.openVote(); await old.onFrame(JSON.stringify(f.notification({ id: 'old-after-reset' })));
    assert.equal(f.host.getState().board.vote.total, 0); assertResult(await f.host.refresh(), 'not_started');
    assert.equal((await f.host.start(grant())).ok, true); await f.emit(f.welcome(2), 2);
    await f.emit(f.notification({ number: 2, id: 'reset-replay' }), 2); assert.equal(f.host.getState().board.vote.total, 0);
    await f.emit(f.notification({ number: 2, id: 'new-after-reset' }), 2); assert.equal(f.host.getState().board.vote.total, 1); assertPublic(f.host.getState());
  } finally { f.host.stop(); }
});

test('revoke clears staged cue while retaining totals/window and a new explicit start can bind again', async () => {
  const f = fixture();
  try {
    await f.voting(); await f.emit(f.notification()); await f.emit(f.notification({ text: '!source' })); const before = f.host.getState();
    assertResult(f.host.revoke(), 'revoked'); const retired = f.host.getState();
    assert.equal(retired.binding.phase, 'retired'); assert.equal(retired.board.sourceCue.active, false); assert.equal(retired.board.sourceCue.requestCount, 1);
    assert.deepEqual(retired.board.vote, before.board.vote); assert.equal(retired.board.connection.status, 'disconnected');
    assert.equal((await f.host.start(grant())).ok, true); await f.emit(f.welcome(2), 2); await f.emit(f.notification({ number: 2, userId: '201' }), 2);
    assert.equal(f.host.getState().board.vote.total, 2); assertPublic(f.host.getState());
  } finally { f.host.stop(); }
});

test('stop is terminal and leaves simulation usable while old staged callbacks cannot tally', async () => {
  const f = fixture(); await f.voting(); await f.emit(f.notification()); const old = f.socket();
  assertResult(f.host.stop(), 'stopped'); assert.equal(f.host.getState().binding.phase, 'stopped');
  assertResult(f.host.stop(), 'stopped'); assertResult(await f.host.start(grant()), 'stopped'); assertResult(await f.host.refresh(), 'stopped');
  await old.onFrame(JSON.stringify(f.notification({ userId: '201' }))); assert.equal(f.host.getState().board.vote.total, 1);
  const sim = f.host.simulation; sim.openVote(); sim.setConnection('connected');
  assert.equal(sim.processEvent({ id: 'simulation-after-stop', userId: '200', text: '!vote a', origin: 'simulated' }).code, 'vote_recorded'); assertPublic(f.host.getState());
});

test('invalid acknowledgement cannot create a binding or poison a same-ID event in a later valid run', async () => {
  const f = fixture({ fetchImpl: (call, count) => streamResponse(call.kind === 'validate' ? validationBody() : subscriptionBody(count === 1 ? 'wrong-session' : call.body.transport.session_id), { status: call.kind === 'validate' ? 200 : 202 }).response });
  try {
    f.host.openVote(); await f.host.start(grant()); assert.equal((await f.emit(f.welcome())).ok, false);
    await f.emit(f.notification({ id: 'ack-not-poisoned' })); assert.equal(f.host.getState().board.vote.total, 0); assert.equal(f.host.getState().board.ingress.generation, 0);
    assert.equal((await f.host.start(grant())).ok, true); await f.emit(f.welcome(2), 2); await f.emit(f.notification({ number: 2, id: 'ack-not-poisoned' }), 2);
    assert.equal(f.host.getState().board.vote.total, 1); assertPublic(f.host.getState());
  } finally { f.host.stop(); }
});

test('wrong channel, shared-chat source, malformed chat and future timestamps cannot bind or consume IDs', async () => {
  const f = fixture();
  try {
    await f.voting();
    const bad = [ { event: { broadcaster_user_id: '200' } }, { event: { source_broadcaster_user_id: '200' } },
      { event: { chatter_user_id: 'not-numeric' } }, { text: 'x'.repeat(301) }, { timestamp: BASE_TIME + 5_001 } ];
    for (const [index, changed] of bad.entries()) {
      const before = f.host.getState(); const id = `rejected-no-poison-${index}`;
      await f.emit(f.notification({ id, ...changed }));
      assert.deepEqual(f.host.getState().board, before.board);
      await f.emit(f.notification({ id, userId: String(200 + index) }));
      assert.equal(f.host.getState().board.vote.total, index + 1);
    }
    assertPublic(f.host.getState());
  } finally { f.host.stop(); }
});

test('failed refreshed identity retires scope and cue without changing existing votes or deadline', async () => {
  const f = fixture({ fetchImpl: (call, count) => streamResponse(call.kind === 'validate' ? validationBody(count === 2 ? { user_id: '200' } : {}) : subscriptionBody(call.body.transport.session_id), { status: call.kind === 'validate' ? 200 : 202 }).response });
  try {
    await f.voting(); await f.emit(f.notification()); await f.emit(f.notification({ text: '!source' })); const old = f.socket(); const before = f.host.getState();
    const failed = await f.host.refresh(); assert.equal(failed.ok, false); assertResult(failed);
    const after = f.host.getState(); assert.deepEqual(after.board.vote, before.board.vote); assert.equal(after.board.sourceCue.active, false);
    assert.equal(after.board.connection.status, 'disconnected'); assert.equal(f.calls.connect.length, 1);
    await old.onFrame(JSON.stringify(f.notification({ userId: '201' }))); assert.equal(f.host.getState().board.vote.total, 1); assertPublic(after);
  } finally { f.host.stop(); }
});

test('hanging subscription body never binds, and timeout or failed cleanup leaks no raw data', async () => {
  const hanging = streamResponse(null, { status: 202, read: () => new Promise(() => {}), cancel: () => Promise.reject(new Error(RAW_ERROR)) });
  const f = fixture({ config: { ioTimeoutMs: 20 }, fetchImpl: (call) => call.kind === 'validate' ? streamResponse(validationBody()).response : hanging.response });
  try {
    f.host.openVote(); await f.host.start(grant()); const waiting = f.emit(f.welcome()); await flush();
    await f.clock.advance(20); assert.equal((await waiting).ok, false);
    const state = f.host.getState(); assert.equal(state.board.vote.total, 0); assert.equal(state.board.ingress.generation, 0);
    assert.equal(state.board.connection.status, 'disconnected'); assert.ok(hanging.stats.cancels >= 1); assertPublic(state);
  } finally { f.host.stop(); }
});

test('revoke pending validation and late HTTP response cannot first-bind an old scope after restart', async () => {
  const late = deferred(); const f = fixture({ fetchImpl: (call, count) => {
    if (call.kind === 'validate' && count === 1) return late.promise;
    return streamResponse(call.kind === 'validate' ? validationBody() : subscriptionBody(call.body.transport.session_id), { status: call.kind === 'validate' ? 200 : 202 }).response;
  } });
  try {
    f.host.openVote(); const starting = f.host.start(grant()); await flush(); f.host.revoke(); assert.equal((await starting).ok, false);
    assert.equal((await f.host.start(grant())).ok, true); await f.emit(f.welcome()); await f.emit(f.notification()); const bound = f.host.getState();
    late.resolve(streamResponse(validationBody()).response); await flush();
    assert.deepEqual(f.host.getState(), bound); assert.equal(f.calls.connect.length, 1); assertPublic(bound);
  } finally { f.host.stop(); }
});

test('stop settles ignored refresh exchange and late grant cannot reactivate staged capability', async () => {
  const pending = deferred(); const f = fixture({ exchangeImpl: () => pending.promise });
  await f.voting(); await f.emit(f.notification()); await f.emit(f.notification({ text: '!source' })); const before = f.host.getState();
  const task = f.host.refresh(); await flush(); assertResult(f.host.stop(), 'stopped'); assert.equal((await task).ok, false);
  pending.resolve(grant()); await flush(); const after = f.host.getState();
  assert.deepEqual(after.board.vote, before.board.vote); assert.equal(after.board.sourceCue.active, false); assert.equal(after.binding.phase, 'stopped');
  assert.equal(after.board.connection.status, 'disconnected'); assert.equal(f.calls.connect.length, 1); assert.equal(f.clock.pending(), 0); assertPublic(after);
});

test('reset during pending refresh retires old scope before explicit restart and late result cannot clear new binding', async () => {
  const pending = deferred(); const f = fixture({ exchangeImpl: () => pending.promise });
  try {
    await f.voting(); await f.emit(f.notification()); const task = f.host.refresh(); await flush(); f.host.reset(); assert.equal((await task).ok, false);
    f.host.openVote(); assert.equal((await f.host.start(grant())).ok, true); await f.emit(f.welcome(2), 2); await f.emit(f.notification({ number: 2, userId: '201' }), 2);
    const before = f.host.getState(); pending.resolve(grant()); await flush();
    assert.deepEqual(f.host.getState(), before); assert.equal(before.board.vote.total, 1); assertPublic(before);
  } finally { f.host.stop(); }
});

test('hostile asynchronous socket close stays nonblocking while refresh and stop retire staged authority', async () => {
  let closes = 0; const f = fixture({ connectImpl: () => ({ close() { closes += 1; return new Promise(() => {}); } }) });
  await f.voting(); await f.emit(f.notification({ text: '!source' }));
  assertResult(await f.host.refresh(), 'refreshed'); assert.equal(f.host.getState().board.sourceCue.active, false);
  await f.emit(f.welcome(2), 2); await f.emit(f.notification({ number: 2 })); assert.equal(f.host.getState().board.vote.total, 1);
  const stopped = f.host.stop(); assert.equal(typeof stopped.then, 'undefined'); assertResult(stopped, 'stopped');
  assert.equal(closes, 2); assert.equal(f.host.getState().board.connection.status, 'disconnected');
});

test('cleanup reentry cannot publish a new scope into the current refresh or undo terminal stop', async () => {
  let f; const reentered = [];
  f = fixture({ connectImpl: () => ({ close() { reentered.push(f.host.start(grant())); return Promise.reject(new Error(RAW_ERROR)); } }) });
  await f.voting(); await f.emit(f.notification()); const before = f.host.getState();
  assertResult(await f.host.refresh(), 'refreshed'); assertResult(await reentered[0], 'busy');
  assert.deepEqual(f.host.getState().board.vote, before.board.vote);
  f.host.stop(); assertResult(await reentered[1], 'stopped'); await flush(); assertPublic(f.host.getState());
});

test('private board controls preserve lease when legal and reject invalid duration without state mutation', async () => {
  const f = fixture();
  try {
    await f.voting(); await f.emit(f.notification()); const before = f.host.getState();
    assertResult(f.host.openVote(999), 'invalid_duration'); assert.deepEqual(f.host.getState(), before);
    assertResult(f.host.closeVote(), 'vote_closed'); const lease = f.host.getState().board.ingress;
    assertResult(f.host.openVote(1_000), 'vote_opened'); assert.deepEqual(f.host.getState().board.ingress, lease);
    assert.equal(f.host.getState().board.vote.total, 0); assertPublic(f.host.getState());
  } finally { f.host.stop(); }
});

test('public snapshots cannot mutate nested board/session state and disclose no scope or original input', async () => {
  const f = fixture();
  try {
    await f.voting(); const initial = f.host.getState();
    assert.throws(() => { initial.board.vote.counts.a = 999; });
    assert.throws(() => { initial.binding.phase = 'bound'; });
    await f.emit(f.notification()); const after = f.host.getState();
    assert.equal(initial.board.vote.total, 0); assert.equal(after.board.vote.total, 1);
    assertPublic(initial); assertPublic(after);
    assert.equal(f.host.scope, undefined); assert.equal(f.host.capability, undefined); assert.equal(f.host.processEvent, undefined);
  } finally { f.host.stop(); }
  let clockFailed = false;
  const broken = fixture({ config: { now: () => { if (clockFailed) throw new Error(RAW_ERROR); return BASE_TIME; } } });
  try {
    await broken.voting(); await broken.emit(broken.notification({ text: '!source' }));
    assert.equal(broken.host.getState().board.sourceCue.active, true);
    clockFailed = true; const failed = broken.host.getState();
    assert.equal(failed.board.connection.status, 'disconnected'); assert.equal(failed.board.sourceCue.active, false); assertPublic(failed);
    clockFailed = false; const recovered = broken.host.getState();
    assert.equal(recovered.board.connection.status, 'disconnected'); assert.equal(recovered.board.sourceCue.active, false);
    await broken.emit(broken.notification({ text: '!source' }));
    await broken.emit(broken.notification({ text: '!vote a' }));
    assert.equal(broken.host.getState().board.sourceCue.requestCount, 1); assert.equal(broken.host.getState().board.vote.total, 0);
    assertPublic(broken.host.getState());
    assert.equal((await broken.host.start(grant())).ok, true); await broken.emit(broken.welcome(2), 2);
    await broken.emit(broken.notification({ number: 2, text: '!source' }), 2);
    const fresh = broken.host.getState(); assert.equal(fresh.binding.phase, 'bound');
    assert.equal(fresh.board.sourceCue.active, true); assert.equal(fresh.board.sourceCue.requestCount, 2); assertPublic(fresh);
  } finally { clockFailed = false; broken.host.stop(); }
});
