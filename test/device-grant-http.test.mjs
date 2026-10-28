import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDeviceGrantHttpAdapters } from '../src/device-grant-http.mjs';
import { createDeviceGrantHarness } from '../src/device-grant.mjs';
import { createCredentialVault } from '../src/credential-vault.mjs';

// Synthetic canaries and fake fetch/stream objects only; no actual OAuth,
// network, browser, account, credential loader or WebSocket is exercised.
const CLIENT = 'syntheticdevicehttp01';
const DEVICE = 'SYNTHETIC_CODE+&=%/?#!~';
const USER_CODE = 'ABCD1234';
const URI = `https://www.twitch.tv/activate?public=true&device-code=${USER_CODE}`;
const ACCESS = 'SYNTHETIC_ACCESS_CANARY_NOT_A_REAL_TOKEN';
const REFRESH = 'SYNTHETIC_REFRESH_CANARY_NOT_A_REAL_TOKEN';
const RAW_ERROR = 'SYNTHETIC_RAW_ERROR_CANARY_DO_NOT_PUBLISH';
const DEVICE_URL = 'https://id.twitch.tv/oauth2/device';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const BASE = Date.parse('2026-10-25T08:00:00.000Z');
const LIMIT = 65_536;
const encode = (text) => new TextEncoder().encode(text);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const runFile = promisify(execFile);
const fixedCodes = new Set(['invalid_input', 'invalid_request', 'aborted', 'timeout', 'request_failed', 'invalid_response',
  'body_limit', 'invalid_utf8', 'invalid_json', 'invalid_device_response', 'invalid_token_response']);

