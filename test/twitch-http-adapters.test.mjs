import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTwitchHttpAdapters } from '../src/twitch-http-adapters.mjs';
import { createTwitchSession } from '../src/twitch-session.mjs';
import { createBoard } from '../src/engine.mjs';

// Synthetic responses only. No test calls a network fetch or uses a real token or credential.
const CLIENT = 'syntheticclient01';
const USER = '100';
const SESSION = 'synthetic-session';
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
const SUBSCRIBE_URL = 'https://api.twitch.tv/helix/eventsub/subscriptions';
const CANARY = 'SYNTHETIC_CANARY_NOT_A_REAL_TOKEN';
const BASE_TIME = Date.parse('2026-10-25T08:00:00.000Z');
const LIMIT = 65_536;
const encode = (text) => new TextEncoder().encode(text);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const fixedCodes = new Set([
  'invalid_input', 'invalid_request', 'invalid_credential', 'credential_resolution_failed',
  'aborted', 'timeout', 'request_failed', 'body_limit', 'invalid_utf8', 'invalid_json',
  'invalid_response', 'identity_mismatch', 'missing_scope', 'invalid_expiry', 'invalid_ack', 'credential_echo',
]);

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function clockFixture() {
  let time = BASE_TIME;
  let nextId = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(callback, delay) { const id = ++nextId; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    pending: () => timers.size,
    async advance(milliseconds) {
      const target = time + milliseconds;
      let steps = 0;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        if (++steps > 1_000) throw new Error('Synthetic timer loop bound exceeded.');
        const [id, timer] = next; timers.delete(id); time = timer.at;
        await timer.callback(); await flush();
      }
      time = target; await flush();
    },
  };
}

function validationBody() {
  return { client_id: CLIENT, user_id: USER, scopes: ['user:read:chat', 'user:write:chat'], expires_in: 7_200 };
}
function subscriptionBody(sessionId = SESSION) {
  return { data: [{
    id: 'synthetic-subscription', status: 'enabled', type: 'channel.chat.message', version: '1',
    condition: { broadcaster_user_id: USER, user_id: USER },
    transport: { method: 'websocket', session_id: sessionId },
  }] };
}
function request(sessionId = SESSION) {
  return {
    method: 'POST', url: SUBSCRIBE_URL,
    body: {
      type: 'channel.chat.message', version: '1',
      condition: { broadcaster_user_id: USER, user_id: USER },
      transport: { method: 'websocket', session_id: sessionId },
    },
  };
}

function responseFromChunks(chunks, {
  status = 200, readOverride, cancelOverride, bodyCancelOverride,
} = {}) {
  const stats = { reads: 0, getReaders: 0, readerCancels: 0, bodyCancels: 0, releases: 0 };
  let position = 0;
  const reader = {
    async read() {
      stats.reads += 1;
      if (readOverride) return readOverride(stats.reads);
      return position < chunks.length ? { done: false, value: chunks[position++] } : { done: true };
    },
    cancel() { stats.readerCancels += 1; return cancelOverride ? cancelOverride() : Promise.resolve(); },
    releaseLock() { stats.releases += 1; },
  };
  const response = {
    status,
    body: {
      getReader() { stats.getReaders += 1; return reader; },
      cancel() { stats.bodyCancels += 1; return bodyCancelOverride ? bodyCancelOverride() : Promise.resolve(); },
    },
  };
  return { response, stats, reader };
}
const jsonResponse = (body, options) => responseFromChunks([encode(JSON.stringify(body))], options);

function fixture({ fetchImpl, resolver, config = {} } = {}) {
  const clock = clockFixture();
  const handle = Object.freeze({ opaque: 'synthetic-credential-handle' });
  const calls = { fetch: [], resolve: [] };
  const generated = [];
  const fetch = async (url, options) => {
    calls.fetch.push({ url, options });
    if (fetchImpl) return fetchImpl(url, options);
    const result = jsonResponse(url === VALIDATE_URL ? validationBody() : subscriptionBody(), { status: url === VALIDATE_URL ? 200 : 202 });
    generated.push(result);
    return result.response;
  };
  const adapters = createTwitchHttpAdapters({
    fetch, resolveCredential: (credential) => { calls.resolve.push(credential); return resolver ? resolver(credential) : CANARY; },
    clientId: CLIENT, broadcasterId: USER, readerId: USER,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...config,
  });
  return { adapters, clock, handle, calls, generated };
}

