import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { createTwitchWebSocketAdapter } from '../src/twitch-websocket-adapter.mjs';

// Fake EventEmitter sockets only. No actual ws client, network, Twitch,
// browser, account or real credential is constructed or used by these tests.
const LIMIT = 65_536;
const CANARY = 'SYNTHETIC_PRIVATE_FRAME_ERROR_CANARY';
const encode = (text) => new TextEncoder().encode(text);
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
class FakeSocket extends EventEmitter {
  constructor() { super(); this.readyState = 1; this.calls = { terminate: 0, close: 0, send: 0 }; }
  message(data, isBinary = false) { return this.emit('message', data, isBinary); }
  terminate() { this.calls.terminate += 1; this.readyState = 3; }
  close() { this.calls.close += 1; this.readyState = 3; }
  send() { this.calls.send += 1; throw new Error(CANARY); }
}
async function opened({ signal, maxPendingFrames = 32, onFrame } = {}) {
  const socket = new FakeSocket(); const frames = []; const errors = []; let disconnects = 0; let sequence = 0; const timers = new Map();
  const adapter = createTwitchWebSocketAdapter({ createSocket: () => socket, maxPendingFrames,
    setTimer: (callback) => { const id = ++sequence; timers.set(id, callback); return id; }, clearTimer: (id) => timers.delete(id) });
  const handle = await adapter.connect({ onFrame: (text) => { frames.push(text); return onFrame?.(text); }, onError: (error) => errors.push(error), onDisconnect: () => { disconnects += 1; }, ...(signal ? { signal } : {}) });
  return { socket, handle, frames, errors, timers, disconnects: () => disconnects };
}
function summary(f, extra = {}) {
  return { frameBytes: f.frames.map((text) => Buffer.byteLength(text, 'utf8')), errors: f.errors.map((error) => error.message),
    terminate: f.socket.calls.terminate, close: f.socket.calls.close, disconnects: f.disconnects(), ...extra };
}
function fixed(error, code) {
  assert.ok(error instanceof Error); assert.equal(error.name, 'Error'); assert.equal(error.message, code);
  assert.equal(Object.hasOwn(error, 'cause'), false); assert.equal(Object.hasOwn(error, 'code'), false);
  assert.doesNotMatch(String(error.stack), /SYNTHETIC_PRIVATE_FRAME_ERROR_CANARY/); assert.doesNotMatch(JSON.stringify(error), /SYNTHETIC_PRIVATE_FRAME_ERROR_CANARY/);
}
function terminal(f, code, extra = {}) {
  assert.deepEqual(summary(f, extra), { frameBytes: [], errors: [code], terminate: 1, close: 0, disconnects: 0, ...Object.fromEntries(Object.keys(extra).map((key) => [key, 0])) });
  fixed(f.errors[0], code); assert.equal(f.socket.calls.send, 0); assert.equal(f.timers.size, 0);
  assert.deepEqual(['open', 'message', 'close'].map((name) => f.socket.listenerCount(name)), [0, 0, 0]); assert.equal(f.socket.listenerCount('error'), 1);
  f.socket.message('late synthetic frame'); f.socket.emit('error', new Error(CANARY)); f.socket.emit('close', 1006, Buffer.from(CANARY)); f.socket.emit('open'); f.handle.close();
  assert.equal(f.errors.length, 1); assert.equal(f.frames.length, 0); assert.equal(f.socket.calls.terminate, 1); assert.equal(f.socket.calls.close, 0);
}
const bytesOf = (kind, length) => kind === 'Buffer' ? Buffer.alloc(length, 0x61) : new Uint8Array(length).fill(0x61);

test('actual65536-byte Uint8Array and Buffer messages are accepted independently without cumulative accounting', async () => {
  const f = await opened();
  try {
    f.socket.message(bytesOf('Uint8Array', LIMIT)); f.socket.message(bytesOf('Buffer', LIMIT));
    assert.deepEqual(summary(f), { frameBytes: [LIMIT, LIMIT], errors: [], terminate: 0, close: 0, disconnects: 0 });
    assert.ok(f.frames.every((value) => value === 'a'.repeat(LIMIT))); assert.equal(f.timers.size, 0); assert.equal(f.socket.calls.send, 0);
  } finally { f.handle.close(); }
});

test('string limits count UTF8 bytes for valid multibyte text rather than JavaScript length', async () => {
  const f = await opened();
  const exact = '🙂'.repeat(LIMIT / 4); f.socket.message(exact); assert.equal(f.frames[0] === exact, true);
  f.socket.message(exact + 'a'); assert.deepEqual(summary(f), { frameBytes: [LIMIT], errors: ['frame_limit'], terminate: 1, close: 0, disconnects: 0 });
  fixed(f.errors[0], 'frame_limit'); assert.equal(f.socket.listenerCount('message'), 0); f.handle.close();
});

