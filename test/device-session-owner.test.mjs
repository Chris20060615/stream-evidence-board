import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeviceSessionOwner } from '../src/device-session-owner.mjs';

// Actual local module composition with fake fetch, sockets, exchange and time.
// Synthetic canaries only: no real token, OAuth/account, network or browser.
const CLIENT = 'syntheticowner01';
const CHANNEL = '100';
const DEVICE = 'SYNTHETIC_DEVICE_CANARY_NOT_REAL';
const USER_CODE = 'ABCD1234';
const ACCESS = 'SYNTHETIC_ACCESS_CANARY_NOT_A_REAL_TOKEN';
const REFRESH = 'SYNTHETIC_REFRESH_CANARY_NOT_A_REAL_TOKEN';
const RAW = 'SYNTHETIC_RAW_ERROR_CANARY_DO_NOT_PUBLISH';
const BASE = Date.parse('2026-10-25T08:00:00.000Z');
const URLS = Object.freeze({ device: 'https://id.twitch.tv/oauth2/device', poll: 'https://id.twitch.tv/oauth2/token',
  validate: 'https://id.twitch.tv/oauth2/validate', subscribe: 'https://api.twitch.tv/helix/eventsub/subscriptions' });
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function manualClock() {
  let time = BASE; let sequence = 0; const timers = new Map();
  return {
    now: () => time, set: (value) => { time = value; }, pending: () => timers.size,
    setTimer(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimer: (id) => timers.delete(id),
    async advance(ms) {
      const target = time + ms; let steps = 0;
      while (true) {
        const next = [...timers.entries()].filter(([, value]) => value.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        if (++steps > 1_000) throw new Error('Synthetic timer loop bound.');
        const [id, value] = next; timers.delete(id); time = value.at; await value.callback(); await flush();
      }
      time = target; await flush();
    },
  };
}
function stream(body, { status = 200, read, cancel } = {}) {
  let sent = false; const stats = { reads: 0, cancels: 0, releases: 0 };
  const reader = { read() { stats.reads += 1; if (read) return read(stats.reads); if (sent) return { done: true }; sent = true; return { done: false, value: new TextEncoder().encode(JSON.stringify(body)) }; },
    cancel() { stats.cancels += 1; return cancel?.(); }, releaseLock() { stats.releases += 1; } };
  return { raw: { status, body: { getReader: () => reader, cancel: () => reader.cancel() } }, stats };
}
function deviceBody(overrides = {}) { return { device_code: DEVICE, user_code: USER_CODE, verification_uri: `https://www.twitch.tv/activate?public=true&device-code=${USER_CODE}`, expires_in: 1_800, interval: 1, ...overrides }; }
function tokenBody(overrides = {}) { return { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3_600, scope: ['user:read:chat'], token_type: 'bearer', ...overrides }; }
function validation(overrides = {}) { return { client_id: CLIENT, user_id: CHANNEL, scopes: ['user:read:chat'], expires_in: 3_600, ...overrides }; }
function grant(overrides = {}) { return { accessToken: `${ACCESS}_ROTATED`, refreshToken: `${REFRESH}_ROTATED`, expiresIn: 3_600, scopes: ['user:read:chat'], ...overrides }; }
function ack(sessionId) { return { data: [{ id: `PRIVATE_SUB_${sessionId}`, status: 'enabled', type: 'channel.chat.message', version: '1',
  condition: { broadcaster_user_id: CHANNEL, user_id: CHANNEL }, transport: { method: 'websocket', session_id: sessionId } }] }; }
function frozenData(value) { if (value && typeof value === 'object') { assert.equal(Object.isFrozen(value), true); for (const child of Object.values(value)) { assert.notEqual(typeof child, 'function'); frozenData(child); } } }
function privatePublic(value) {
  assert.doesNotMatch(JSON.stringify(value), /syntheticowner01|ABCD1234|twitch\.tv\/activate|SYNTHETIC_(DEVICE|ACCESS|REFRESH|RAW_ERROR)|PRIVATE_(SESSION|SUB)_|!vote|!source|Authorization|"(?:accessToken|refreshToken|device_code|user_code|scope|scopes|verificationUri|userCode|capability)"\s*:/);
}
function assertPublic(state) {
  assert.equal(state.mode, 'device-session-owner-harness');
  for (const part of [state, state.staged, state.staged.session, state.staged.board]) {
    assert.equal(part.networkConnected, false); assert.equal(part.authorizationVerified, false); assert.equal(part.realTwitchConnected, false);
  }
  assert.equal(typeof state.active, 'boolean'); assert.equal(typeof state.busy, 'boolean');
  assert.equal(state.staged.mode, 'staged-session-host-harness'); assert.equal(state.staged.board.sourceCue.origin, 'ingress-harness');
  frozenData(state); privatePublic(state);
}
function assertResult(result, code) {
  assert.deepEqual(Object.keys(result).sort(), ['code', 'message', 'ok', 'state']);
  assert.equal(typeof result.ok, 'boolean'); assert.equal(typeof result.code, 'string'); assert.equal(typeof result.message, 'string');
  if (code) assert.equal(result.code, code); assertPublic(result.state); frozenData(result); privatePublic(result);
}
const board = (f) => f.owner.getState().staged.board;

function fixture({ config = {}, fetchImpl, connectImpl, exchangeImpl, onPrompt } = {}) {
  const clock = manualClock(); const calls = { fetch: [], sockets: [], exchange: [], prompts: [], close: [] }; let deliveries = 0;
  const owner = createDeviceSessionOwner({ clientId: CLIENT, broadcasterId: CHANNEL, readerId: CHANNEL,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    fetchImpl: (url, options) => {
      const kind = Object.keys(URLS).find((key) => URLS[key] === url); if (!kind) throw new Error(RAW);
      const call = { kind, url, options, at: clock.now(), body: kind === 'device' || kind === 'poll' ? Object.fromEntries(new URLSearchParams(options.body)) : options.body ? JSON.parse(options.body) : undefined };
      calls.fetch.push(call); if (fetchImpl) return fetchImpl(call, calls.fetch.filter((item) => item.kind === kind).length);
      return responseFor(call);
    },
    connect: (callbacks) => {
      const number = calls.sockets.length + 1; const socket = { number, callbacks, handle: { close() { calls.close.push(number); } } };
      calls.sockets.push(socket); return connectImpl ? connectImpl(callbacks, socket) : socket.handle;
    },
    exchange: (input) => { calls.exchange.push(input); return exchangeImpl ? exchangeImpl(input) : grant(); },
    onPrompt: (prompt, meta) => { calls.prompts.push({ prompt, meta }); return onPrompt?.(prompt, meta, calls.prompts.length); },
    ...config,
  });
  function responseFor(call) {
    return stream(call.kind === 'device' ? deviceBody() : call.kind === 'poll' ? tokenBody() : call.kind === 'validate' ? validation() : ack(call.body.transport.session_id), { status: call.kind === 'subscribe' ? 202 : 200 }).raw;
  }
  const sessionId = (number = calls.sockets.length) => `PRIVATE_SESSION_${number}`;
  const metadata = (type, sub = false, timestamp = clock.now()) => ({ message_id: `delivery-${++deliveries}`, message_type: type, message_timestamp: new Date(timestamp).toISOString(),
    ...(sub ? { subscription_type: 'channel.chat.message', subscription_version: '1' } : {}) });
  const welcome = (number = calls.sockets.length) => ({ metadata: metadata('session_welcome'), payload: { session: { id: sessionId(number), status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null } } });
  function notification({ number = calls.sockets.length, text = '!vote a', id, userId = '200', timestamp = clock.now(), event = {}, subscription } = {}) {
    return { metadata: metadata('notification', true, timestamp), payload: { subscription: subscription ?? ack(sessionId(number)).data[0],
      event: { broadcaster_user_id: CHANNEL, chatter_user_id: userId, message_id: id ?? `private-chat-${deliveries}`, message: { text, fragments: [] }, ...event } } };
  }
  const socket = (number = calls.sockets.length) => calls.sockets[number - 1].callbacks;
  const emit = (frame, number = calls.sockets.length) => socket(number).onFrame(typeof frame === 'string' ? frame : JSON.stringify(frame));
  async function begin(options) { const pending = owner.start(options); await flush(); return { pending }; }
  async function acquire(options) { const { pending } = await begin(options); await clock.advance(1_000); return pending; }
  async function receiving(options) { const result = await acquire(options); assert.equal(result.ok, true); assert.equal((await emit(welcome())).ok, true); return result; }
  async function voting() { owner.openVote(60_000); await receiving(); await emit(notification()); }
  return { owner, calls, clock, responseFor, sessionId, welcome, notification, socket, emit, begin, acquire, receiving, voting };
}

test('constructor is inert and frozen facade exposes controls and independent simulation without raw grant or event ingress', () => {
  const f = fixture();
  assert.equal(Object.isFrozen(f.owner), true);
  assert.deepEqual(Object.keys(f.owner).sort(), ['cancel', 'closeVote', 'getState', 'openVote', 'refresh', 'reset', 'simulation', 'start', 'stop']);
  for (const key of ['onGrant', 'onEvent', 'revoke', 'processEvent', 'setConnection', 'issue', 'deliver', 'scope', 'host']) assert.equal(f.owner[key], undefined);
  const state = f.owner.getState(); assertPublic(state); assert.equal(state.phase, 'idle'); assert.equal(state.active, false); assert.equal(state.busy, false);
  assert.equal(f.calls.fetch.length + f.calls.sockets.length + f.calls.exchange.length + f.calls.prompts.length, 0); assert.equal(f.clock.pending(), 0);
  assert.equal(f.owner.simulation.getState().mode, 'simulated'); assert.equal(board(f).connection.status, 'disconnected'); f.owner.stop();
});

test('constructor requires pinned own-channel explicit dependencies and rejects unknown/accessor configuration', () => {
  const base = { clientId: CLIENT, broadcasterId: CHANNEL, readerId: CHANNEL, fetchImpl() {}, connect() {}, exchange() {}, onPrompt() {} };
  for (const config of [null, {}, { ...base, readerId: '200' }, { ...base, clientId: 'bad-client' }, { ...base, fetchImpl: undefined }, { ...base, onPrompt: undefined },
    { ...base, onGrant() {} }, { ...base, onEvent() {} }, { ...base, ioTimeoutMs: 0 }, { ...base, leaseMs: 0 }, { ...base, boardOptions: { processEvent() {} } }]) {
    assert.throws(() => createDeviceSessionOwner(config), (error) => { assert.equal(error.message, 'invalid_input'); assert.equal(error.cause, undefined); privatePublic(error); return true; });
  }
  let reads = 0; const getter = { ...base }; Object.defineProperty(getter, 'onPrompt', { enumerable: true, get() { reads += 1; throw new Error(RAW); } });
  assert.throws(() => createDeviceSessionOwner(getter), /invalid_input/); assert.equal(reads, 0);
});

test('malformed start options and pre-aborted native signal cannot begin HTTP or invoke descriptor getters', async () => {
  const f = fixture(); let reads = 0; const getter = {}; Object.defineProperty(getter, 'signal', { enumerable: true, get() { reads += 1; throw new Error(RAW); } });
  for (const options of [null, [], { extra: RAW }, { signal: {} }, getter]) assertResult(await f.owner.start(options), 'invalid_input');
  const controller = new AbortController(); controller.abort(new Error(RAW)); assertResult(await f.owner.start({ signal: controller.signal }), 'aborted');
  assert.equal(reads, 0); assert.equal(f.calls.fetch.length, 0); assert.equal(f.clock.pending(), 0); f.owner.stop();
});

test('actual four-route device-to-staged composition acquires privately then requires welcome202 and delivered chat before tally', async () => {
  const f = fixture();
  try {
    assertResult(f.owner.openVote(60_000), 'vote_opened'); const { pending } = await f.begin();
    assert.deepEqual(f.calls.fetch.map((call) => call.kind), ['device']); assert.equal(f.calls.prompts.length, 1);
    const { prompt, meta } = f.calls.prompts[0]; frozenData(prompt); assert.equal(Object.isFrozen(meta), true);
    assert.deepEqual(Object.keys(meta).sort(), ['lifetimeSignal', 'signal']); assert.ok(meta.signal instanceof AbortSignal); assert.ok(meta.lifetimeSignal instanceof AbortSignal);
    assert.equal(prompt.userCode, USER_CODE); assert.equal(meta.lifetimeSignal.aborted, false);
    await f.clock.advance(1_000); assertResult(await pending, 'started'); assert.equal(f.owner.getState().active, true);
    assert.equal(f.owner.getState().staged.session.phase, 'awaiting_welcome'); assert.equal(board(f).connection.status, 'disconnected'); assert.equal(board(f).vote.total, 0);
    await f.emit(f.welcome()); assert.equal(board(f).connection.status, 'disconnected'); assert.equal(f.owner.getState().staged.session.phase, 'receiving');
    await f.emit(f.notification({ id: 'guarded-same-id', event: { broadcaster_user_id: '999' } })); assert.equal(board(f).vote.total, 0);
    await f.emit(f.notification({ id: 'guarded-same-id' })); await f.emit(f.notification({ text: '!vote b' })); await f.emit(f.notification({ text: '!source', userId: '201' }));
    const state = f.owner.getState(); assertPublic(state); assert.deepEqual(state.staged.board.vote.counts, { a: 0, b: 1 }); assert.equal(state.staged.board.vote.uniqueVoters, 1);
    assert.equal(state.staged.board.sourceCue.active, true); assert.equal(state.staged.board.sourceCue.requestCount, 1);
    assert.deepEqual(f.calls.fetch.map((call) => call.kind), ['device', 'poll', 'validate', 'subscribe']);
    assert.deepEqual(f.calls.fetch[0].body, { client_id: CLIENT, scopes: 'user:read:chat' }); assert.equal(f.calls.fetch[1].body.device_code, DEVICE);
    assert.equal(f.calls.fetch[2].options.headers.Authorization, `OAuth ${ACCESS}`); assert.equal(f.calls.fetch[3].options.headers.Authorization, `Bearer ${ACCESS}`);
    assert.equal(f.calls.fetch[3].body.transport.session_id, f.sessionId()); assert.equal(meta.lifetimeSignal.aborted, true);
    assert.throws(() => { state.staged.board.vote.counts.a = 999; }, TypeError); assert.equal(board(f).vote.counts.a, 0);
  } finally { f.owner.stop(); }
});

test('concurrent and active starts are busy without duplicate prompts, HTTP, exchange or round mutation', async () => {
  const f = fixture();
  try {
    f.owner.openVote(60_000); const before = board(f).vote; const { pending } = await f.begin();
    assertResult(await f.owner.start(), 'busy'); assertResult(await f.owner.refresh(), 'busy'); assert.equal(f.calls.fetch.length, 1); assert.equal(f.calls.prompts.length, 1);
    await f.clock.advance(1_000); assertResult(await pending, 'started'); assertResult(await f.owner.start(), 'busy');
    assert.equal(f.calls.fetch.length, 3); assert.equal(f.calls.exchange.length, 0); assert.deepEqual(board(f).vote, before);
  } finally { f.owner.stop(); }
});

test('pending and slow_down keep acquisition private until a grant while prompt lifetime ends on handoff', async () => {
  let f; f = fixture({ fetchImpl: (call, number) => call.kind === 'poll' && number <= 2
    ? stream(number === 1 ? { status: 400, message: 'authorization_pending' } : { error: 'slow_down', error_description: RAW }, { status: 400 }).raw : f.responseFor(call) });
  try {
    const { pending } = await f.begin(); const meta = f.calls.prompts[0].meta;
    await f.clock.advance(1_000); await f.clock.advance(1_000); assert.equal(f.calls.sockets.length, 0); assert.equal(f.calls.fetch.some((call) => call.kind === 'validate'), false);
    assert.equal(meta.lifetimeSignal.aborted, false); assert.equal(meta.signal.aborted, false);
    await f.clock.advance(5_999); assert.equal(f.calls.fetch.filter((call) => call.kind === 'poll').length, 2);
    await f.clock.advance(1); assertResult(await pending, 'started'); assert.equal(meta.lifetimeSignal.aborted, true);
    assert.deepEqual(f.calls.fetch.filter((call) => call.kind === 'poll').map((call) => call.at - BASE), [1_000, 2_000, 8_000]);
  } finally { f.owner.stop(); }
});

test('cancel bounds device, prompt, poll, validation and connect waits; late results cannot corrupt an explicit replacement', async () => {
  for (const blocked of ['device', 'prompt', 'poll', 'validate', 'connect']) {
    const hold = deferred(); let blockedCall; let f;
    f = fixture({ fetchImpl: (call, number) => { if (call.kind === blocked && number === 1) { blockedCall = call; return hold.promise; } return f.responseFor(call); },
      onPrompt: (_prompt, _meta, number) => blocked === 'prompt' && number === 1 ? hold.promise : undefined,
      connectImpl: (_callbacks, socket) => blocked === 'connect' && socket.number === 1 ? hold.promise : socket.handle });
    try {
      const { pending } = await f.begin(); if (['poll', 'validate', 'connect'].includes(blocked)) await f.clock.advance(1_000);
      assertResult(f.owner.cancel(), 'cancelled'); const cancelled = await pending; assert.equal(cancelled.ok, false); assertResult(cancelled, 'cancelled');
      if (blockedCall) assert.equal(blockedCall.options.signal.aborted, true);
      if (blocked === 'prompt') assert.equal(f.calls.prompts[0].meta.signal.aborted, true);
      for (const prompt of f.calls.prompts) assert.equal(prompt.meta.lifetimeSignal.aborted, true);
      assertResult(await f.acquire(), 'started'); const currentSocketCount = f.calls.sockets.length;
      hold.resolve(blockedCall ? f.responseFor(blockedCall) : blocked === 'connect' ? f.calls.sockets[0].handle : undefined); await flush(); await flush();
      assert.equal(f.owner.getState().active, true); assert.equal(f.calls.sockets.length, currentSocketCount);
      if (blocked === 'connect') { assert.equal(f.calls.close.filter((number) => number === 1).length, 1); await f.emit(f.welcome(1), 1); assert.equal(f.owner.getState().active, true); }
      assert.equal(f.calls.fetch.filter((call) => call.kind === 'device').length, 2); assertPublic(f.owner.getState());
    } finally { f.owner.stop(); }
  }
});

test('active cancel preserves votes and replay while clearing source cue and rejecting old callbacks before cache intake', async () => {
  const f = fixture();
  try {
    await f.voting(); await f.emit(f.notification({ text: '!source' })); const before = board(f); assert.equal(before.sourceCue.active, true);
    assertResult(f.owner.cancel(), 'cancelled'); assert.equal(board(f).sourceCue.active, false); assert.equal(board(f).connection.status, 'disconnected');
    assert.deepEqual(board(f).vote, before.vote); assert.equal(board(f).sourceCue.requestCount, 1);
    await f.emit(f.notification({ id: 'not-admitted-old', userId: '201' }), 1); assert.equal(board(f).vote.total, 1);
    await f.receiving(); await f.emit(f.notification({ id: 'not-admitted-old', userId: '201' }), 2); assert.equal(board(f).vote.total, 2);
  } finally { f.owner.stop(); }
});

test('original start signal remains owner authority after acquisition and through an ignored refresh exchange', async () => {
  for (const duringRefresh of [false, true]) {
    const controller = new AbortController(); const hold = deferred(); const f = fixture({ exchangeImpl: () => hold.promise });
    try {
      f.owner.openVote(60_000); await f.receiving({ signal: controller.signal }); await f.emit(f.notification()); await f.emit(f.notification({ text: '!source' }));
      const refresh = duringRefresh ? f.owner.refresh() : null; if (refresh) await flush(); controller.abort(new Error(RAW)); await flush();
      if (refresh) { const ended = await refresh; assert.equal(ended.ok, false); assertResult(ended); }
      assert.equal(f.owner.getState().active, false); assert.equal(board(f).sourceCue.active, false); assert.equal(board(f).vote.total, 1);
      hold.resolve(grant()); await flush(); await f.emit(f.notification({ userId: '201' }), 1); assert.equal(board(f).vote.total, 1);
      assertResult(await f.acquire(), 'started'); assert.equal(f.owner.getState().active, true);
    } finally { f.owner.stop(); }
  }
});

test('wrong validation client, reader, scope or401 cannot create a socket or staged vote', async () => {
  for (const invalid of [{ client_id: 'differentclient' }, { user_id: '200' }, { scopes: [] }, '401']) {
    let f; f = fixture({ fetchImpl: (call) => call.kind === 'validate' ? stream(invalid === '401' ? { message: RAW } : validation(invalid), { status: invalid === '401' ? 401 : 200 }).raw : f.responseFor(call) });
    try {
      const result = await f.acquire(); assert.equal(result.ok, false); assertResult(result, 'host_failed'); assert.equal(f.calls.sockets.length, 0);
      assert.equal(board(f).vote.total, 0); assert.equal(board(f).connection.status, 'disconnected'); assert.equal(f.calls.prompts[0].meta.lifetimeSignal.aborted, true);
    } finally { f.owner.stop(); }
  }
});

test('invalid device/token responses and authorization denial cannot reach validation or expose private service bodies', async () => {
  for (const variant of ['device', 'token', 'denied']) {
    let f; f = fixture({ fetchImpl: (call) => variant === 'device' && call.kind === 'device' ? stream(deviceBody({ verification_uri: 'https://example.invalid/activate' })).raw
      : call.kind === 'poll' && variant === 'token' ? stream(tokenBody({ scope: ['user:read:chat', 'user:write:chat'] })).raw
        : call.kind === 'poll' && variant === 'denied' ? stream({ error: 'access_denied', error_description: RAW }, { status: 400 }).raw : f.responseFor(call) });
    try {
      const result = await f.acquire(); assert.equal(result.ok, false); assertResult(result); assert.equal(f.calls.sockets.length, 0);
      assert.equal(f.calls.fetch.some((call) => call.kind === 'validate'), false); assert.equal(board(f).vote.total, 0);
    } finally { f.owner.stop(); }
  }
});

test('prompt rejection, hook timeout and original device expiry abort private prompt lifetime and settle acquisition', async () => {
  for (const variant of ['reject', 'timeout', 'expiry']) {
    let f; f = fixture({ config: { ioTimeoutMs: variant === 'timeout' ? 20 : 5_000 },
      fetchImpl: (call) => call.kind === 'device' && variant === 'expiry' ? stream(deviceBody({ expires_in: 1 })).raw : f.responseFor(call),
      onPrompt: () => variant === 'reject' ? Promise.reject(new Error(RAW)) : new Promise(() => {}) });
    try {
      const { pending } = await f.begin(); if (variant !== 'reject') await f.clock.advance(variant === 'timeout' ? 20 : 1_000);
      const result = await pending; assert.equal(result.ok, false); assertResult(result, variant === 'reject' ? 'prompt_failed' : variant === 'timeout' ? 'prompt_timeout' : 'device_expired');
      assert.equal(f.calls.prompts[0].meta.lifetimeSignal.aborted, true); assert.equal(f.calls.fetch.filter((call) => call.kind === 'poll').length, 0); assert.equal(f.clock.pending(), 0);
    } finally { f.owner.stop(); }
  }
});

test('grant handoff I/O timeout retires ignored validation or connect and cannot revive from a late result', async () => {
  for (const blocked of ['validate', 'connect']) {
    const hold = deferred(); let blockedCall; let f; f = fixture({ config: { ioTimeoutMs: 20 },
      fetchImpl: (call) => { if (call.kind === blocked) { blockedCall = call; return hold.promise; } return f.responseFor(call); },
      connectImpl: (_callbacks, socket) => blocked === 'connect' ? hold.promise : socket.handle });
    try {
      const { pending } = await f.begin(); await f.clock.advance(1_000); await f.clock.advance(20);
      const result = await pending; assert.equal(result.ok, false); assertResult(result, 'grant_timeout'); assert.equal(f.owner.getState().active, false);
      if (blockedCall) assert.equal(blockedCall.options.signal.aborted, true);
      hold.resolve(blockedCall ? f.responseFor(blockedCall) : f.calls.sockets[0].handle); await flush(); await flush();
      assert.equal(f.owner.getState().active, false); assert.equal(board(f).connection.status, 'disconnected'); assert.equal(board(f).vote.total, 0);
      if (blocked === 'connect') assert.equal(f.calls.close.filter((number) => number === 1).length, 1); else assert.equal(f.calls.sockets.length, 0);
    } finally { f.owner.stop(); }
  }
});

test('original device deadline bounds a grant handoff even when validation ignores abort and advertises longer lifetime', async () => {
  const hold = deferred(); let call; let f; f = fixture({ fetchImpl: (input) => input.kind === 'device' ? stream(deviceBody({ expires_in: 2 })).raw
    : input.kind === 'validate' ? (call = input, hold.promise) : f.responseFor(input) });
  try {
    const { pending } = await f.begin(); await f.clock.advance(1_000); assert.equal(f.calls.fetch.at(-1).kind, 'validate');
    await f.clock.advance(1_000); const result = await pending; assert.equal(result.ok, false); assertResult(result, 'device_expired'); assert.equal(call.options.signal.aborted, true);
    hold.resolve(stream(validation()).raw); await flush(); assert.equal(f.calls.sockets.length, 0); assert.equal(f.owner.getState().active, false);
  } finally { f.owner.stop(); }
});

test('HTTP body waits stay bounded at device, poll, validation and subscription without secret-bearing failures', async () => {
  for (const blocked of ['device', 'poll', 'validate', 'subscribe']) {
    let blockedCall; const body = stream({}, { read: () => new Promise(() => {}), cancel: () => Promise.reject(new Error(RAW)), status: blocked === 'subscribe' ? 202 : 200 });
    let f; f = fixture({ config: { ioTimeoutMs: 20 }, fetchImpl: (call) => { if (call.kind === blocked) { blockedCall = call; return body.raw; } return f.responseFor(call); } });
    try {
      const { pending } = await f.begin(); if (blocked !== 'device') await f.clock.advance(1_000);
      let welcome; if (blocked === 'subscribe') { assertResult(await pending, 'started'); welcome = f.emit(f.welcome()); await flush(); }
      await f.clock.advance(20); const result = blocked === 'subscribe' ? await welcome : await pending;
      assert.equal(result.ok, false); privatePublic(result); assert.equal(blockedCall.options.signal.aborted, true);
      assert.equal(body.stats.cancels, 1); assert.equal(f.owner.getState().active, false); assert.equal(board(f).vote.total, 0); assertPublic(f.owner.getState());
    } finally { f.owner.stop(); }
  }
});

test('refresh retires old socket before exchange, validates new private token and preserves vote window/tally/replay', async () => {
  let f; f = fixture({ exchangeImpl: () => { assert.equal(f.calls.close.includes(1), true); assert.equal(f.socket(1).signal.aborted, true); return grant(); } });
  try {
    f.owner.openVote(60_000); await f.receiving(); await f.emit(f.notification({ id: 'preserved-replay' })); await f.emit(f.notification({ text: '!source' })); const before = board(f);
    assertResult(await f.owner.refresh(), 'refreshed'); assert.deepEqual(board(f).vote, before.vote); assert.equal(board(f).sourceCue.active, false); assert.equal(board(f).sourceCue.requestCount, 1);
    assert.equal(f.calls.fetch.filter((call) => call.kind === 'device').length, 1); assert.equal(f.calls.fetch.filter((call) => call.kind === 'poll').length, 1);
    assert.equal(f.calls.fetch.filter((call) => call.kind === 'validate')[1].options.headers.Authorization, `OAuth ${ACCESS}_ROTATED`);
    await f.emit(f.welcome(2), 2); await f.emit(f.notification({ number: 2, id: 'preserved-replay', userId: '201' }), 2); assert.equal(board(f).vote.total, 1);
    await f.emit(f.notification({ number: 2, text: '!vote b' }), 2); assert.deepEqual(board(f).vote.counts, { a: 0, b: 1 });
    await f.emit(f.notification({ number: 1, userId: '202' }), 1); assert.equal(board(f).vote.total, 1); assert.equal(f.owner.getState().active, true);
  } finally { f.owner.stop(); }
});

test('failed fresh validation or invalid exchange grants cannot open replacement sockets or revive old intake', async () => {
  for (const variant of ['identity', 'grant', 'throw']) {
    let f; f = fixture({ fetchImpl: (call, number) => call.kind === 'validate' && number === 2 && variant === 'identity' ? stream(validation({ user_id: '200' })).raw : f.responseFor(call),
      exchangeImpl: () => { if (variant === 'throw') throw new Error(RAW); return variant === 'grant' ? grant({ scopes: ['user:read:chat', 'user:write:chat'] }) : grant(); } });
    try {
      await f.voting(); const before = board(f).vote; const result = await f.owner.refresh(); assert.equal(result.ok, false); assertResult(result);
      assert.equal(f.calls.sockets.length, 1); assert.equal(f.owner.getState().active, false); assert.deepEqual(board(f).vote, before);
      await f.emit(f.notification({ userId: '201' }), 1); assert.equal(board(f).vote.total, 1);
    } finally { f.owner.stop(); }
  }
});

test('refresh is single-flight and operation abort settles ignored exchange without leaking its reason', async () => {
  const hold = deferred(); const controller = new AbortController(); const f = fixture({ exchangeImpl: () => hold.promise });
  try {
    await f.receiving(); const pending = f.owner.refresh({ signal: controller.signal }); await flush();
    assertResult(await f.owner.refresh(), 'busy'); assertResult(await f.owner.start(), 'busy'); assert.equal(f.calls.exchange.length, 1);
    controller.abort(new Error(RAW)); const result = await pending; assert.equal(result.ok, false); assertResult(result); assert.equal(f.calls.exchange[0].signal.aborted, true);
    hold.resolve(grant()); await flush(); assert.equal(f.calls.sockets.length, 1); assert.equal(f.owner.getState().active, false);
  } finally { f.owner.stop(); }
});

test('cancel or terminal stop settles ignored refresh and its late grant cannot overwrite replacement ownership', async () => {
  for (const action of ['cancel', 'stop']) {
    const hold = deferred(); const f = fixture({ exchangeImpl: () => hold.promise });
    try {
      await f.receiving(); const pending = f.owner.refresh(); await flush(); assertResult(f.owner[action](), action === 'cancel' ? 'cancelled' : 'stopped');
      const result = await pending; assert.equal(result.ok, false); assertResult(result, action === 'cancel' ? 'cancelled' : 'stopped'); assert.equal(f.calls.exchange[0].signal.aborted, true);
      if (action === 'cancel') assertResult(await f.acquire(), 'started'); else assertResult(await f.owner.start(), 'stopped');
      const count = f.calls.sockets.length; hold.resolve(grant()); await flush(); assert.equal(f.calls.sockets.length, count); assert.equal(f.owner.getState().active, action === 'cancel');
    } finally { f.owner.stop(); }
  }
});

test('reset clears round and cue while preserving replay and requiring a new explicit acquisition', async () => {
  const f = fixture();
  try {
    f.owner.openVote(60_000); await f.receiving(); await f.emit(f.notification({ id: 'reset-replay' })); await f.emit(f.notification({ text: '!source' }));
    assertResult(f.owner.reset(), 'reset'); assert.equal(board(f).vote.phase, 'idle'); assert.equal(board(f).vote.total, 0); assert.equal(board(f).vote.opensAt, null); assert.equal(board(f).sourceCue.requestCount, 0);
    assert.equal(f.owner.getState().active, false); assertResult(await f.owner.refresh(), 'not_started');
    f.owner.openVote(60_000); await f.receiving(); await f.emit(f.notification({ number: 2, id: 'reset-replay' }), 2); assert.equal(board(f).vote.total, 0);
    await f.emit(f.notification({ number: 2, id: 'fresh-after-reset' }), 2); assert.equal(board(f).vote.total, 1);
  } finally { f.owner.stop(); }
});

test('exact staged lease expiry retires owner intake without renewing the old scope or changing the vote window', async () => {
  const f = fixture({ config: { leaseMs: 1_000 } });
  try {
    await f.voting(); await f.emit(f.notification({ text: '!source' })); const before = board(f).vote; await f.clock.advance(999); assert.equal(f.owner.getState().active, true);
    await f.clock.advance(1); assert.equal(f.owner.getState().active, false); assert.equal(board(f).connection.status, 'disconnected'); assert.equal(board(f).sourceCue.active, false); assert.deepEqual(board(f).vote, before);
    await f.emit(f.notification({ userId: '201' }), 1); assert.equal(board(f).vote.total, 1); assertResult(await f.owner.refresh(), 'not_started');
    await f.receiving(); await f.emit(f.notification({ number: 2, userId: '201' }), 2); assert.equal(board(f).vote.total, 2);
  } finally { f.owner.stop(); }
});

test('transport disconnect, revocation and keepalive timeout retire owned intake and clear source cue', async () => {
  for (const failure of ['disconnect', 'revocation', 'timeout']) {
    const f = fixture();
    try {
      await f.voting(); await f.emit(f.notification({ text: '!source' })); const before = board(f).vote;
      if (failure === 'disconnect') f.socket().onDisconnect(new Error(RAW));
      else if (failure === 'revocation') await f.emit({ metadata: { message_id: 'revocation-delivery', message_type: 'revocation', message_timestamp: new Date(f.clock.now()).toISOString(), subscription_type: 'channel.chat.message', subscription_version: '1' }, payload: { subscription: { ...ack(f.sessionId()).data[0], status: 'authorization_revoked' } } });
      else await f.clock.advance(10_001);
      await flush(); assert.equal(f.owner.getState().active, false); assert.equal(board(f).sourceCue.active, false); assert.equal(board(f).connection.status, 'disconnected'); assert.deepEqual(board(f).vote, before);
      await f.emit(f.notification({ userId: '201' }), 1); assert.equal(board(f).vote.total, 1); assertPublic(f.owner.getState());
    } finally { f.owner.stop(); }
  }
});

test('teardown reentry from lifetime abort, socket close and exchange abort cannot start work or mutate a replacement', async () => {
  const attempts = []; const hold = deferred(); let f;
  const attempt = (controls = true) => { attempts.push(f.owner.start()); if (controls) attempts.push(f.owner.openVote(1_000)); };
  f = fixture({ onPrompt: (_prompt, meta) => meta.lifetimeSignal.addEventListener('abort', () => attempt(false), { once: true }),
    connectImpl: (_callbacks, socket) => ({ close() { f.calls.close.push(socket.number); attempt(); } }),
    exchangeImpl: (input) => { input.signal.addEventListener('abort', attempt, { once: true }); return hold.promise; } });
  try {
    await f.receiving(); assert.ok(attempts.length >= 1); assert.equal(f.calls.fetch.filter((call) => call.kind === 'device').length, 1);
    const pending = f.owner.refresh(); await flush(); f.owner.cancel(); assert.equal((await pending).ok, false);
    for (const value of attempts) assertResult(await value, 'busy'); assert.equal(f.calls.fetch.filter((call) => call.kind === 'device').length, 1);
    assertResult(await f.acquire(), 'started'); hold.resolve(grant()); await flush(); assert.equal(f.owner.getState().active, true);
  } finally { f.owner.stop(); }
  const late = deferred(); let terminal; let immediateStop;
  terminal = fixture({ connectImpl: (_callbacks, socket) => ({ close() { terminal.calls.close.push(socket.number); immediateStop = terminal.owner.stop(); } }), exchangeImpl: () => late.promise });
  try {
    await terminal.receiving(); const pending = terminal.owner.refresh();
    const result = await pending; assert.equal(result.ok, false); assertResult(result, 'stopped'); assert.equal(terminal.owner.getState().active, false);
    assertResult(immediateStop, 'stopped'); assert.equal(immediateStop.state.phase, 'stopped'); assert.equal(immediateStop.state.active, false);
    assert.equal(terminal.calls.exchange.length, 0);
    const sockets = terminal.calls.sockets.length; late.resolve(grant()); await flush(); await flush();
    assert.equal(terminal.calls.sockets.length, sockets); assert.equal(terminal.owner.getState().active, false); assert.equal(board(terminal).connection.status, 'disconnected');
    assertResult(await terminal.owner.start(), 'stopped'); assertResult(await terminal.owner.refresh(), 'stopped'); assert.equal(terminal.clock.pending(), 0);
  } finally { terminal.owner.stop(); }
});

test('async connection cleanup never delays cancel or stop and cleanup rejections cannot escape private ownership', async () => {
  for (const mode of ['never', 'reject']) {
    const f = fixture({ connectImpl: (_callbacks, socket) => ({ close() { f.calls.close.push(socket.number); return mode === 'never' ? new Promise(() => {}) : Promise.reject(new Error(RAW)); } }) });
    await f.receiving(); assertResult(f.owner.cancel(), 'cancelled'); assert.equal(f.calls.close.length, 1); await flush();
    assertResult(await f.acquire(), 'started'); assertResult(f.owner.stop(), 'stopped'); await flush(); assertResult(f.owner.stop(), 'stopped');
    assertResult(await f.owner.start(), 'stopped'); assert.equal(f.calls.close.length, 2); assert.equal(f.clock.pending(), 0);
  }
});

test('simulation and staged caches remain independent, and transported original timestamps are not rewritten', async () => {
  const f = fixture();
  try {
    f.owner.simulation.setConnection('connected'); f.owner.simulation.openVote(60_000);
    f.owner.simulation.processEvent({ id: 'same-independent-id', userId: '200', text: '!vote b', origin: 'simulated' });
    f.owner.openVote(60_000); await f.receiving(); await f.emit(f.notification({ id: 'same-independent-id' })); assert.deepEqual(board(f).vote.counts, { a: 1, b: 0 });
    assert.deepEqual(f.owner.simulation.getState().vote.counts, { a: 0, b: 1 });
    await f.emit(f.notification({ id: 'before-window', userId: '201', timestamp: BASE - 1 })); assert.equal(board(f).vote.total, 1);
    await f.emit(f.notification({ text: '!source', timestamp: f.clock.now() - 15_001 })); assert.equal(board(f).sourceCue.active, false); assert.equal(board(f).sourceCue.requestCount, 0);
    await f.emit(f.notification({ text: '!source' })); const expires = board(f).sourceCue.expiresAt; await f.clock.advance(100);
    await f.emit(f.notification({ text: '!source', userId: '201' })); assert.equal(board(f).sourceCue.requestCount, 2); assert.equal(board(f).sourceCue.expiresAt, expires);
    f.owner.reset(); assert.equal(f.owner.simulation.getState().vote.total, 1); assertPublic(f.owner.getState());
  } finally { f.owner.stop(); }
});