function assertFixed(error, expected) {
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'Error');
  assert.ok(fixedCodes.has(error.message), error.message);
  if (expected) assert.equal(error.message, expected);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.doesNotMatch(String(error.stack), /SYNTHETIC_CANARY_NOT_A_REAL_TOKEN/);
  assert.doesNotMatch(JSON.stringify(error), /SYNTHETIC_CANARY_NOT_A_REAL_TOKEN/);
}
async function rejectsFixed(task, expected) {
  await assert.rejects(task, (error) => { assertFixed(error, expected); return true; });
}
function observe(task) { return task.then((value) => ({ value }), (error) => ({ error })); }

test('factory requires explicit fetch and synchronous credential resolver; no default service path exists', () => {
  const base = { clientId: CLIENT, broadcasterId: USER, readerId: USER };
  assert.throws(() => createTwitchHttpAdapters(base));
  assert.throws(() => createTwitchHttpAdapters({ ...base, fetch: () => {} }));
  assert.throws(() => createTwitchHttpAdapters({ ...base, resolveCredential: () => CANARY }));
  for (const config of [
    { clientId: 'client\r\ninjection' }, { clientId: '' }, { readerId: 'display-name' },
    { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: NaN }, { timeoutMs: '5000' },
  ]) assert.throws(() => fixture({ config }));
});

test('validation uses the fixed URL and OAuth header without cookies, cache, redirects or token URLs', async () => {
  const f = fixture();
  const receipt = await f.adapters.validate({ credential: f.handle });
  const { url, options } = f.calls.fetch[0];
  assert.equal(url, VALIDATE_URL);
  assert.equal(options.method, 'GET');
  assert.equal(new Headers(options.headers).get('Authorization'), `OAuth ${CANARY}`);
  assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.cache, 'no-store');
  assert.ok(options.signal instanceof AbortSignal);
  assert.equal(options.body, undefined);
  assert.equal(f.calls.resolve[0], f.handle);
  assert.doesNotMatch(url, /SYNTHETIC_CANARY_NOT_A_REAL_TOKEN/);
  assert.deepEqual(receipt, { httpStatus: 200, body: { client_id: CLIENT, user_id: USER, scopes: ['user:read:chat'], expires_in: 7_200 } });
  assert.equal(f.clock.pending(), 0);
});

test('subscription sends only the pinned JSON body, fixed Client-Id and Bearer authorization', async () => {
  const f = fixture();
  const proposal = request();
  const receipt = await f.adapters.subscribe({ credential: f.handle, request: proposal });
  const { url, options } = f.calls.fetch[0];
  const headers = new Headers(options.headers);
  assert.equal(url, SUBSCRIBE_URL);
  assert.equal(options.method, 'POST');
  assert.equal(headers.get('Authorization'), `Bearer ${CANARY}`);
  assert.equal(headers.get('Client-Id'), CLIENT);
  assert.equal(headers.get('Content-Type'), 'application/json');
  assert.equal(headers.get('Cookie'), null);
  assert.equal(options.redirect, 'error');
  assert.equal(options.credentials, 'omit');
  assert.equal(options.cache, 'no-store');
  assert.deepEqual(JSON.parse(options.body), proposal.body);
  assert.doesNotMatch(options.body + url, /SYNTHETIC_CANARY_NOT_A_REAL_TOKEN/);
  assert.deepEqual(receipt, { httpStatus: 202, body: subscriptionBody() });
});

test('endpoint, method, nested identity and extra request fields fail before credential resolution or fetch', async () => {
  for (const change of [
    (r) => { r.url = 'https://attacker.example/subscriptions'; },
    (r) => { r.url += '?access_token=synthetic'; },
    (r) => { r.url += '#fragment'; }, (r) => { r.url += '/'; },
    (r) => { r.url = SUBSCRIBE_URL.replace('https:', 'http:'); },
    (r) => { r.method = 'GET'; },
    (r) => { r.headers = { Authorization: CANARY }; },
    (r) => { r.provenance = 'synthetic'; },
    (r) => { r.requiresSecureAuthorization = true; },
    (r) => { r.body.type = 'channel.follow'; },
    (r) => { r.body.version = '2'; },
    (r) => { r.body.condition.broadcaster_user_id = '999'; },
    (r) => { r.body.condition.user_id = '999'; },
    (r) => { r.body.condition.extra = 'unexpected'; },
    (r) => { r.body.transport.method = 'webhook'; },
    (r) => { r.body.transport.session_id = '../unsafe'; },
    (r) => { r.body.transport.extra = 'unexpected'; },
    (r) => { r.body.extra = 'unexpected'; },
  ]) {
    const f = fixture(); const proposal = request(); change(proposal);
    await rejectsFixed(f.adapters.subscribe({ credential: f.handle, request: proposal }), 'invalid_request');
    assert.equal(f.calls.resolve.length, 0);
    assert.equal(f.calls.fetch.length, 0);
  }
});