test('delivered view offset and length determine the boundary even when backing storage is larger or malformed', async () => {
  const f = await opened();
  try {
    for (const kind of ['Uint8Array', 'Buffer']) {
      const storage = kind === 'Buffer' ? Buffer.alloc(LIMIT + 2_048, 0xff) : new Uint8Array(LIMIT + 2_048).fill(0xff);
      const view = storage.subarray(1_024, 1_024 + LIMIT); view.fill(0x61); f.socket.message(view);
    }
    assert.deepEqual(summary(f), { frameBytes: [LIMIT, LIMIT], errors: [], terminate: 0, close: 0, disconnects: 0 });
    assert.ok(f.frames.every((text) => text === 'a'.repeat(LIMIT)));
  } finally { f.handle.close(); }
});

for (const kind of ['Uint8Array', 'Buffer']) {
  test(`${kind}: oversized own byteLength0 data property cannot bypass actual frame cap`, async () => {
    const f = await opened(); const bytes = bytesOf(kind, LIMIT + 1); Object.defineProperty(bytes, 'byteLength', { value: 0 });
    f.socket.message(bytes); terminal(f, 'frame_limit');
  });

  test(`${kind}: byteLength getter switching zero to real length cannot admit actual65537 bytes or execute getters`, async () => {
    const f = await opened(); const bytes = bytesOf(kind, LIMIT + 1); let getterReads = 0;
    Object.defineProperty(bytes, 'byteLength', { get() { getterReads += 1; return getterReads === 1 ? 0 : LIMIT + 1; } });
    f.socket.message(bytes); terminal(f, 'frame_limit', { getterReads });
  });

  test(`${kind}: valid decorated views preserve exact text while buffer, offset and length shadows stay unread`, async () => {
    for (const accessors of [false, true]) {
      const f = await opened(); let getterReads = 0; const text = 'synthetic view content: π'; const payload = encode(text);
      const storage = kind === 'Buffer' ? Buffer.alloc(payload.length + 64, 0xff) : new Uint8Array(payload.length + 64).fill(0xff);
      const bytes = storage.subarray(32, 32 + payload.length); bytes.set(payload);
      for (const [key, value] of [['byteLength', 0], ['byteOffset', 0], ['buffer', new ArrayBuffer(0)]]) {
        Object.defineProperty(bytes, key, accessors ? { get() { getterReads += 1; return value; } } : { value });
      }
      try {
        f.socket.message(bytes);
        assert.deepEqual({ ...summary(f), contentMatches: f.frames[0] === text, getterReads }, { frameBytes: [payload.length], errors: [], terminate: 0, close: 0, disconnects: 0, contentMatches: true, getterReads: 0 });
      } finally { f.handle.close(); }
    }
  });
}

test('actual oversize wins before fatal UTF8 decoding and malformed small views fail with fixed private errors', async () => {
  const oversized = bytesOf('Uint8Array', LIMIT + 1); oversized[0] = 0xff; Object.defineProperty(oversized, 'byteLength', { value: 0 });
  const large = await opened(); large.socket.message(oversized); terminal(large, 'frame_limit');
  for (const value of [new Uint8Array([0xff]), new Uint8Array([0xe2, 0x82])]) { const f = await opened(); f.socket.message(value); terminal(f, 'invalid_frame'); }
});

test('typed-array and revoked Proxy brands fail once without reading properties, leaking raw errors or reviving callbacks', async () => {
  let propertyReads = 0; const proxy = new Proxy(encode(CANARY), { get() { propertyReads += 1; throw new Error(CANARY); } });
  const first = await opened(); first.socket.message(proxy); terminal(first, 'invalid_frame', { propertyReads });
  const revoked = Proxy.revocable(encode(CANARY), {}); revoked.revoke(); const second = await opened(); second.socket.message(revoked.proxy); terminal(second, 'invalid_frame');
});

test('prototype traversal reentry cannot admit a frame after abort or exceed a newly occupied pending slot', async () => {
  const controller = new AbortController(); const first = await opened({ signal: controller.signal }); let abortTraps = 0;
  const bytes = encode('outer synthetic frame'); const proto = new Proxy(Object.create(Uint8Array.prototype), { getPrototypeOf(target) { abortTraps += 1; controller.abort(new Error(CANARY)); return Reflect.getPrototypeOf(target); } });
  Object.setPrototypeOf(bytes, proto); first.socket.message(bytes); assert.ok(abortTraps > 0); terminal(first, 'aborted'); assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  const pending = deferred(); const second = await opened({ maxPendingFrames: 1, onFrame: () => pending.promise }); let innerTraps = 0;
  const outer = encode('outer synthetic frame'); const prototype = new Proxy(Object.create(Uint8Array.prototype), { getPrototypeOf(target) { innerTraps += 1; if (innerTraps === 1) second.socket.message('inner synthetic frame'); return Reflect.getPrototypeOf(target); } });
  Object.setPrototypeOf(outer, prototype); second.socket.message(outer);
  assert.deepEqual({ frameCount: second.frames.length, innerMatches: second.frames[0] === 'inner synthetic frame', errors: second.errors.map((error) => error.message), terminate: second.socket.calls.terminate }, { frameCount: 1, innerMatches: true, errors: ['frame_overload'], terminate: 1 });
  fixed(second.errors[0], 'frame_overload'); assert.equal(second.socket.listenerCount('message'), 0); pending.resolve(); await flush();
  second.socket.message('late synthetic frame'); second.socket.emit('error', new Error(CANARY)); assert.equal(second.frames.length, 1); assert.equal(second.errors.length, 1); second.handle.close();
});
