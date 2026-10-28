import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { createTwitchHttpAdapters } from '../src/twitch-http-adapters.mjs';
import { createDeviceGrantHttpAdapters } from '../src/device-grant-http.mjs';

// Synthetic private receipts and injected fetch/readers only. No actual token,
// OAuth, account, network, browser, WebSocket or other suite is exercised.
const CLIENT = 'syntheticcleanview01';
const USER = '100';
const SESSION = 'synthetic-clean-session';
const AUTH = 'SYNTHETIC_AUTH_CANARY_NOT_A_REAL_TOKEN';
const RAW = 'SYNTHETIC_PRIVATE_RAW_ERROR_CANARY';
const LIMIT = 65_536;
const PORTS = ['validate', 'subscribe', 'device', 'poll'];
const encode = (text) => new TextEncoder().encode(text);
function body(port, alternate = false) {
  if (port === 'validate') return { client_id: CLIENT, user_id: USER, scopes: ['user:read:chat'], expires_in: alternate ? 7_200 : 3_600 };
  if (port === 'subscribe') return { data: [{ id: alternate ? 'synthetic-sub-alternate' : 'synthetic-sub-native', status: 'enabled', type: 'channel.chat.message', version: '1',
    condition: { broadcaster_user_id: USER, user_id: USER }, transport: { method: 'websocket', session_id: SESSION } }] };
  if (port === 'device') return { device_code: alternate ? 'SYNTHETIC_DEVICE_ALTERNATE' : 'SYNTHETIC_DEVICE_NATIVE', user_code: 'ABCD1234', verification_uri: 'https://www.twitch.tv/activate', expires_in: alternate ? 1_200 : 1_800, interval: 1 };
  return { access_token: alternate ? 'SYNTHETIC_ALTERNATE_ACCESS' : 'SYNTHETIC_NATIVE_ACCESS', refresh_token: alternate ? 'SYNTHETIC_ALTERNATE_REFRESH' : 'SYNTHETIC_NATIVE_REFRESH', expires_in: alternate ? 7_200 : 3_600, scope: ['user:read:chat'], token_type: 'bearer' };
}
function wire(port, alternate = false, length) {
  const json = JSON.stringify(body(port, alternate)); return encode(json + ' '.repeat(length === undefined ? 0 : length - encode(json).length));
}
function subscribeRequest() { return { method: 'POST', url: 'https://api.twitch.tv/helix/eventsub/subscriptions', body: { type: 'channel.chat.message', version: '1',
  condition: { broadcaster_user_id: USER, user_id: USER }, transport: { method: 'websocket', session_id: SESSION } } }; }
function proposal(port) { return { method: 'POST', url: `https://id.twitch.tv/oauth2/${port === 'device' ? 'device' : 'token'}`, body: { client_id: CLIENT, scopes: 'user:read:chat',
  ...(port === 'poll' ? { device_code: 'SYNTHETIC_REQUEST_DEVICE', grant_type: 'urn:ietf:params:oauth:grant-type:device_code' } : {}) } }; }
function fixture(port, chunks, { read, signal } = {}) {
  let index = 0; let sequence = 0; const timers = new Map(); const stats = { reads: 0, cancels: 0, releases: 0, fetches: 0 }; let sentSignal;
  const reader = { read() { stats.reads += 1; return read ? read(stats.reads) : index < chunks.length ? { done: false, value: chunks[index++] } : { done: true }; },
    cancel() { stats.cancels += 1; return Promise.reject(new Error(RAW)); }, releaseLock() { stats.releases += 1; } };
  const response = { status: port === 'subscribe' ? 202 : 200, body: { getReader: () => reader, cancel: () => reader.cancel() } };
  const config = { clientId: CLIENT, fetch: (_url, options) => { stats.fetches += 1; sentSignal = options.signal; return response; },
    setTimer: (callback) => { const id = ++sequence; timers.set(id, callback); return id; }, clearTimer: (id) => timers.delete(id) };
  const adapter = ['validate', 'subscribe'].includes(port) ? createTwitchHttpAdapters({ ...config, broadcasterId: USER, readerId: USER, resolveCredential: () => AUTH }) : createDeviceGrantHttpAdapters(config);
  const input = { ...(['validate', 'subscribe'].includes(port) ? { credential: Object.freeze({}), ...(port === 'subscribe' ? { request: subscribeRequest() } : {}) } : { request: proposal(port) }), ...(signal ? { signal } : {}) };
  return { task: () => adapter[port](input), stats, timers, sentSignal: () => sentSignal };
}
async function outcome(task) { try { return { value: await task }; } catch (error) { return { error }; } }
function safeError(error, code) {
  assert.ok(error instanceof Error); if (code) assert.equal(error.message, code);
  assert.equal(Object.hasOwn(error, 'cause'), false); assert.equal(Object.hasOwn(error, 'code'), false);
  assert.doesNotMatch(String(error.stack), /SYNTHETIC_|ABCD1234/); assert.doesNotMatch(JSON.stringify(error), /SYNTHETIC_|ABCD1234/);
}
function describe(port, result, getterReads = 0) {
  if (result.error) safeError(result.error);
  return { errorCode: result.error?.message ?? null, nativeContent: Boolean(result.value && JSON.stringify(result.value.body) === JSON.stringify(body(port))),
    alternateContent: Boolean(result.value && JSON.stringify(result.value.body) === JSON.stringify(body(port, true))), getterReads };
}
function accepted(port, result, f, getterReads = 0) {
  assert.deepEqual(describe(port, result, getterReads), { errorCode: null, nativeContent: true, alternateContent: false, getterReads: 0 });
  assert.equal(result.value.httpStatus, port === 'subscribe' ? 202 : 200); assert.equal(Object.isFrozen(result.value), true); assert.equal(Object.isFrozen(result.value.body), true);
  assert.equal(f.stats.cancels, 0); assert.equal(f.stats.releases, 1); assert.equal(f.timers.size, 0);
}
function rejected(result, f, code) { assert.equal(Boolean(result.error), true); safeError(result.error, code); assert.equal(result.value, undefined); assert.equal(f.stats.cancels, 1); assert.equal(f.stats.releases, 1); assert.equal(f.timers.size, 0); }