test('request getters and cycles are rejected without invoking getters or resolving credentials', async () => {
  let getterInvoked = false;
  const f = fixture(); const proposal = request();
  Object.defineProperty(proposal.body, 'transport', { enumerable: true, get() { getterInvoked = true; throw new Error(CANARY); } });
  await rejectsFixed(f.adapters.subscribe({ credential: f.handle, request: proposal }), 'invalid_request');
  assert.equal(getterInvoked, false);
  assert.equal(f.calls.resolve.length, 0);
  const cyclic = request(); cyclic.body.self = cyclic;
  await rejectsFixed(f.adapters.subscribe({ credential: f.handle, request: cyclic }), 'invalid_request');
  assert.equal(f.calls.fetch.length, 0);
});

test('pre-aborted or invalid external signal prevents credential resolution and fetch', async () => {
  const controller = new AbortController(); controller.abort(CANARY);
  const f = fixture();
  await rejectsFixed(f.adapters.validate({ credential: f.handle, signal: controller.signal }), 'aborted');
  await rejectsFixed(f.adapters.subscribe({ credential: f.handle, request: request(), signal: controller.signal }), 'aborted');
  await rejectsFixed(f.adapters.validate({ credential: f.handle, signal: {} }), 'invalid_input');
  assert.equal(f.calls.resolve.length, 0);
  assert.equal(f.calls.fetch.length, 0);
});

test('resolver exceptions and invalid/async token results are sanitized before fetch', async () => {
  const throwing = fixture({ resolver: () => { throw new Error(CANARY); } });
  await rejectsFixed(throwing.adapters.validate({ credential: throwing.handle }), 'credential_resolution_failed');
  for (const token of ['', 'contains space', '\r\ninjected', '月', 'x'.repeat(4_097), null, {}, Promise.resolve(CANARY)]) {
    const f = fixture({ resolver: () => token });
    await rejectsFixed(f.adapters.validate({ credential: f.handle }), 'invalid_credential');
    assert.equal(f.calls.fetch.length, 0);
  }
});

test('validation projects extra response fields without exposing unknown data or extra scopes', async () => {
  const body = { ...validationBody(), login: 'synthetic-login', ignored: { access_token: CANARY }, extra: 'discarded' };
  const response = jsonResponse(body);
  const f = fixture({ fetchImpl: () => response.response });
  const receipt = await f.adapters.validate({ credential: f.handle });
  assert.deepEqual(receipt.body, { client_id: CLIENT, user_id: USER, scopes: ['user:read:chat'], expires_in: 7_200 });
  assert.doesNotMatch(JSON.stringify(receipt), /synthetic-login|discarded|user:write:chat|SYNTHETIC_CANARY_NOT_A_REAL_TOKEN/);
});

test('validation cannot repair wrong identities, missing read scope or invalid expiry', async () => {
  for (const [change, code] of [
    [(b) => { b.client_id = 'wrongclient'; }, 'identity_mismatch'],
    [(b) => { b.user_id = '999'; }, 'identity_mismatch'],
    [(b) => { b.scopes = ['user:write:chat']; }, 'missing_scope'],
    [(b) => { b.expires_in = 0; }, 'invalid_expiry'],
    [(b) => { b.expires_in = '7200'; }, 'invalid_expiry'],
    [(b) => { b.expires_in = Number.MAX_SAFE_INTEGER; }, 'invalid_expiry'],
  ]) {
    const body = validationBody(); change(body);
    const f = fixture({ fetchImpl: () => jsonResponse(body).response });
    await rejectsFixed(f.adapters.validate({ credential: f.handle }), code);
  }
});

test('all scope members are checked before projecting the required read scope', async () => {
  for (const scopes of [['user:read:chat', 1], ['user:read:chat', ''], 'user:read:chat', Array(101).fill('user:read:chat')]) {
    const f = fixture({ fetchImpl: () => jsonResponse({ ...validationBody(), scopes }).response });
    await rejectsFixed(f.adapters.validate({ credential: f.handle }));
  }
});