function deviceRequest() { return { method: 'POST', url: DEVICE_URL, body: { client_id: CLIENT, scopes: 'user:read:chat' } }; }
function pollRequest(code = DEVICE) { return { method: 'POST', url: TOKEN_URL, body: { client_id: CLIENT, scopes: 'user:read:chat', device_code: code, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' } }; }
function deviceBody(overrides = {}) { return { device_code: DEVICE, user_code: USER_CODE, verification_uri: URI, expires_in: 1_800, interval: 1, ...overrides }; }
function tokenBody(overrides = {}) { return { access_token: ACCESS, refresh_token: REFRESH, expires_in: 14_400, scope: ['user:read:chat'], token_type: 'bearer', ...overrides }; }
function deferred() { let resolve; let reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function observe(task) { return task.then((value) => ({ value }), (error) => ({ error })); }
function assertFixed(error, expected) {
  assert.ok(error instanceof Error); assert.equal(error.name, 'Error'); assert.ok(fixedCodes.has(error.message), error.message);
  if (expected) assert.equal(error.message, expected);
  assert.equal(Object.hasOwn(error, 'code'), false); assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.doesNotMatch(String(error.stack), /SYNTHETIC_|ABCD1234/); assert.doesNotMatch(JSON.stringify(error), /SYNTHETIC_|ABCD1234/);
  return true;
}
async function rejectsFixed(task, code) { await assert.rejects(task, (error) => assertFixed(error, code)); }
function frozen(value) { if (value && typeof value === 'object') { assert.equal(Object.isFrozen(value), true); Object.values(value).forEach(frozen); } }
function manualClock() {
  let time = BASE; let sequence = 0; const timers = new Map();
  return {
    now: () => time,
    setTimer(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimer: (id) => timers.delete(id),
    pending: () => timers.size,
    async advance(ms) {
      const target = time + ms; let count = 0;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        if (++count > 1_000) throw new Error('Synthetic timer loop bound.');
        const [id, timer] = next; timers.delete(id); time = timer.at; await timer.callback(); await flush();
      }
      time = target; await flush();
    },
  };
}
function streamResponse(chunks, { status = 200, read, cancelReader, cancelBody, release } = {}) {
  let index = 0; const stats = { reads: 0, readerCancels: 0, bodyCancels: 0, releases: 0, getReaders: 0 };
  const reader = {
    read() { stats.reads += 1; return read ? read(stats.reads) : index < chunks.length ? { done: false, value: chunks[index++] } : { done: true }; },
    cancel() { stats.readerCancels += 1; return cancelReader?.(); },
    releaseLock() { stats.releases += 1; return release?.(); },
  };
  const response = { status, body: {
    getReader() { stats.getReaders += 1; return reader; },
    cancel() { stats.bodyCancels += 1; return cancelBody?.(); },
  } };
  return { response, stats, reader };
}
const jsonResponse = (body, options) => streamResponse([encode(JSON.stringify(body))], options);
function fixture({ fetchImpl, config = {} } = {}) {
  const clock = manualClock(); const calls = [];
  const adapters = createDeviceGrantHttpAdapters({ clientId: CLIENT, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    fetch(url, options) { calls.push({ url, options }); return fetchImpl ? fetchImpl(url, options, calls.length) : jsonResponse(url === DEVICE_URL ? deviceBody() : tokenBody()).response; },
    ...config,
  });
  return { adapters, clock, calls };
}

test('factory requires explicit fetch, validates exact configuration and exposes only two frozen ports', () => {
  for (const config of [null, {}, { clientId: CLIENT }, { clientId: CLIENT, fetch: undefined },
    { clientId: 'unsafe-client', fetch() {} }, { clientId: CLIENT, fetch() {}, timeoutMs: 0 },
    { clientId: CLIENT, fetch() {}, timeoutMs: 60_001 }, { clientId: CLIENT, fetch() {}, extra: RAW_ERROR }]) {
    assert.throws(() => createDeviceGrantHttpAdapters(config), (error) => assertFixed(error, 'invalid_input'));
  }
  const f = fixture(); assert.equal(Object.isFrozen(f.adapters), true); assert.deepEqual(Object.keys(f.adapters).sort(), ['device', 'poll']);
  assert.equal(f.adapters.refresh, undefined); assert.equal(f.calls.length, 0); assert.equal(f.clock.pending(), 0);
});

test('fixed POST URLs and exact headers/options encode reserved device code once in form body', async () => {
  const f = fixture(); await f.adapters.device({ request: deviceRequest() }); await f.adapters.poll({ request: pollRequest() });
  assert.equal(f.calls[0].url, DEVICE_URL); assert.equal(f.calls[1].url, TOKEN_URL);
  for (const [index, call] of f.calls.entries()) {
    assert.equal(call.options.method, 'POST');
    assert.deepEqual(call.options.headers, { 'Content-Type': 'application/x-www-form-urlencoded' });
    assert.equal(call.options.redirect, 'error'); assert.equal(call.options.credentials, 'omit'); assert.equal(call.options.cache, 'no-store');
    assert.ok(call.options.signal instanceof AbortSignal); assert.equal(Object.isFrozen(call.options.signal), false);
    const body = index ? pollRequest().body : deviceRequest().body;
    assert.equal(call.options.body, new URLSearchParams(body).toString());
    const decoded = new URLSearchParams(call.options.body); assert.equal(decoded.get('scopes'), 'user:read:chat');
    if (index) assert.equal(decoded.get('device_code'), DEVICE);
    assert.doesNotMatch(call.url, /SYNTHETIC_|ABCD1234|client_secret/); assert.equal('Authorization' in call.options.headers, false);
  }
  assert.equal(f.clock.pending(), 0);
});

test('every device request pin and unknown field is rejected before fetch', async () => {
  const f = fixture(); const bad = [
    { ...deviceRequest(), method: 'GET' }, { ...deviceRequest(), url: TOKEN_URL }, { ...deviceRequest(), url: `${DEVICE_URL}?client_secret=${RAW_ERROR}` },
    { ...deviceRequest(), headers: { Authorization: RAW_ERROR } }, { ...deviceRequest(), body: { ...deviceRequest().body, client_id: 'other' } },
    { ...deviceRequest(), body: { ...deviceRequest().body, scopes: ['user:read:chat'] } },
    { ...deviceRequest(), body: { ...deviceRequest().body, scopes: 'user:write:chat' } },
    { ...deviceRequest(), body: { ...deviceRequest().body, client_secret: RAW_ERROR } },
  ];
  for (const request of bad) await rejectsFixed(f.adapters.device({ request }), 'invalid_request');
  assert.equal(f.calls.length, 0); assert.equal(f.clock.pending(), 0);
});

test('poll rejects refresh routes, wrong grant type/scope/client and unsafe device codes before fetch', async () => {
  const f = fixture();
  for (const body of [ { ...pollRequest().body, grant_type: 'refresh_token' }, { ...pollRequest().body, scopes: 'user:write:chat' },
    { ...pollRequest().body, client_id: 'other' }, { ...pollRequest().body, extra: RAW_ERROR },
    ...['', 'with space', '\r\n', 'x'.repeat(4_097)].map((device_code) => ({ ...pollRequest().body, device_code }))]) {
    await rejectsFixed(f.adapters.poll({ request: { ...pollRequest(), body } }), 'invalid_request');
  }
  await rejectsFixed(f.adapters.poll({ request: deviceRequest() }), 'invalid_request');
  assert.equal(f.calls.length, 0);
});

test('options and request own-data checks reject accessors, symbols and cycles without invoking getters', async () => {
  const f = fixture(); let reads = 0;
  const getter = deviceRequest(); Object.defineProperty(getter, 'body', { enumerable: true, get() { reads += 1; throw new Error(RAW_ERROR); } });
  const bodyGetter = pollRequest(); Object.defineProperty(bodyGetter.body, 'device_code', { enumerable: true, get() { reads += 1; return DEVICE; } });
  const cycle = deviceRequest(); cycle.body = cycle;
  for (const request of [null, [], getter, cycle, { ...deviceRequest(), [Symbol('private')]: RAW_ERROR }]) {
    await rejectsFixed(f.adapters.device({ request }), 'invalid_request');
  }
  await rejectsFixed(f.adapters.poll({ request: bodyGetter }), 'invalid_request');
  for (const options of [null, [], {}, { request: deviceRequest(), extra: RAW_ERROR }]) await rejectsFixed(f.adapters.device(options), 'invalid_input');
  assert.equal(reads, 0); assert.equal(f.calls.length, 0);
});

test('request snapshot survives timer-hook mutation and abort reentry prevents fetch admission', async () => {
  const original = pollRequest(); const clock = manualClock(); let mutated = false; const calls = [];
  const adapters = createDeviceGrantHttpAdapters({ clientId: CLIENT, fetch: (url, options) => { calls.push({ url, options }); return jsonResponse(tokenBody()).response; },
    setTimer(callback, ms) { if (!mutated) { mutated = true; original.url = 'https://never-contact.invalid'; original.body.device_code = RAW_ERROR; original.body.scopes = 'user:write:chat'; } return clock.setTimer(callback, ms); },
    clearTimer: clock.clearTimer,
  });
  await adapters.poll({ request: original }); assert.equal(calls[0].url, TOKEN_URL);
  assert.equal(new URLSearchParams(calls[0].options.body).get('device_code'), DEVICE);
  assert.equal(new URLSearchParams(calls[0].options.body).get('scopes'), 'user:read:chat');
  const controller = new AbortController(); let entered = false;
  const proxy = new Proxy(deviceRequest(), { ownKeys(target) { if (!entered) { entered = true; controller.abort(new Error(RAW_ERROR)); } return Reflect.ownKeys(target); } });
  const f = fixture(); await rejectsFixed(f.adapters.device({ request: proxy, signal: controller.signal }), 'aborted'); assert.equal(f.calls.length, 0);
});

test('device success receipt is a frozen strict projection with optional interval preserved', async () => {
  const body = deviceBody(); delete body.interval;
  const f = fixture({ fetchImpl: () => jsonResponse(body).response }); const result = await f.adapters.device({ request: deviceRequest() });
  assert.deepEqual(result, { httpStatus: 200, body }); frozen(result); assert.equal('interval' in result.body, false);
  assert.throws(() => { result.body.device_code = RAW_ERROR; });
});

test('token success preserves private values, canonicalizes bearer and supports four-hour access lifetime', async () => {
  const f = fixture({ fetchImpl: () => jsonResponse(tokenBody({ token_type: 'BeArEr' })).response });
  const result = await f.adapters.poll({ request: pollRequest() }); frozen(result);
  assert.deepEqual(result, { httpStatus: 200, body: tokenBody() }); assert.equal(result.body.expires_in, 14_400);
});

test('malformed device success fields and URI pins cannot be repaired or exposed through raw exceptions', async () => {
  for (const body of [deviceBody({ extra: ACCESS }), deviceBody({ device_code: '\r\n' }), deviceBody({ user_code: 'unsafe code' }),
    deviceBody({ verification_uri: 'https://www.twitch.tv:443/activate' }), deviceBody({ verification_uri: 'https://www.twitch.tv/activate#' }),
    deviceBody({ verification_uri: 'https://www.twitch.tv/activate?device-code=WRONG' }), deviceBody({ expires_in: 0 }), deviceBody({ expires_in: 3_601 }), deviceBody({ interval: 0 })]) {
    const f = fixture({ fetchImpl: () => jsonResponse(body).response }); await rejectsFixed(f.adapters.device({ request: deviceRequest() }), 'invalid_device_response');
  }
});

test('token projection rejects missing refresh, wrong/extra read scope and unsafe expiry without pin repair', async () => {
  const missing = tokenBody(); delete missing.refresh_token;
  for (const body of [missing, tokenBody({ scope: [] }), tokenBody({ scope: ['user:read:chat', 'user:write:chat'] }), tokenBody({ scope: ['user:read:chat', 'user:read:chat'] }),
    tokenBody({ token_type: 'mac' }), tokenBody({ access_token: '\r\n' }), tokenBody({ refresh_token: 'x'.repeat(4_097) }),
    tokenBody({ expires_in: 0 }), tokenBody({ expires_in: Number.MAX_SAFE_INTEGER }), tokenBody({ extra: RAW_ERROR })]) {
    const f = fixture({ fetchImpl: () => jsonResponse(body).response }); await rejectsFixed(f.adapters.poll({ request: pollRequest() }), 'invalid_token_response');
  }
});

test('known RFC400 errors discard diagnostic descriptions/URIs and never follow them', async () => {
  for (const error of ['authorization_pending', 'slow_down', 'access_denied', 'expired_token', 'invalid_grant', 'invalid_client']) {
    const f = fixture({ fetchImpl: () => jsonResponse({ error, error_description: `${RAW_ERROR}:${ACCESS}`, error_uri: `https://never-contact.invalid/?secret=${REFRESH}` }, { status: 400 }).response });
    const result = await f.adapters.poll({ request: pollRequest() }); assert.deepEqual(result, { httpStatus: 400, body: { error } }); frozen(result);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_|never-contact/); assert.equal(f.calls.length, 1);
  }
});

test('only exact Twitch pending/invalid-device messages survive; unknown400 content is redacted', async () => {
  for (const message of ['authorization_pending', 'invalid device code']) {
    const f = fixture({ fetchImpl: () => jsonResponse({ status: 400, message }, { status: 400 }).response });
    assert.deepEqual(await f.adapters.poll({ request: pollRequest() }), { httpStatus: 400, body: { status: 400, message } });
  }
  for (const body of [{ error: RAW_ERROR }, { status: 400, message: RAW_ERROR }, { error: 'authorization_pending', private: ACCESS },
    { status: 400, message: 'authorization_pending', extra: REFRESH }, { error: ['authorization_pending'] }]) {
    const f = fixture({ fetchImpl: () => jsonResponse(body, { status: 400 }).response });
    assert.deepEqual(await f.adapters.poll({ request: pollRequest() }), { httpStatus: 400, body: {} });
  }
});

test('device non200 and poll non200/non400 return empty body without reading service text', async () => {
  for (const [port, request, status] of [['device', deviceRequest(), 400], ['device', deviceRequest(), 401], ['poll', pollRequest(), 302], ['poll', pollRequest(), 429], ['poll', pollRequest(), 503]]) {
    const stream = streamResponse([], { status, read: () => { throw new Error(`${RAW_ERROR}:${ACCESS}`); }, cancelBody: () => new Promise(() => {}) });
    const f = fixture({ fetchImpl: () => stream.response });
    const result = await f.adapters[port]({ request }); assert.deepEqual(result, { httpStatus: status, body: {} }); frozen(result);
    assert.equal(stream.stats.reads, 0); assert.equal(stream.stats.bodyCancels, 1); assert.equal(f.calls.length, 1);
  }
});

test('exactly64KiB valid JSON whitespace is accepted and plusone byte is rejected before projection', async () => {
  const core = JSON.stringify(deviceBody()); const size = encode(core).byteLength;
  const exact = encode(core + ' '.repeat(LIMIT - size)); assert.equal(exact.byteLength, LIMIT);
  const goodStream = streamResponse([exact]); const good = fixture({ fetchImpl: () => goodStream.response });
  assert.equal((await good.adapters.device({ request: deviceRequest() })).body.device_code, DEVICE); assert.equal(goodStream.stats.releases, 1);
  const badStream = streamResponse([encode(core + ' '.repeat(LIMIT - size + 1))]); const bad = fixture({ fetchImpl: () => badStream.response });
  await rejectsFixed(bad.adapters.device({ request: deviceRequest() }), 'body_limit'); assert.equal(badStream.stats.readerCancels, 1);
});

test('byte cap is cumulative and counts UTF8 bytes rather than JavaScript characters', async () => {
  const text = JSON.stringify({ error: 'authorization_pending', error_description: '€'.repeat(22_000) });
  assert.ok(text.length < LIMIT); const bytes = encode(text); assert.ok(bytes.byteLength > LIMIT);
  const chunks = [bytes.subarray(0, 32_000), bytes.subarray(32_000, 64_000), bytes.subarray(64_000)];
  const stream = streamResponse(chunks, { status: 400 }); const f = fixture({ fetchImpl: () => stream.response });
  await rejectsFixed(f.adapters.poll({ request: pollRequest() }), 'body_limit'); assert.equal(stream.stats.readerCancels, 1);
  let reads = 0; const core = JSON.stringify(deviceBody());
  for (const accessor of [false, true]) {
    const oversized = encode(core + ' '.repeat(LIMIT + 1 - encode(core).byteLength));
    assert.equal(oversized.length, LIMIT + 1);
    Object.defineProperty(oversized, 'byteLength', accessor ? { get() { reads += 1; return 0; } } : { value: 0 });
    const decorated = fixture({ fetchImpl: () => streamResponse([oversized]).response });
    await rejectsFixed(decorated.adapters.device({ request: deviceRequest() }), 'body_limit');
  }
  assert.equal(reads, 0);
});

test('streaming UTF8 handles split multibyte text while malformed/truncated bytes fail fatally', async () => {
  const bytes = encode(JSON.stringify({ error: 'authorization_pending', error_description: '€' }));
  const euro = bytes.indexOf(0xe2); const goodStream = streamResponse([bytes.subarray(0, euro + 1), bytes.subarray(euro + 1, euro + 2), bytes.subarray(euro + 2)], { status: 400 });
  const good = fixture({ fetchImpl: () => goodStream.response }); assert.deepEqual(await good.adapters.poll({ request: pollRequest() }), { httpStatus: 400, body: { error: 'authorization_pending' } });
  for (const data of [new Uint8Array([0xc3, 0x28]), new Uint8Array([0xe2, 0x82])]) {
    const stream = streamResponse([data]); const f = fixture({ fetchImpl: () => stream.response });
    await rejectsFixed(f.adapters.device({ request: deviceRequest() }), 'invalid_utf8'); assert.equal(stream.stats.readerCancels, 1);
  }
});

test('invalid JSON and malformed response/reader values produce fixed errors without unbounded fallback', async () => {
  const malformedJson = fixture({ fetchImpl: () => streamResponse([encode(`{${RAW_ERROR}`)]).response });
  await rejectsFixed(malformedJson.adapters.device({ request: deviceRequest() }), 'invalid_json');
  for (const response of [{ status: 200, body: null }, { status: 200, body: { getReader: () => ({}) } }, { status: 2.5, body: null },
    streamResponse([], { read: () => ({ done: false, value: 'text' }) }).response,
    streamResponse([], { read: () => ({ done: false, value: new Proxy(encode('{}'), {}) }) }).response,
    streamResponse([], { read: () => ({ done: 'yes' }) }).response]) {
    const f = fixture({ fetchImpl: () => response }); await rejectsFixed(f.adapters.device({ request: deviceRequest() }), 'invalid_response');
  }
});

test('finite reader fragment bound stops an infinite stream of empty chunks', async () => {
  const stream = streamResponse([], { read: () => ({ done: false, value: new Uint8Array() }) });
  const f = fixture({ fetchImpl: () => stream.response }); await rejectsFixed(f.adapters.device({ request: deviceRequest() }), 'body_limit');
  assert.ok(stream.stats.reads <= 65_537); assert.equal(stream.stats.readerCancels, 1); assert.equal(f.clock.pending(), 0);
});

test('request and pre-aborted native signal validation happen before fetch and never echo abort reason', async () => {
  const controller = new AbortController(); controller.abort(new Error(`${RAW_ERROR}:${ACCESS}`)); const f = fixture();
  await rejectsFixed(f.adapters.device({ request: deviceRequest(), signal: controller.signal }), 'aborted');
  await rejectsFixed(f.adapters.device({ request: deviceRequest(), signal: {} }), 'invalid_input');
  assert.equal(f.calls.length, 0); assert.equal(f.clock.pending(), 0);
});

test('hanging fetch timeout settles without abort cooperation and a late response is cancelled once', async () => {
  const pending = deferred(); const f = fixture({ config: { timeoutMs: 20 }, fetchImpl: () => pending.promise });
  const task = observe(f.adapters.device({ request: deviceRequest() })); await flush(); await f.clock.advance(20);
  assertFixed((await task).error, 'timeout'); assert.equal(f.calls[0].options.signal.aborted, true); assert.equal(f.clock.pending(), 0);
  const late = streamResponse([], { cancelBody: () => new Promise(() => {}) }); pending.resolve(late.response); await flush();
  assert.equal(late.stats.bodyCancels, 1); assert.equal(late.stats.reads, 0);
});

test('shared timeout includes hanging body read; hostile cleanup cannot delay rejection', async () => {
  for (const release of [() => { throw new Error(RAW_ERROR); }, () => Promise.reject(new Error(RAW_ERROR)), () => new Promise(() => {})]) {
    const stream = streamResponse([], { read: () => new Promise(() => {}), cancelReader: () => new Promise(() => {}), release });
    const f = fixture({ config: { timeoutMs: 20 }, fetchImpl: () => stream.response }); const task = observe(f.adapters.poll({ request: pollRequest() }));
    await flush(); await f.clock.advance(20); assertFixed((await task).error, 'timeout'); await flush();
    assert.equal(stream.stats.readerCancels, 1); assert.equal(stream.stats.releases, 1); assert.equal(f.calls[0].options.signal.aborted, true); assert.equal(f.clock.pending(), 0);
  }
});

test('external abort during body decode is terminal even when read/cancel ignore or reject', async () => {
  const pendingRead = deferred(); const controller = new AbortController();
  const stream = streamResponse([], { read: () => pendingRead.promise, cancelReader: () => Promise.reject(new Error(`${RAW_ERROR}:${REFRESH}`)) });
  const f = fixture({ fetchImpl: () => stream.response }); const task = observe(f.adapters.device({ request: deviceRequest(), signal: controller.signal }));
  await flush(); controller.abort(new Error(`${RAW_ERROR}:${ACCESS}`)); assertFixed((await task).error, 'aborted');
  assert.equal(stream.stats.readerCancels, 1); assert.equal(stream.stats.releases, 1); assert.equal(f.clock.pending(), 0);
  pendingRead.resolve({ done: true }); await flush();
  for (const boundary of ['status', 'body', 'getReader']) {
    const signalOwner = new AbortController(); const data = jsonResponse(deviceBody());
    if (boundary === 'status') Object.defineProperty(data.response, 'status', { get() { signalOwner.abort(RAW_ERROR); return 200; } });
    else if (boundary === 'body') { const original = data.response.body; Object.defineProperty(data.response, 'body', { get() { signalOwner.abort(RAW_ERROR); return original; } }); }
    else data.response.body.getReader = () => { signalOwner.abort(RAW_ERROR); return data.reader; };
    const aborted = fixture({ fetchImpl: () => data.response });
    await rejectsFixed(aborted.adapters.device({ request: deviceRequest(), signal: signalOwner.signal }), 'aborted');
    assert.equal(data.stats.reads, 0); assert.equal(aborted.clock.pending(), 0);
  }
});

test('response/read/cleanup exceptions cannot expose raw canaries or cause chains', async () => {
  const statusGetter = { body: null }; Object.defineProperty(statusGetter, 'status', { get() { throw new Error(`${RAW_ERROR}:${ACCESS}`); } });
  for (const fetchImpl of [() => { throw new Error(`${RAW_ERROR}:${ACCESS}`); }, () => Promise.reject(RAW_ERROR), () => statusGetter,
    () => streamResponse([], { read: () => { throw new Error(`${RAW_ERROR}:${REFRESH}`); }, cancelReader: () => { throw new Error(RAW_ERROR); } }).response]) {
    const f = fixture({ fetchImpl }); await rejectsFixed(f.adapters.device({ request: deviceRequest() }), 'request_failed'); assert.equal(f.clock.pending(), 0);
  }
});

test('native promise observation and boxed raw responses/chunks do not invoke hostile then getters', async () => {
  let reads = 0; const raw = jsonResponse(deviceBody());
  Object.defineProperty(raw.response, 'then', { get() { reads += 1; throw new Error(RAW_ERROR); } });
  const direct = fixture({ fetchImpl: () => raw.response }); assert.equal((await direct.adapters.device({ request: deviceRequest() })).body.device_code, DEVICE);
  const native = Promise.resolve(jsonResponse(deviceBody()).response);
  Object.defineProperty(native, 'then', { get() { reads += 1; throw new Error(RAW_ERROR); } });
  const promised = fixture({ fetchImpl: () => native }); assert.equal((await promised.adapters.device({ request: deviceRequest() })).body.device_code, DEVICE);
  const chunk = { done: false, value: encode(JSON.stringify(deviceBody())) };
  Object.defineProperty(chunk, 'then', { get() { reads += 1; throw new Error(RAW_ERROR); } });
  const stream = streamResponse([], { read: (number) => number === 1 ? chunk : { done: true } });
  const reader = fixture({ fetchImpl: () => stream.response }); await rejectsFixed(reader.adapters.device({ request: deviceRequest() }), 'invalid_response');
  assert.equal(reads, 0);
});

test('late response without body.cancel uses nonblocking reader cancellation and releases its lock', async () => {
  const pending = deferred(); const f = fixture({ config: { timeoutMs: 20 }, fetchImpl: () => pending.promise });
  const task = observe(f.adapters.device({ request: deviceRequest() })); await flush(); await f.clock.advance(20); assertFixed((await task).error, 'timeout');
  const late = streamResponse([], { cancelReader: () => Promise.reject(new Error(RAW_ERROR)), release: () => Promise.reject(new Error(RAW_ERROR)) }); delete late.response.body.cancel;
  pending.resolve(late.response); await flush(); assert.equal(late.stats.readerCancels, 1); assert.equal(late.stats.releases, 1);
});

test('actual HTTP adapter plus device harness performs private pending/slowdown/grant with fake fetch only', async () => {
  const clock = manualClock(); const calls = []; let polls = 0; const prompts = []; let grantHandle;
  const vault = createCredentialVault({ now: clock.now });
  const adapters = createDeviceGrantHttpAdapters({ clientId: CLIENT, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    fetch: (url, options) => {
      calls.push({ url, options, at: clock.now() });
      if (url === DEVICE_URL) return jsonResponse(deviceBody()).response;
      polls += 1;
      return polls === 1 ? jsonResponse({ status: 400, message: 'authorization_pending' }, { status: 400 }).response
        : polls === 2 ? jsonResponse({ error: 'slow_down', error_description: RAW_ERROR }, { status: 400 }).response
          : jsonResponse(tokenBody()).response;
    },
  });
  const harness = createDeviceGrantHarness({ clientId: CLIENT, adapters, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onPrompt: (prompt) => prompts.push(prompt), onGrant: (grant) => { grantHandle = vault.store(grant); },
  });
  const terminal = harness.start(); await flush(); assert.equal(prompts.length, 1); assert.equal(prompts[0].userCode, USER_CODE);
  await clock.advance(1_000); assert.equal(harness.getState().pollIntervalMs, 1_000);
  await clock.advance(1_000); assert.equal(harness.getState().pollIntervalMs, 6_000);
  await clock.advance(6_000); const result = await terminal; assert.equal(result.ok, true); assert.equal(result.code, 'grant_delivered');
  assert.deepEqual(calls.filter((call) => call.url === TOKEN_URL).map((call) => call.at - BASE), [1_000, 2_000, 8_000]);
  for (const call of calls) {
    assert.deepEqual(call.options.headers, { 'Content-Type': 'application/x-www-form-urlencoded' });
    if (call.url === TOKEN_URL) assert.equal(new URLSearchParams(call.options.body).get('device_code'), DEVICE);
  }
  assert.equal(vault.resolveAccess(grantHandle), ACCESS); assert.equal(result.state.authorizationVerified, false); assert.equal(result.state.realTwitchConnected, false); assert.equal(result.state.networkConnected, false);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_|ABCD1234|twitch\.tv\/activate|"scope"|"scopes"/); assert.equal(clock.pending(), 0);
});

test('default referenced timer settles standalone hanging HTTP fetch instead of early process exit', async () => {
  const moduleUrl = new URL('../src/device-grant-http.mjs', import.meta.url).href;
  const script = `import {createDeviceGrantHttpAdapters} from ${JSON.stringify(moduleUrl)};
    const a=createDeviceGrantHttpAdapters({clientId:'syntheticdevicehttp01',timeoutMs:20,fetch:()=>new Promise(()=>{})});
    try{await a.device({request:{method:'POST',url:'https://id.twitch.tv/oauth2/device',body:{client_id:'syntheticdevicehttp01',scopes:'user:read:chat'}}});process.exitCode=2;}
    catch(error){if(error.message!=='timeout'||error.cause)process.exitCode=3;else console.log('timeout');}
  `;
  const result = await runFile(process.execPath, ['--input-type=module', '-e', script], { timeout: 3_000, windowsHide: true });
  assert.equal(result.stdout.trim(), 'timeout'); assert.equal(result.stderr, '');
});