for (const port of PORTS) {
  test(`${port}: valid native JSON survives own zero span-data properties without changing projected content`, async () => {
    for (const buffer of [false, true]) {
      const bytes = buffer ? Buffer.from(wire(port)) : wire(port);
      for (const [key, value] of [['byteLength', 0], ['byteOffset', 0], ['buffer', new ArrayBuffer(0)]]) Object.defineProperty(bytes, key, { value });
      const f = fixture(port, [bytes]); accepted(port, await outcome(f.task()), f);
    }
  });

  test(`${port}: valid native JSON leaves byteLength, offset and buffer accessors unread`, async () => {
    const bytes = Buffer.from(wire(port)); let getterReads = 0;
    for (const [key, value] of [['byteLength', 0], ['byteOffset', 0], ['buffer', new ArrayBuffer(0)]]) Object.defineProperty(bytes, key, { get() { getterReads += 1; return value; } });
    const f = fixture(port, [bytes]); accepted(port, await outcome(f.task()), f, getterReads);
  });

  test(`${port}: decoder cannot substitute a different valid receipt through a shadow backing buffer`, async () => {
    const original = wire(port, false, 1_024); const alternate = wire(port, true, 1_024);
    const bytes = ['subscribe', 'poll'].includes(port) ? Buffer.from(original) : original;
    Object.defineProperties(bytes, { byteLength: { value: 1_024 }, byteOffset: { value: 0 }, buffer: { value: alternate.buffer } });
    const f = fixture(port, [bytes]); accepted(port, await outcome(f.task()), f);
  });
}

test('all four ports stream split UTF8 BOM and exact offset views without decoding malformed backing bytes', async () => {
  for (const port of PORTS) {
    const bytes = wire(port); const all = new Uint8Array(bytes.length + 3); all.set([0xef, 0xbb, 0xbf]); all.set(bytes, 3);
    const chunks = [all.subarray(0, 1), all.subarray(1, 2), all.subarray(2)].map((part, index) => {
      const backing = index % 2 ? Buffer.alloc(part.length + 128, 0xff) : new Uint8Array(part.length + 128).fill(0xff);
      const view = backing.subarray(64, 64 + part.length); view.set(part); return view;
    });
    const f = fixture(port, chunks); accepted(port, await outcome(f.task()), f); assert.equal(f.stats.reads, 4);
  }
});

test('existing actual cumulative65536-byte acceptance and65537-byte cap precede decoding for every port', async () => {
  for (const port of PORTS) {
    const exact = wire(port, false, LIMIT); const good = fixture(port, [exact.subarray(0, 50_000), exact.subarray(50_000)]); accepted(port, await outcome(good.task()), good);
    const large = wire(port, false, LIMIT + 1); large[LIMIT] = 0xff;
    const first = large.subarray(0, 50_000); const last = large.subarray(50_000); Object.defineProperty(last, 'byteLength', { value: 0 });
    const bad = fixture(port, [first, last]); rejected(await outcome(bad.task()), bad, 'body_limit'); assert.equal(bad.stats.reads, 2);
  }
});

test('proxy brands and malformed small UTF8 remain fixed private failures with one cleanup', async () => {
  for (const port of PORTS) {
    const revoked = Proxy.revocable(wire(port), {}); revoked.revoke();
    for (const value of [new Proxy(wire(port), {}), revoked.proxy]) { const f = fixture(port, [value]); rejected(await outcome(f.task()), f, 'invalid_response'); }
    for (const value of [new Uint8Array([0xff]), new Uint8Array([0xe2, 0x82])]) { const f = fixture(port, [value]); rejected(await outcome(f.task()), f, 'invalid_utf8'); }
  }
});

test('descriptor and real-view prototype cancellation reentry never decodes caller getters or reads another chunk', async () => {
  for (const port of PORTS) for (const boundary of ['descriptor', 'prototype']) {
    const controller = new AbortController(); const bytes = wire(port); let inspected = 0; let afterAbortGetterReads = 0;
    Object.defineProperty(bytes, 'buffer', { get() { if (controller.signal.aborted) afterAbortGetterReads += 1; return new ArrayBuffer(0); } });
    let chunk = { done: false, value: bytes };
    if (boundary === 'descriptor') chunk = new Proxy(chunk, { getOwnPropertyDescriptor(target, key) { inspected += 1; controller.abort(new Error(RAW)); return Reflect.getOwnPropertyDescriptor(target, key); } });
    else Object.setPrototypeOf(bytes, new Proxy(Object.create(Uint8Array.prototype), { getPrototypeOf(target) { inspected += 1; controller.abort(new Error(RAW)); return Reflect.getPrototypeOf(target); } }));
    const f = fixture(port, [], { signal: controller.signal, read: () => chunk }); const result = await outcome(f.task());
    rejected(result, f, 'aborted'); assert.ok(inspected > 0); assert.equal(afterAbortGetterReads, 0); assert.equal(f.stats.reads, 1); assert.equal(f.sentSignal().aborted, true);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  }
});