test('acknowledgement requires exact singleton, enabled status, conditions and session before projection', async () => {
  for (const change of [
    (b) => { b.data = []; }, (b) => { b.data.push(structuredClone(b.data[0])); },
    (b) => { b.data[0].id = ''; }, (b) => { b.data[0].status = 'authorization_revoked'; },
    (b) => { b.data[0].type = 'channel.follow'; }, (b) => { b.data[0].version = '2'; },
    (b) => { b.data[0].condition.user_id = '999'; },
    (b) => { b.data[0].condition.broadcaster_user_id = '999'; },
    (b) => { b.data[0].condition.extra = 'unexpected'; },
    (b) => { b.data[0].transport.method = 'webhook'; },
    (b) => { b.data[0].transport.session_id = 'other-session'; },
  ]) {
    const body = subscriptionBody(); change(body);
    const f = fixture({ fetchImpl: () => jsonResponse(body, { status: 202 }).response });
    await rejectsFixed(f.adapters.subscribe({ credential: f.handle, request: request() }), 'invalid_ack');
  }
});

test('acknowledgement discards official extras without leaking raw receipt fields', async () => {
  const body = subscriptionBody();
  body.total = 1; body.total_cost = 0;
  Object.assign(body.data[0], { created_at: '2026-10-25T08:00:00Z', cost: 0, unknown: CANARY });
  Object.assign(body.data[0].transport, { connected_at: '2026-10-25T08:00:00Z', disconnected_at: null });
  const f = fixture({ fetchImpl: () => jsonResponse(body, { status: 202 }).response });
  const receipt = await f.adapters.subscribe({ credential: f.handle, request: request() });
  assert.deepEqual(receipt, { httpStatus: 202, body: subscriptionBody() });
  assert.doesNotMatch(JSON.stringify(receipt), /created_at|total_cost|SYNTHETIC_CANARY_NOT_A_REAL_TOKEN/);
});

test('a projected field that would echo the resolved credential is rejected', async () => {
  const f = fixture({ resolver: () => CLIENT });
  await rejectsFixed(f.adapters.validate({ credential: f.handle }), 'credential_echo');
});

test('401, redirect and other non-success statuses discard bodies without reading or awaiting cancellation', async () => {
  for (const status of [401, 403, 302, 429, 500]) {
    const response = responseFromChunks([encode(CANARY)], { status, bodyCancelOverride: () => new Promise(() => {}) });
    const f = fixture({ fetchImpl: () => response.response });
    const receipt = await f.adapters.validate({ credential: f.handle });
    assert.deepEqual(receipt, { httpStatus: status, body: {} });
    assert.equal(response.stats.reads, 0);
    assert.equal(response.stats.getReaders, 0);
    assert.ok(response.stats.bodyCancels >= 1);
    assert.equal(f.clock.pending(), 0);
  }
  const f = fixture({ fetchImpl: () => jsonResponse({ data: CANARY }, { status: 200 }).response });
  assert.deepEqual(await f.adapters.subscribe({ credential: f.handle, request: request() }), { httpStatus: 200, body: {} });
});

test('fetch, reader and body-access exceptions never echo credential/error data', async () => {
  const fetchFailure = fixture({ fetchImpl: () => { throw new Error(CANARY); } });
  await rejectsFixed(fetchFailure.adapters.validate({ credential: fetchFailure.handle }), 'request_failed');
  const readFailure = responseFromChunks([], { readOverride: () => { throw new Error(CANARY); } });
  const readerFixture = fixture({ fetchImpl: () => readFailure.response });
  await rejectsFixed(readerFixture.adapters.validate({ credential: readerFixture.handle }));
  const badBody = { status: 200 };
  Object.defineProperty(badBody, 'body', { get() { throw new Error(CANARY); } });
  const bodyFixture = fixture({ fetchImpl: () => badBody });
  await rejectsFixed(bodyFixture.adapters.validate({ credential: bodyFixture.handle }));
});

test('success without a valid byte-stream reader or integer status is rejected', async () => {
  for (const response of [
    null, {}, { status: NaN, body: null }, { status: 200.5, body: null },
    { status: 200, body: null }, { status: 200, body: {} },
    { status: 200, body: { getReader: () => ({}) } },
  ]) {
    const f = fixture({ fetchImpl: () => response });
    await rejectsFixed(f.adapters.validate({ credential: f.handle }));
  }
});

