import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCredentialSessionHost } from '../src/credential-session-host.mjs';
import { createBoard } from '../src/engine.mjs';

// Actual local modules with synthetic injected dependencies only; no real token,
// network, Twitch account, OAuth service, WebSocket or staged ingress is used.
const CLIENT = 'synthetichost01';
const CHANNEL = '100';
const ACCESS = 'SYNTHETIC_ACCESS_CANARY_NOT_A_REAL_TOKEN';
const REFRESH = 'SYNTHETIC_REFRESH_CANARY_NOT_A_REAL_TOKEN';
const RAW_ERROR = 'SYNTHETIC_RAW_ERROR_CANARY_DO_NOT_PUBLISH';
const BASE_TIME = Date.parse('2026-10-25T08:00:00.000Z');
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
const SUBSCRIBE_URL = 'https://api.twitch.tv/helix/eventsub/subscriptions';
const flush = () => new Promise((resolve) => setImmediate(resolve));
const runFile = promisify(execFile);

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function observe(task) { return task.then((value) => ({ value }), (error) => ({ error })); }
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
    callbacks: () => [...timers.values()].map((timer) => timer.callback),
    async advance(milliseconds) {
      const target = time + milliseconds; let count = 0;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.deadline <= target).sort((a, b) => a[1].deadline - b[1].deadline)[0];
        if (!next) break;
        if (++count > 1_000) throw new Error('Synthetic timer loop exceeded bound.');
        const [id, timer] = next; timers.delete(id); time = timer.deadline;
        await timer.callback(); await flush();
      }
      time = target; await flush();
    },
  };
}
function streamResponse(body, { status = 200, read, cancel } = {}) {
  let sent = false;
  const stats = { reads: 0, cancels: 0, releases: 0 };
  const reader = {
    async read() {
      stats.reads += 1;
      if (read) return read(stats.reads);
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
  return { data: [{
    id: `PRIVATE_SUB_${sessionId}`, status: 'enabled', type: 'channel.chat.message', version: '1',
    condition: { broadcaster_user_id: CHANNEL, user_id: CHANNEL },
    transport: { method: 'websocket', session_id: sessionId, connected_at: new Date(BASE_TIME).toISOString() },
  }] };
}
function deeplyFrozen(value) {
  if (value && typeof value === 'object') {
    assert.equal(Object.isFrozen(value), true);
    for (const child of Object.values(value)) {
      assert.notEqual(typeof child, 'function'); deeplyFrozen(child);
    }
  }
}
function assertNoLeak(value) {
  assert.doesNotMatch(JSON.stringify(value), /SYNTHETIC_(ACCESS|REFRESH|RAW_ERROR)_CANARY|PRIVATE_SESSION_|PRIVATE_SUB_|!vote|accessToken|refreshToken|Authorization|headers|user:read:chat|scopes/);
}
function assertPrivate(value) {
  assertNoLeak(value);
  deeplyFrozen(value);
}
function assertPublic(state) {
  assert.equal(state.networkConnected, false);
  assert.equal(state.realTwitchConnected, false);
  assert.equal(state.authorizationVerified, false);
  assertPrivate(state);
}

function fixture({ config = {}, fetchImpl, connectImpl, exchangeImpl, onEvent } = {}) {
  const clock = manualClock(); const calls = { fetch: [], connect: [], exchange: [], close: [], timeline: [] }; const events = [];
  let delivery = 0;
  const host = createCredentialSessionHost({
    clientId: CLIENT, broadcasterId: CHANNEL, readerId: CHANNEL,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    fetchImpl: async (url, options) => {
      const kind = url === VALIDATE_URL ? 'validate' : 'subscribe';
      const call = { url, options, kind, body: options.body ? JSON.parse(options.body) : undefined };
      calls.fetch.push(call); calls.timeline.push(kind);
      if (fetchImpl) return fetchImpl(call, calls.fetch.filter((item) => item.kind === kind).length);
      return streamResponse(kind === 'validate' ? validationBody() : subscriptionBody(call.body.transport.session_id), { status: kind === 'validate' ? 200 : 202 }).response;
    },
    connect: async (callbacks) => {
      const number = calls.connect.length + 1;
      const connection = { callbacks, number, handle: { close() { calls.close.push(number); calls.timeline.push(`close${number}`); } } };
      calls.connect.push(connection); calls.timeline.push(`connect${number}`);
      return connectImpl ? connectImpl(callbacks, connection) : connection.handle;
    },
    exchange: (parameters) => {
      calls.exchange.push(parameters); calls.timeline.push('exchange');
      return exchangeImpl ? exchangeImpl(parameters, calls.exchange.length) : grant({ accessToken: `${ACCESS}_ROTATED`, refreshToken: `${REFRESH}_ROTATED` });
    },
    onEvent: onEvent ?? ((event) => { events.push(event); }),
    ...config,
  });
  const sessionId = (number = calls.connect.length) => `PRIVATE_SESSION_${number}`;
  const metadata = (type, sub = false) => ({
    message_id: `synthetic-delivery-${++delivery}`, message_type: type, message_timestamp: new Date(clock.now()).toISOString(),
    ...(sub ? { subscription_type: 'channel.chat.message', subscription_version: '1' } : {}),
  });
  const welcome = (number = calls.connect.length) => ({ metadata: metadata('session_welcome'), payload: { session: { id: sessionId(number), status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null } } });
  const keepalive = () => ({ metadata: metadata('session_keepalive'), payload: {} });
  function notification(number = calls.connect.length, overrides = {}) {
    return {
      metadata: metadata('notification', true),
      payload: { subscription: subscriptionBody(sessionId(number)).data[0], event: {
        broadcaster_user_id: CHANNEL, chatter_user_id: '200', message_id: `private-chat-${delivery}`, message: { text: '!vote a', fragments: [] }, ...overrides,
      } },
    };
  }
  const socket = (number = calls.connect.length) => calls.connect[number - 1].callbacks;
  const emit = (frame, number = calls.connect.length) => socket(number).onFrame(typeof frame === 'string' ? frame : JSON.stringify(frame));
  async function receiving(input = grant()) {
    const result = await host.start(input); assert.equal(result.ok, true);
    const subscribed = await emit(welcome()); assert.equal(subscribed.ok, true);
    assertPublic(host.getState()); return result;
  }
  return { host, calls, events, clock, sessionId, welcome, notification, keepalive, socket, emit, receiving };
}

function assertResult(result, code) {
  assert.equal(typeof result.ok, 'boolean');
  assert.equal(typeof result.code, 'string');
  assert.equal(typeof result.message, 'string');
  if (code) assert.equal(result.code, code);
  assertPublic(result.state); assertPrivate(result);
  assert.deepEqual(Object.keys(result).sort(), ['code', 'message', 'ok', 'state']);
}

test('host is inert and exposes a frozen lifecycle interface without credentials or staged board access', () => {
  const f = fixture();
  assert.equal(Object.isFrozen(f.host), true);
  assert.deepEqual(Object.keys(f.host).sort(), ['getState', 'refresh', 'revoke', 'start', 'stop']);
  assert.equal(f.host.getState().mode, 'credential-session-host-harness');
  assert.equal(f.host.getState().phase, 'idle');
  assert.equal(f.host.getState().busy, false);
  assert.equal(f.host.getState().transport, null);
  assert.equal(f.calls.fetch.length + f.calls.connect.length + f.calls.exchange.length, 0);
  assert.equal(f.clock.pending(), 0); assertPublic(f.host.getState());
});

test('constructor requires explicit own-channel dependencies and rejects unknown/getter options', () => {
  const base = { clientId: CLIENT, broadcasterId: CHANNEL, readerId: CHANNEL, fetchImpl: () => {}, connect: () => {}, exchange: () => {} };
  for (const input of [null, [], {}, { ...base, readerId: '200' }, { ...base, clientId: 'unsafe-client' },
    { ...base, fetchImpl: undefined }, { ...base, connect: undefined }, { ...base, exchange: undefined },
    { ...base, ioTimeoutMs: 0 }, { ...base, refreshTimeoutMs: 60_001 }, { ...base, onEvent: null }, { ...base, extra: true }]) {
    assert.throws(() => createCredentialSessionHost(input), (error) => {
      assert.equal(error.message, 'invalid_input'); assert.equal(Object.hasOwn(error, 'cause'), false); return true;
    });
  }
  let reads = 0; const getter = { ...base };
  Object.defineProperty(getter, 'fetchImpl', { enumerable: true, get() { reads += 1; throw new Error(RAW_ERROR); } });
  assert.throws(() => createCredentialSessionHost(getter), /invalid_input/); assert.equal(reads, 0);
});

test('start validates the private access token before connect and subscribes only after welcome', async () => {
  const f = fixture();
  try {
    const started = await f.host.start(grant()); assertResult(started, 'started'); assert.equal(started.ok, true);
    assert.deepEqual(f.calls.timeline, ['validate', 'connect1']);
    assert.deepEqual(Object.keys(f.socket()).sort(), ['onDisconnect', 'onError', 'onFrame', 'signal']);
    assert.equal(f.calls.fetch[0].url, VALIDATE_URL);
    assert.deepEqual(f.calls.fetch[0].options.headers, { Authorization: `OAuth ${ACCESS}` });
    assert.equal(f.host.getState().transport.phase, 'awaiting_welcome');
    assert.equal(f.calls.fetch.filter((call) => call.kind === 'subscribe').length, 0);
    assert.equal((await f.emit(f.welcome())).ok, true);
    const call = f.calls.fetch.find((item) => item.kind === 'subscribe');
    assert.equal(call.url, SUBSCRIBE_URL);
    assert.deepEqual(call.options.headers, { Authorization: `Bearer ${ACCESS}`, 'Client-Id': CLIENT, 'Content-Type': 'application/json' });
    assert.deepEqual(call.body, { type: 'channel.chat.message', version: '1', condition: { broadcaster_user_id: CHANNEL, user_id: CHANNEL }, transport: { method: 'websocket', session_id: f.sessionId() } });
    assert.equal(f.host.getState().phase, 'receiving'); assertPublic(f.host.getState());
  } finally { f.host.stop(); }
});

test('a pending validation body prevents connect and stop aborts/settles the original start', async () => {
  const hanging = streamResponse(null, { read: () => new Promise(() => {}) });
  const f = fixture({ fetchImpl: () => hanging.response });
  const pending = f.host.start(grant()); await flush();
  assert.equal(f.calls.connect.length, 0); assert.equal(f.host.getState().busy, true);
  const stop = f.host.stop(); assertResult(stop, 'stopped');
  const result = await pending; assert.equal(result.ok, false); assertResult(result);
  assert.equal(f.calls.fetch[0].options.signal.aborted, true);
  await flush();
  assert.ok(hanging.stats.cancels >= 1); assert.equal(f.clock.pending(), 0); assert.equal(f.calls.connect.length, 0);
});

test('malformed grant/scope input is rejected before any HTTP or socket work without reading getters', async () => {
  let reads = 0; const getter = grant();
  Object.defineProperty(getter, 'accessToken', { enumerable: true, get() { reads += 1; throw new Error(RAW_ERROR); } });
  for (const input of [null, {}, grant({ scopes: ['user:read:chat', 'user:write:chat'] }), grant({ accessToken: '\r\n' }), getter]) {
    const f = fixture(); const result = await f.host.start(input);
    assert.equal(result.ok, false); assertResult(result, 'invalid_grant');
    assert.equal(f.calls.fetch.length + f.calls.connect.length + f.calls.exchange.length, 0); assert.equal(f.clock.pending(), 0);
  }
  assert.equal(reads, 0);
});

test('validation rejects wrong client/user, missing read scope and HTTP401 without opening a socket', async () => {
  for (const body of [validationBody({ client_id: 'wrongclient' }), validationBody({ user_id: '200' }), validationBody({ scopes: [] }), null]) {
    const f = fixture({ fetchImpl: () => streamResponse(body ?? { message: `${RAW_ERROR}:${ACCESS}` }, { status: body ? 200 : 401 }).response });
    const result = await f.host.start(grant()); assert.equal(result.ok, false); assertResult(result);
    assert.equal(f.calls.connect.length, 0); assert.equal(f.clock.pending(), 0); assert.equal(f.host.getState().busy, false);
  }
});

test('a mismatched subscription acknowledgement never enables chat intake', async () => {
  const f = fixture({ fetchImpl: (call) => streamResponse(call.kind === 'validate' ? validationBody() : subscriptionBody('wrong-session'), { status: call.kind === 'validate' ? 200 : 202 }).response });
  await f.host.start(grant());
  const result = await f.emit(f.welcome()); assert.equal(result.ok, false); assertNoLeak(result);
  await f.emit(f.notification());
  assert.equal(f.events.length, 0); assert.notEqual(f.host.getState().phase, 'receiving'); assertPublic(f.host.getState());
  f.host.stop();
});

test('guarded callback projects only five frozen fields and the existing board refuses its unverified origin', async () => {
  const f = fixture(); const board = createBoard({ now: f.clock.now }); board.openVote(); board.setConnection('connected');
  try {
    await f.receiving(); await f.emit(f.notification());
    assert.equal(f.events.length, 1);
    const event = f.events[0];
    assert.deepEqual(Object.keys(event).sort(), ['id', 'origin', 'text', 'timestamp', 'userId']);
    assert.equal(event.origin, 'transport-unverified'); assert.equal(event.text, '!vote a');
    assert.equal(event.timestamp, BASE_TIME); assert.equal(Object.isFrozen(event), true);
    assert.equal(board.processEvent(event).code, 'unsupported_origin'); assert.equal(board.getState().vote.total, 0);
    assertPublic(f.host.getState());
  } finally { f.host.stop(); }
});

test('malformed input and cross-channel messages do not leak raw frames or reach the private callback', async () => {
  const f = fixture();
  try {
    await f.receiving();
    for (const raw of [`{${RAW_ERROR}:${ACCESS}`, f.notification(undefined, { broadcaster_user_id: '200' })]) {
      const result = await f.emit(raw); assert.equal(result.ok, false); assertNoLeak(result);
    }
    assert.equal(f.events.length, 0); assertPublic(f.host.getState());
  } finally { f.host.stop(); }
});

test('callback exceptions and rejected promises stop intake with sanitized public state', async () => {
  for (const onEvent of [() => { throw new Error(`${RAW_ERROR}:${ACCESS}`); }, () => Promise.reject({ refreshToken: REFRESH, message: RAW_ERROR })]) {
    const f = fixture({ onEvent }); await f.receiving();
    const result = await f.emit(f.notification()); assert.equal(result.ok, false); assertNoLeak(result);
    assert.equal(f.host.getState().phase, 'failed'); assertPublic(f.host.getState()); f.host.stop();
  }
});

test('refresh aborts/stops the old run before exchange, then validates a new token before a fresh socket/202', async () => {
  let f;
  f = fixture({ exchangeImpl: ({ refreshToken }) => {
    assert.equal(refreshToken, REFRESH);
    assert.equal(f.socket(1).signal.aborted, true);
    assert.ok(f.calls.close.includes(1));
    return grant({ accessToken: `${ACCESS}_ROTATED`, refreshToken: `${REFRESH}_ROTATED` });
  } });
  try {
    await f.receiving();
    const oldCallbacks = f.socket(1);
    const refreshed = await f.host.refresh(); assertResult(refreshed, 'refreshed'); assert.equal(refreshed.ok, true);
    assert.ok(f.calls.timeline.indexOf('close1') < f.calls.timeline.indexOf('exchange'));
    assert.equal(f.calls.connect.length, 2);
    const validates = f.calls.fetch.filter((call) => call.kind === 'validate');
    assert.equal(validates.length, 2); assert.equal(validates[1].options.headers.Authorization, `OAuth ${ACCESS}_ROTATED`);
    assert.equal(f.host.getState().phase, 'awaiting_welcome');
    const before = f.host.getState(); await oldCallbacks.onFrame(JSON.stringify(f.notification(1)));
    assert.deepEqual(f.host.getState(), before); assert.equal(f.events.length, 0);
    await f.emit(f.welcome(2), 2); await f.emit(f.notification(2), 2);
    assert.equal(f.events.length, 1);
    assert.equal(f.calls.fetch.filter((call) => call.kind === 'subscribe').at(-1).options.headers.Authorization, `Bearer ${ACCESS}_ROTATED`);
    assertPublic(f.host.getState());
  } finally { f.host.stop(); }
});

test('an old in-flight HTTP subscription is aborted before refresh exchange even if its body ignores abort', async () => {
  const hanging = streamResponse(null, { status: 202, read: () => new Promise(() => {}) }); let f;
  f = fixture({
    fetchImpl: (call) => call.kind === 'subscribe' ? hanging.response : streamResponse(validationBody()).response,
    exchangeImpl: () => {
      assert.equal(f.calls.fetch.find((call) => call.kind === 'subscribe').options.signal.aborted, true);
      assert.ok(hanging.stats.cancels >= 1);
      return grant({ accessToken: `${ACCESS}_ROTATED` });
    },
  });
  try {
    await f.host.start(grant()); const oldWelcome = f.emit(f.welcome()); await flush();
    const result = await f.host.refresh(); assert.equal(result.ok, true); assertResult(result, 'refreshed');
    assert.equal((await oldWelcome).ok, false); assert.equal(f.calls.exchange.length, 1); assert.equal(f.calls.connect.length, 2);
    assert.equal(f.events.length, 0); assertPublic(f.host.getState());
  } finally { f.host.stop(); }
});

test('fresh validation identity failure after refresh cannot connect or revive old callbacks', async () => {
  const f = fixture({ fetchImpl: (call, count) => streamResponse(call.kind === 'validate' ? validationBody(count === 2 ? { user_id: '200' } : {}) : subscriptionBody(call.body.transport.session_id), { status: call.kind === 'validate' ? 200 : 202 }).response });
  await f.receiving(); const callbacks = f.socket();
  const refreshed = await f.host.refresh(); assert.equal(refreshed.ok, false); assertResult(refreshed);
  assert.equal(f.calls.connect.length, 1); assert.equal(f.host.getState().phase, 'failed');
  await callbacks.onFrame(JSON.stringify(f.notification(1))); assert.equal(f.events.length, 0); assertPublic(f.host.getState());
  f.host.stop();
});

test('refresh exchange exceptions and malformed grants remain private and cannot open replacement sockets', async () => {
  for (const exchangeImpl of [() => { throw new Error(`${RAW_ERROR}:${REFRESH}`); }, () => Promise.reject(RAW_ERROR), () => ({ accessToken: ACCESS, error: RAW_ERROR })]) {
    const f = fixture({ exchangeImpl }); await f.receiving();
    const result = await f.host.refresh(); assert.equal(result.ok, false); assertResult(result);
    assert.equal(f.socket(1).signal.aborted, true); assert.equal(f.calls.connect.length, 1); assert.equal(f.clock.pending(), 0);
    f.host.stop();
  }
});

test('concurrent start/refresh calls cannot duplicate a pending refresh or replace its valid result', async () => {
  const pending = deferred(); const f = fixture({ exchangeImpl: () => pending.promise });
  await f.receiving(); const refresh = f.host.refresh(); await flush();
  assert.equal(f.host.getState().busy, true); assert.equal(f.host.getState().phase, 'refreshing');
  assertResult(await f.host.refresh(), 'busy'); assertResult(await f.host.start(grant({ accessToken: `${ACCESS}_UNWANTED` })), 'busy');
  assert.equal(f.calls.exchange.length, 1);
  pending.resolve(grant({ accessToken: `${ACCESS}_WINNER` }));
  const result = await refresh; assert.equal(result.ok, true); assertResult(result, 'refreshed');
  assert.equal(f.calls.fetch.filter((call) => call.kind === 'validate').at(-1).options.headers.Authorization, `OAuth ${ACCESS}_WINNER`);
  f.host.stop();
});

test('concurrent operations during first validation are busy and revoke settles the original start', async () => {
  const pending = deferred(); const f = fixture({ fetchImpl: () => pending.promise });
  const start = f.host.start(grant()); await flush();
  assertResult(await f.host.start(grant()), 'busy'); assertResult(await f.host.refresh(), 'busy');
  assertResult(f.host.revoke(), 'revoked'); const result = await start;
  assert.equal(result.ok, false); assertResult(result); assert.equal(f.host.getState().phase, 'revoked');
  pending.resolve(streamResponse(validationBody()).response); await flush();
  assert.equal(f.calls.connect.length, 0); assert.equal(f.clock.pending(), 0); assertPublic(f.host.getState()); f.host.stop();
});

test('refresh without an explicit started grant never invokes exchange', async () => {
  const f = fixture(); assertResult(await f.host.refresh(), 'not_started');
  f.host.revoke(); assertResult(await f.host.refresh(), 'not_started');
  f.host.stop(); assertResult(await f.host.refresh(), 'stopped');
  assert.equal(f.calls.exchange.length + f.calls.fetch.length + f.calls.connect.length, 0); assertPublic(f.host.getState());
});

test('revoke is restartable while old callbacks remain powerless over a new explicit start', async () => {
  const f = fixture(); await f.receiving(); const old = f.socket();
  const result = f.host.revoke(); assertResult(result, 'revoked'); assert.equal(old.signal.aborted, true);
  assert.equal((await f.host.start(grant({ accessToken: `${ACCESS}_RESTART` }))).ok, true);
  await f.emit(f.welcome(2), 2); const before = f.host.getState();
  old.onError(new Error(RAW_ERROR)); old.onDisconnect(); await old.onFrame(JSON.stringify(f.notification(1)));
  assert.deepEqual(f.host.getState(), before); assert.equal(f.events.length, 0);
  await f.emit(f.notification(2), 2); assert.equal(f.events.length, 1); f.host.stop();
});

test('stop is terminal/idempotent and does not await a hostile asynchronous connection close', async () => {
  for (const closeMode of ['hang', 'reject', 'throw']) {
    let closes = 0;
    const f = fixture({ connectImpl: () => ({ close() {
      closes += 1;
      if (closeMode === 'hang') return new Promise(() => {});
      if (closeMode === 'reject') return Promise.reject(new Error(`${RAW_ERROR}:${ACCESS}`));
      throw new Error(`${RAW_ERROR}:${ACCESS}`);
    } }) });
    await f.receiving(); const stopped = f.host.stop();
    assert.equal(typeof stopped.then, 'undefined'); assertResult(stopped, 'stopped');
    assertResult(f.host.stop(), 'stopped'); assertResult(await f.host.start(grant()), 'stopped');
    assert.equal(closes, 1); assert.equal(f.clock.pending(), 0); await flush(); assertPublic(f.host.getState());
  }
});

test('stop aborts/settles an ignored exchange and its late grant cannot revive the terminal host', async () => {
  const pending = deferred(); const f = fixture({ exchangeImpl: () => pending.promise }); await f.receiving();
  const task = f.host.refresh(); await flush(); assertResult(f.host.stop(), 'stopped');
  const result = await task; assert.equal(result.ok, false); assertResult(result);
  assert.equal(f.calls.exchange[0].signal.aborted, true); assert.equal(f.clock.pending(), 0);
  pending.resolve(grant({ accessToken: `${ACCESS}_LATE` })); await flush();
  assert.equal(f.calls.connect.length, 1); assert.equal(f.host.getState().phase, 'stopped'); assertPublic(f.host.getState());
});

test('revoke during ignored exchange permits a new start without accepting the obsolete grant', async () => {
  const pending = deferred(); const f = fixture({ exchangeImpl: () => pending.promise }); await f.receiving();
  const refresh = f.host.refresh(); await flush(); assertResult(f.host.revoke(), 'revoked');
  assert.equal((await refresh).ok, false);
  assert.equal((await f.host.start(grant({ accessToken: `${ACCESS}_REBOUND` }))).ok, true);
  await f.emit(f.welcome(2), 2); const before = f.host.getState();
  pending.resolve(grant({ accessToken: `${ACCESS}_OBSOLETE` })); await flush();
  assert.deepEqual(f.host.getState(), before);
  assert.equal(f.calls.fetch.filter((call) => call.kind === 'validate').at(-1).options.headers.Authorization, `OAuth ${ACCESS}_REBOUND`);
  await f.emit(f.notification(2), 2); assert.equal(f.events.length, 1); f.host.stop();
});

test('external refresh abort is bounded despite ignored signal and does not echo its reason', async () => {
  const pending = deferred(); const controller = new AbortController(); const f = fixture({ exchangeImpl: () => pending.promise });
  await f.receiving(); const task = f.host.refresh({ signal: controller.signal }); await flush();
  controller.abort(new Error(`${RAW_ERROR}:${REFRESH}`));
  const result = await task; assert.equal(result.ok, false); assertResult(result, 'aborted');
  assert.equal(f.calls.exchange[0].signal.aborted, true); assert.equal(f.clock.pending(), 0);
  pending.reject(new Error(RAW_ERROR)); await flush(); assertPublic(f.host.getState()); f.host.stop();
});

test('refresh timeout settles host ownership and late exchange completion cannot start a socket', async () => {
  const pending = deferred(); const f = fixture({ exchangeImpl: () => pending.promise, config: { refreshTimeoutMs: 20 } });
  await f.receiving(); const task = f.host.refresh(); await flush(); await f.clock.advance(20);
  const result = await task; assert.equal(result.ok, false); assertResult(result, 'refresh_timeout');
  assert.equal(f.calls.exchange[0].signal.aborted, true); assert.equal(f.clock.pending(), 0);
  pending.resolve(grant({ accessToken: `${ACCESS}_LATE` })); await flush();
  assert.equal(f.calls.connect.length, 1); assert.equal(f.host.getState().busy, false); assertPublic(f.host.getState()); f.host.stop();
});

test('pre-aborted and malformed refresh options never invoke exchange or descriptor getters', async () => {
  let reads = 0; const getter = {};
  Object.defineProperty(getter, 'signal', { enumerable: true, get() { reads += 1; throw new Error(RAW_ERROR); } });
  for (const options of [null, [], { signal: {} }, { extra: true }, getter]) {
    const f = fixture(); await f.receiving(); const result = await f.host.refresh(options);
    assert.equal(result.ok, false); assertResult(result, 'invalid_input'); assert.equal(f.calls.exchange.length, 0); f.host.stop();
  }
  const f = fixture(); await f.receiving(); const controller = new AbortController(); controller.abort(RAW_ERROR);
  const result = await f.host.refresh({ signal: controller.signal }); assert.equal(result.ok, false); assertResult(result, 'aborted');
  assert.equal(f.calls.exchange.length, 0); assert.equal(reads, 0); f.host.stop();
});

test('vault expiry at its exact deadline retires transport and observed expiry does not roll back', async () => {
  const f = fixture(); await f.receiving(grant({ expiresIn: 1 }));
  await f.clock.advance(999); assert.equal(f.host.getState().phase, 'receiving');
  await f.clock.advance(1); const state = f.host.getState();
  assert.equal(state.phase, 'expired'); assert.equal(f.socket().signal.aborted, true);
  assert.equal(f.clock.pending(), 0); f.clock.set(BASE_TIME);
  assert.equal(f.host.getState().phase, 'expired'); assertPublic(f.host.getState()); f.host.stop();
  const late = deferred(); const delayed = fixture({ fetchImpl: () => late.promise });
  const starting = delayed.host.start(grant({ expiresIn: 1 })); await flush();
  delayed.clock.set(BASE_TIME + 1_000); late.resolve(streamResponse(validationBody()).response);
  const result = await starting; assert.equal(result.ok, false); assertResult(result, 'credential_expired');
  assert.equal(delayed.calls.connect.length, 0); await flush();
  assert.equal(delayed.clock.pending(), 0); assertPublic(delayed.host.getState()); delayed.host.stop();
});

test('old credential expiry bounds an ignored refresh exchange earlier than refresh timeout', async () => {
  const pending = deferred(); const f = fixture({ exchangeImpl: () => pending.promise, config: { refreshTimeoutMs: 5_000 } });
  await f.receiving(grant({ expiresIn: 1 })); const task = f.host.refresh(); await flush();
  await f.clock.advance(1_000); const result = await task;
  assert.equal(result.ok, false); assertResult(result, 'credential_expired');
  assert.equal(f.calls.exchange[0].signal.aborted, true); assert.equal(f.clock.pending(), 0);
  pending.resolve(grant()); await flush(); assert.equal(f.calls.connect.length, 1); assertPublic(f.host.getState()); f.host.stop();
});

test('hanging validation body times out and cancels its reader without leaking body or callback errors', async () => {
  const hanging = streamResponse(null, { read: () => new Promise(() => {}), cancel: () => Promise.reject(new Error(RAW_ERROR)) });
  const f = fixture({ config: { ioTimeoutMs: 20 }, fetchImpl: () => hanging.response });
  const task = f.host.start(grant()); await flush(); await f.clock.advance(20);
  const result = await task; assert.equal(result.ok, false); assertResult(result);
  assert.equal(f.calls.fetch[0].options.signal.aborted, true); assert.ok(hanging.stats.cancels >= 1);
  assert.equal(f.calls.connect.length, 0); assert.equal(f.clock.pending(), 0); f.host.stop();
});

test('connect timeout settles start and closes a late connection without reviving its run', async () => {
  const late = deferred(); let closed = 0;
  const f = fixture({ config: { ioTimeoutMs: 20 }, connectImpl: () => late.promise });
  const task = f.host.start(grant()); await flush(); await f.clock.advance(20);
  const result = await task; assert.equal(result.ok, false); assertResult(result);
  late.resolve({ close() { closed += 1; return new Promise(() => {}); } }); await flush();
  assert.equal(closed, 1); assert.equal(f.clock.pending(), 0); assert.notEqual(f.host.getState().phase, 'receiving'); f.host.stop();
});

test('raw fetch errors and secret-shaped response bodies produce fixed sanitized host failures', async () => {
  for (const fetchImpl of [() => { throw new Error(`${RAW_ERROR}:${ACCESS}`); },
    () => streamResponse({ error: RAW_ERROR, access_token: ACCESS }, { status: 401 }).response,
    () => streamResponse(validationBody({ client_id: ACCESS })).response]) {
    const f = fixture({ fetchImpl }); const result = await f.host.start(grant());
    assert.equal(result.ok, false); assertResult(result); assert.equal(f.calls.connect.length, 0); assert.equal(f.clock.pending(), 0); f.host.stop();
  }
});

test('stop during fresh-token validation aborts new HTTP and late body completion cannot reconnect', async () => {
  const pending = deferred(); const f = fixture({ fetchImpl: (call, count) => {
    if (call.kind === 'validate' && count === 2) return pending.promise;
    return streamResponse(call.kind === 'validate' ? validationBody() : subscriptionBody(call.body.transport.session_id), { status: call.kind === 'validate' ? 200 : 202 }).response;
  } });
  await f.receiving(); const task = f.host.refresh(); await flush();
  assert.equal(f.calls.fetch.filter((call) => call.kind === 'validate').length, 2);
  f.host.stop(); assert.equal((await task).ok, false);
  assert.equal(f.calls.fetch.filter((call) => call.kind === 'validate')[1].options.signal.aborted, true);
  pending.resolve(streamResponse(validationBody()).response); await flush();
  assert.equal(f.calls.connect.length, 1); assert.equal(f.clock.pending(), 0); assertPublic(f.host.getState());
});

test('reentrant callback revocation prevents subsequent old-frame intake and still permits explicit restart', async () => {
  let f; let calls = 0;
  f = fixture({ onEvent: () => { calls += 1; f.host.revoke(); } });
  await f.receiving(); const old = f.socket(); await f.emit(f.notification());
  assert.equal(f.host.getState().phase, 'revoked');
  await old.onFrame(JSON.stringify(f.notification(1))); assert.equal(calls, 1);
  assert.equal((await f.host.start(grant({ accessToken: `${ACCESS}_NEW` }))).ok, true);
  assert.equal(f.calls.connect.length, 2); assertPublic(f.host.getState()); f.host.stop();
});

test('cleanup reentry cannot start another run during refresh or undo terminal stop', async () => {
  let f; const reentrant = [];
  f = fixture({ connectImpl: () => ({ close() { reentrant.push(f.host.start(grant({ accessToken: `${ACCESS}_REENTRANT` }))); return new Promise(() => {}); } }) });
  await f.receiving(); const refreshed = await f.host.refresh(); assert.equal(refreshed.ok, true);
  assertResult(await reentrant[0], 'busy'); assert.equal(f.calls.connect.length, 2);
  f.host.stop(); assertResult(await reentrant[1], 'stopped'); assert.equal(f.host.getState().phase, 'stopped');
});

test('grant descriptor reentry into stop cannot mint a usable host binding or start HTTP', async () => {
  const f = fixture(); let entered = false;
  const input = new Proxy(grant(), { ownKeys(target) {
    if (!entered) { entered = true; f.host.stop(); }
    return Reflect.ownKeys(target);
  } });
  const result = await f.host.start(input); assert.equal(result.ok, false); assertResult(result);
  assert.equal(f.host.getState().phase, 'stopped'); assert.equal(f.calls.fetch.length + f.calls.connect.length, 0); assert.equal(f.clock.pending(), 0);
});

test('default timers settle a standalone host with an injected fetch that never resolves', async () => {
  const moduleUrl = new URL('../src/credential-session-host.mjs', import.meta.url).href;
  const script = `import {createCredentialSessionHost} from ${JSON.stringify(moduleUrl)};
    const host=createCredentialSessionHost({clientId:'synthetichost01',broadcasterId:'100',readerId:'100',ioTimeoutMs:20,fetchImpl:()=>new Promise(()=>{}),connect:()=>{throw Error('must-not-connect')},exchange:()=>{throw Error('must-not-exchange')}});
    const result=await host.start({accessToken:'synthetic-access',refreshToken:'synthetic-refresh',expiresIn:3600,scopes:['user:read:chat']});
    if(result.ok||result.state.realTwitchConnected||result.state.authorizationVerified)process.exitCode=2;
    else console.log('failed-and-settled');
    host.stop();
  `;
  const result = await runFile(process.execPath, ['--input-type=module', '-e', script], { timeout: 3_000, windowsHide: true });
  assert.equal(result.stdout.trim(), 'failed-and-settled'); assert.equal(result.stderr, '');
});