test('JSON at exactly 65536 streamed bytes passes and one additional byte fails', async () => {
  const base = { ...validationBody(), padding: '' };
  const overhead = encode(JSON.stringify(base)).length;
  const exact = encode(JSON.stringify({ ...base, padding: 'x'.repeat(LIMIT - overhead) }));
  assert.equal(exact.length, LIMIT);
  const okResponse = responseFromChunks([exact.subarray(0, 100), exact.subarray(100)]);
  const okFixture = fixture({ fetchImpl: () => okResponse.response });
  assert.equal((await okFixture.adapters.validate({ credential: okFixture.handle })).httpStatus, 200);
  const over = encode(JSON.stringify({ ...base, padding: 'x'.repeat(LIMIT - overhead + 1) }));
  const overResponse = responseFromChunks([over]);
  const overFixture = fixture({ fetchImpl: () => overResponse.response });
  await rejectsFixed(overFixture.adapters.validate({ credential: overFixture.handle }), 'body_limit');
  assert.ok(overResponse.stats.readerCancels >= 1);
  assert.equal(overFixture.calls.fetch[0].options.signal.aborted, true);
});

test('the body cap counts UTF8 bytes rather than JavaScript characters and cleanup cannot hang rejection', async () => {
  const json = JSON.stringify({ ...validationBody(), padding: '月'.repeat(22_000) });
  assert.ok(json.length < LIMIT);
  assert.ok(encode(json).length > LIMIT);
  const response = responseFromChunks([encode(json)], { cancelOverride: () => new Promise(() => {}) });
  const f = fixture({ fetchImpl: () => response.response });
  await rejectsFixed(f.adapters.validate({ credential: f.handle }), 'body_limit');
  assert.ok(response.stats.readerCancels >= 1);
  assert.equal(f.clock.pending(), 0);
});

test('stream decoding handles split UTF8 sequences and rejects invalid UTF8, JSON and nonbyte chunks', async () => {
  const bytes = encode(JSON.stringify({ ...validationBody(), discarded: '月' }));
  const unicodeStart = bytes.indexOf(0xe6);
  const split = responseFromChunks([bytes.subarray(0, unicodeStart + 1), bytes.subarray(unicodeStart + 1)]);
  const good = fixture({ fetchImpl: () => split.response });
  assert.equal((await good.adapters.validate({ credential: good.handle })).httpStatus, 200);
  for (const [chunks, code] of [
    [[new Uint8Array([0xc3, 0x28])], 'invalid_utf8'],
    [[encode(`{"error":"${CANARY}"`)], 'invalid_json'],
    [['not a byte chunk'], 'invalid_response'],
  ]) {
    const response = responseFromChunks(chunks);
    const f = fixture({ fetchImpl: () => response.response });
    await rejectsFixed(f.adapters.validate({ credential: f.handle }), code);
  }
});

test('empty-fragment floods are bounded even when their total byte count is small', async () => {
  const response = responseFromChunks([], { readOverride: () => ({ done: false, value: new Uint8Array() }) });
  const f = fixture({ fetchImpl: () => response.response });
  await rejectsFixed(f.adapters.validate({ credential: f.handle }), 'body_limit');
  assert.ok(response.stats.reads <= LIMIT + 2);
  assert.ok(response.stats.readerCancels >= 1);
});

test('hanging fetch that ignores AbortSignal still settles at the hard timeout', async () => {
  const pending = deferred();
  const f = fixture({ fetchImpl: () => pending.promise });
  const outcome = observe(f.adapters.validate({ credential: f.handle }));
  await flush(); await f.clock.advance(5_000);
  const result = await outcome;
  assertFixed(result.error, 'timeout');
  assert.equal(f.calls.fetch[0].options.signal.aborted, true);
  assert.equal(f.clock.pending(), 0);
});

test('external cancellation settles hanging fetch and ignores its private abort reason', async () => {
  const controller = new AbortController();
  const f = fixture({ fetchImpl: () => new Promise(() => {}) });
  const outcome = observe(f.adapters.validate({ credential: f.handle, signal: controller.signal }));
  await flush(); controller.abort(CANARY);
  assertFixed((await outcome).error, 'aborted');
  assert.equal(f.calls.fetch[0].options.signal.aborted, true);
  assert.equal(f.clock.pending(), 0);
});

test('a response arriving after timeout is cancelled without reading and cannot return success', async () => {
  const pending = deferred();
  const f = fixture({ fetchImpl: () => pending.promise });
  const outcome = observe(f.adapters.validate({ credential: f.handle }));
  await flush(); await f.clock.advance(5_000);
  assertFixed((await outcome).error, 'timeout');
  const late = jsonResponse(validationBody(), { bodyCancelOverride: () => new Promise(() => {}) });
  pending.resolve(late.response); await flush();
  assert.equal(late.stats.reads, 0);
  assert.ok(late.stats.bodyCancels + late.stats.readerCancels >= 1);
  assert.equal(f.clock.pending(), 0);
});

test('timeout covers hanging body reads, with nonblocking reader cancellation and lock cleanup', async () => {
  const response = responseFromChunks([], { readOverride: () => new Promise(() => {}), cancelOverride: () => new Promise(() => {}) });
  const f = fixture({ fetchImpl: () => response.response });
  const outcome = observe(f.adapters.validate({ credential: f.handle }));
  await flush(); await f.clock.advance(5_000);
  assertFixed((await outcome).error, 'timeout');
  assert.ok(response.stats.readerCancels >= 1);
  assert.ok(response.stats.releases >= 1);
  assert.equal(f.calls.fetch[0].options.signal.aborted, true);
  assert.equal(f.clock.pending(), 0);
});

test('the same deadline spans fetch and body decode without restarting after response headers', async () => {
  const pendingFetch = deferred();
  const response = responseFromChunks([], { readOverride: () => new Promise(() => {}) });
  const f = fixture({ fetchImpl: () => pendingFetch.promise });
  const outcome = observe(f.adapters.validate({ credential: f.handle }));
  await flush(); await f.clock.advance(3_000);
  pendingFetch.resolve(response.response); await flush();
  await f.clock.advance(2_000);
  assertFixed((await outcome).error, 'timeout');
  assert.ok(response.stats.readerCancels >= 1);
  assert.equal(f.clock.pending(), 0);
});

test('external cancellation also covers body reads and later bytes cannot produce a receipt', async () => {
  const pendingRead = deferred();
  const response = responseFromChunks([], { readOverride: () => pendingRead.promise });
  const f = fixture({ fetchImpl: () => response.response });
  const controller = new AbortController();
  const outcome = observe(f.adapters.validate({ credential: f.handle, signal: controller.signal }));
  await flush(); controller.abort(CANARY);
  assertFixed((await outcome).error, 'aborted');
  pendingRead.resolve({ done: false, value: encode(JSON.stringify(validationBody())) }); await flush();
  assert.ok(response.stats.readerCancels >= 1);
  assert.equal(f.clock.pending(), 0);
});

test('projected receipts and adapter surface are deeply frozen', async () => {
  const f = fixture();
  assert.ok(Object.isFrozen(f.adapters));
  const validation = await f.adapters.validate({ credential: f.handle });
  assert.throws(() => { validation.body.user_id = '999'; }, TypeError);
  assert.throws(() => { validation.body.scopes.push('user:write:chat'); }, TypeError);
  const ack = await f.adapters.subscribe({ credential: f.handle, request: request() });
  assert.throws(() => { ack.body.data[0].condition.user_id = '999'; }, TypeError);
  assert.throws(() => { ack.body.data[0].transport.session_id = 'changed'; }, TypeError);
  assert.equal(f.clock.pending(), 0);
});

test('actual HTTP adapter/coordinator modules compose with synthetic dependencies while the board still rejects their events', async () => {
  const f = fixture();
  const events = [];
  let callbacks;
  let closed = 0;
  const session = createTwitchSession({
    clientId: CLIENT, broadcasterId: USER, readerId: USER,
    adapters: { ...f.adapters, connect: async (input) => { callbacks = input; return { close() { closed += 1; } }; } },
    now: f.clock.now, setTimer: f.clock.setTimer, clearTimer: f.clock.clearTimer,
    onEvent: (event) => { events.push(event); },
  });
  assert.equal((await session.start(f.handle)).ok, true);
  const meta = (id, type, subscription = false) => ({
    message_id: id, message_type: type, message_timestamp: new Date(f.clock.now()).toISOString(),
    ...(subscription ? { subscription_type: 'channel.chat.message', subscription_version: '1' } : {}),
  });
  await callbacks.onFrame(JSON.stringify({
    metadata: meta('synthetic-welcome', 'session_welcome'),
    payload: { session: { id: SESSION, status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null } },
  }));
  assert.equal(session.getState().phase, 'receiving');
  await callbacks.onFrame(JSON.stringify({
    metadata: meta('synthetic-chat-delivery', 'notification', true),
    payload: {
      subscription: subscriptionBody().data[0],
      event: { broadcaster_user_id: USER, chatter_user_id: '300', message_id: 'synthetic-chat-message', message: { text: '!vote a', fragments: [] } },
    },
  }));
  assert.equal(f.calls.fetch.length, 2);
  assert.equal(events.length, 1);
  assert.equal(events[0].origin, 'transport-unverified');
  const board = createBoard({ now: f.clock.now }); board.setConnection('connected'); board.openVote();
  assert.equal(board.processEvent(events[0]).code, 'unsupported_origin');
  assert.equal(board.getState().vote.total, 0);
  assert.equal(session.getState().realTwitchConnected, false);
  assert.equal(session.getState().authorizationVerified, false);
  await session.stop();
  assert.equal(closed, 1);
  assert.equal(f.clock.pending(), 0);
});

test('default deadline keeps a standalone Node process alive until a hanging fake fetch rejects', async () => {
  const moduleUrl = new URL('../src/twitch-http-adapters.mjs', import.meta.url).href;
  const script = `
    import { createTwitchHttpAdapters } from ${JSON.stringify(moduleUrl)};
    const adapters = createTwitchHttpAdapters({
      fetch: () => new Promise(() => {}),
      resolveCredential: () => 'SYNTHETIC_CHILD_CANARY',
      clientId: 'syntheticclient01', broadcasterId: '100', readerId: '100',
      timeoutMs: 20,
    });
    try {
      await adapters.validate({ credential: {} });
      process.exitCode = 2;
    } catch (error) {
      if (error.message === 'timeout' && !Object.hasOwn(error, 'cause')) {
        process.stdout.write('timeout\\n');
      } else {
        process.exitCode = 3;
      }
    }
  `;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    timeout: 5_000, windowsHide: true,
  });
  assert.equal(stdout.trim(), 'timeout');
  assert.equal(stderr, '');
});

test('credential resolution cannot mutate a previously checked request into a different outgoing subscription', async () => {
  const proposal = request();
  const expectedBody = structuredClone(proposal.body);
  const f = fixture({ resolver: () => {
    proposal.url = 'https://attacker.example/subscriptions';
    proposal.method = 'GET';
    proposal.body.condition.user_id = '999';
    proposal.body.transport.session_id = 'tampered-session';
    return CANARY;
  } });
  const receipt = await f.adapters.subscribe({ credential: f.handle, request: proposal });
  assert.equal(f.calls.fetch[0].url, SUBSCRIBE_URL);
  assert.equal(f.calls.fetch[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(f.calls.fetch[0].options.body), expectedBody);
  assert.deepEqual(receipt, { httpStatus: 202, body: subscriptionBody() });
  assert.equal(proposal.body.transport.session_id, 'tampered-session');
});

test('coordinator I/O deadline keeps a standalone process alive until hanging fake connect returns transport_timeout', async () => {
  const moduleUrl = new URL('../src/twitch-session.mjs', import.meta.url).href;
  const script = `
    import { createTwitchSession } from ${JSON.stringify(moduleUrl)};
    const session = createTwitchSession({
      clientId: 'syntheticclient01', broadcasterId: '100', readerId: '100',
      ioTimeoutMs: 20,
      adapters: {
        validate: async () => ({
          httpStatus: 200,
          body: { client_id: 'syntheticclient01', user_id: '100', scopes: ['user:read:chat'], expires_in: 7200 },
        }),
        connect: () => new Promise(() => {}),
        subscribe: () => { throw new Error('unexpected-synthetic-subscribe'); },
      },
    });
    const result = await session.start({});
    if (!result.ok && result.code === 'transport_timeout'
      && result.state.phase === 'timed_out' && result.state.realTwitchConnected === false) {
      process.stdout.write('transport_timeout\\n');
    } else {
      process.exitCode = 3;
    }
  `;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], {
    timeout: 5_000, windowsHide: true,
  });
  assert.equal(stdout.trim(), 'transport_timeout');
  assert.equal(stderr, '');
});
