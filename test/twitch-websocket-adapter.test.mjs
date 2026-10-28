import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createTwitchWebSocketAdapter } from '../src/twitch-websocket-adapter.mjs';
import { createTwitchHttpAdapters } from '../src/twitch-http-adapters.mjs';
import { createTwitchSession } from '../src/twitch-session.mjs';
import { createBoard } from '../src/engine.mjs';

// Fake EventEmitter sockets and HTTP streams only: no ws package, network,
// Twitch account, real token, authorization or browser is used by this suite.
const ENDPOINT = 'wss://eventsub.wss.twitch.tv/ws';
const CANARY = 'SYNTHETIC_PRIVATE_SOCKET_DATA';
const BASE_TIME = Date.parse('2026-10-25T08:00:00.000Z');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const codes = new Set([
  'invalid_input', 'invalid_socket', 'factory_failed', 'connect_timeout', 'aborted',
  'transport_error', 'closed_before_open', 'invalid_frame', 'frame_limit',
  'frame_overload', 'callback_failed',
]);

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function clockFixture() {
  let time = BASE_TIME;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer(callback, delay) { const id = ++sequence; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    pending: () => timers.size,
    scheduled: () => [...timers.values()],
    async advance(milliseconds) {
      const target = time + milliseconds;
      let iterations = 0;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        if (++iterations > 1_000) throw new Error('Synthetic timer bound exceeded.');
        const [id, timer] = next; timers.delete(id); time = timer.at;
        await timer.callback(); await flush();
      }
      time = target; await flush();
    },
  };
}
class FakeSocket extends EventEmitter {
  constructor({ closeBehavior, terminateBehavior } = {}) {
    super();
    this.readyState = 0;
    this.calls = { close: 0, terminate: 0, send: 0 };
    this.closeBehavior = closeBehavior;
    this.terminateBehavior = terminateBehavior;
  }
  open() { this.readyState = 1; this.emit('open'); }
  message(data, isBinary = false) { return this.emit('message', data, isBinary); }
  remoteClose() { this.readyState = 3; this.emit('close', 1006, Buffer.from(CANARY)); }
  close() { this.calls.close += 1; this.readyState = 2; return this.closeBehavior?.(); }
  terminate() { this.calls.terminate += 1; this.readyState = 3; return this.terminateBehavior?.(); }
  send() { this.calls.send += 1; throw new Error(CANARY); }
}

function fixture({ config = {}, callbacks = {}, factory, socketOptions } = {}) {
  const clock = clockFixture();
  const calls = { factory: [], frames: [], errors: [], disconnects: [] };
  const sockets = [];
  const adapter = createTwitchWebSocketAdapter({
    createSocket: (url, options) => {
      calls.factory.push({ url, options });
      if (factory) return factory(url, options);
      const socket = new FakeSocket(socketOptions); sockets.push(socket); return socket;
    },
    setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...config,
  });
  const input = {
    onFrame: (...args) => { calls.frames.push(args); return callbacks.onFrame?.(...args); },
    onError: (...args) => { calls.errors.push(args); return callbacks.onError?.(...args); },
    onDisconnect: (...args) => { calls.disconnects.push(args); return callbacks.onDisconnect?.(...args); },
  };
  const socket = () => sockets.at(-1);
  async function opened(extra = {}) {
    const task = adapter.connect({ ...input, ...extra });
    await flush();
    socket().open();
    return task;
  }
  return { adapter, clock, calls, sockets, input, socket, opened };
}

function assertFixed(error, expected) {
  assert.ok(error instanceof Error);
  assert.equal(error.name, 'Error');
  assert.ok(codes.has(error.message), error.message);
  if (expected) assert.equal(error.message, expected);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.doesNotMatch(String(error.stack), /SYNTHETIC_PRIVATE_SOCKET_DATA/);
  assert.doesNotMatch(JSON.stringify(error), /SYNTHETIC_PRIVATE_SOCKET_DATA/);
}
async function rejectsFixed(task, expected) {
  await assert.rejects(task, (error) => { assertFixed(error, expected); return true; });
}
const observe = (task) => task.then((value) => ({ value }), (error) => ({ error }));
function assertTerminalListeners(socket) {
  assert.equal(socket.listenerCount('open'), 0);
  assert.equal(socket.listenerCount('message'), 0);
  assert.equal(socket.listenerCount('close'), 0);
  assert.equal(socket.listenerCount('error'), 1);
}

test('factory and callbacks are explicit, with invalid configuration rejected before socket construction', async () => {
  assert.throws(() => createTwitchWebSocketAdapter());
  for (const config of [{ connectTimeoutMs: 0 }, { connectTimeoutMs: '5000' }, { maxPendingFrames: 0 }, { maxPendingFrames: 1.5 }]) {
    assert.throws(() => fixture({ config }));
  }
  const f = fixture();
  await rejectsFixed(f.adapter.connect({ onFrame() {}, onError() {} }), 'invalid_input');
  await rejectsFixed(f.adapter.connect({ ...f.input, url: 'wss://attacker.example' }), 'invalid_input');
  assert.equal(f.calls.factory.length, 0);
});

test('configuration and callback getters are not invoked', async () => {
  let invoked = false;
  const configuration = {};
  Object.defineProperty(configuration, 'createSocket', { enumerable: true, get() { invoked = true; throw new Error(CANARY); } });
  assert.throws(() => createTwitchWebSocketAdapter(configuration), (error) => { assertFixed(error, 'invalid_input'); return true; });
  assert.equal(invoked, false);
  const f = fixture(); const input = { ...f.input };
  Object.defineProperty(input, 'onFrame', { enumerable: true, get() { invoked = true; throw new Error(CANARY); } });
  await rejectsFixed(f.adapter.connect(input), 'invalid_input');
  assert.equal(invoked, false);
  assert.equal(f.calls.factory.length, 0);
});

test('fixed endpoint and frozen receiver options contain no credential or caller-supplied URL', async () => {
  const f = fixture(); const handle = await f.opened();
  assert.ok(Object.isFrozen(f.adapter));
  assert.ok(Object.isFrozen(handle));
  assert.deepEqual(Object.keys(handle), ['close']);
  assert.deepEqual(f.calls.factory[0], {
    url: ENDPOINT,
    options: {
      maxPayload: 65_536, perMessageDeflate: false, followRedirects: false,
      autoPong: true, skipUTF8Validation: false, handshakeTimeout: 5_000,
      maxFragments: 1_024, maxBufferedChunks: 1_024,
    },
  });
  assert.ok(Object.isFrozen(f.calls.factory[0].options));
  assert.equal(f.socket().calls.send, 0);
  assert.equal(f.clock.pending(), 0);
  handle.close();
});

test('factory errors and invalid socket objects are sanitized', async () => {
  const throwing = fixture({ factory: () => { throw new Error(CANARY); } });
  await rejectsFixed(throwing.adapter.connect(throwing.input), 'factory_failed');
  for (const returned of [null, {}, { readyState: 99 }, { on() {}, off() {}, close() {}, readyState: 0 }]) {
    const f = fixture({ factory: () => returned });
    await rejectsFixed(f.adapter.connect(f.input), 'invalid_socket');
    assert.equal(f.clock.pending(), 0);
  }
});

test('async factories are rejected and late resolved socket resources are closed without unhandled errors', async () => {
  const pending = deferred();
  const f = fixture({ factory: () => pending.promise });
  await rejectsFixed(f.adapter.connect(f.input), 'invalid_socket');
  const lateSocket = new FakeSocket();
  pending.resolve(lateSocket); await flush();
  assert.ok(lateSocket.calls.close + lateSocket.calls.terminate >= 1);
  assert.doesNotThrow(() => lateSocket.emit('error', new Error(CANARY)));
  const rejected = fixture({ factory: () => Promise.reject(new Error(CANARY)) });
  await rejectsFixed(rejected.adapter.connect(rejected.input), 'invalid_socket');
  await flush();
});

test('connect remains pending until open and resolves only once without application sends', async () => {
  const f = fixture(); let settled = false;
  const task = f.adapter.connect(f.input).then((handle) => { settled = true; return handle; });
  await flush();
  assert.equal(settled, false);
  const queuedOldDeadline = f.clock.scheduled()[0].callback;
  assert.equal(f.socket().listenerCount('open'), 1);
  assert.equal(f.socket().listenerCount('message'), 1);
  f.socket().open();
  const handle = await task;
  await queuedOldDeadline();
  f.socket().message('after-cleared-deadline');
  assert.deepEqual(f.calls.frames, [['after-cleared-deadline']]);
  assert.equal(f.calls.errors.length, 0);
  assert.equal(f.socket().calls.terminate, 0);
  f.socket().open();
  assert.equal(f.calls.factory.length, 1);
  assert.equal(f.socket().listenerCount('message'), 1);
  assert.equal(f.socket().calls.send, 0);
  assert.equal(f.clock.pending(), 0);
  handle.close();
});

test('pre-abort and invalid signals prevent socket creation', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort(CANARY);
  await rejectsFixed(f.adapter.connect({ ...f.input, signal: controller.signal }), 'aborted');
  await rejectsFixed(f.adapter.connect({ ...f.input, signal: {} }), 'invalid_input');
  assert.equal(f.calls.factory.length, 0);
});

test('abort, timeout, error and close before open reject once, clean listeners and ignore late activity', async () => {
  for (const mode of ['abort', 'timeout', 'error', 'close']) {
    const f = fixture(); const controller = new AbortController();
    const outcome = observe(f.adapter.connect({ ...f.input, signal: controller.signal }));
    await flush();
    if (mode === 'abort') controller.abort(CANARY);
    if (mode === 'timeout') await f.clock.advance(5_000);
    if (mode === 'error') f.socket().emit('error', new Error(CANARY));
    if (mode === 'close') f.socket().remoteClose();
    const expected = { abort: 'aborted', timeout: 'connect_timeout', error: 'transport_error', close: 'closed_before_open' }[mode];
    assertFixed((await outcome).error, expected);
    assert.equal(f.calls.errors.length, 0);
    assert.equal(f.calls.disconnects.length, 0);
    assert.equal(f.clock.pending(), 0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assertTerminalListeners(f.socket());
    assert.doesNotThrow(() => f.socket().emit('error', new Error(CANARY)));
    f.socket().open(); f.socket().message('late synthetic text');
    assert.equal(f.calls.frames.length, 0);
  }
});

test('manual close is nonblocking void, removes hooks and never invokes disconnect/error callbacks', async () => {
  const never = new Promise(() => {});
  const f = fixture({ socketOptions: { closeBehavior: () => never } });
  const controller = new AbortController();
  const handle = await f.opened({ signal: controller.signal });
  assert.equal(handle.close(), undefined);
  assert.equal(handle.close(), undefined);
  assert.equal(f.socket().calls.close, 1);
  assert.equal(f.calls.disconnects.length, 0);
  assert.equal(f.calls.errors.length, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
  assertTerminalListeners(f.socket());
  f.socket().remoteClose(); f.socket().open(); f.socket().message('late');
  assert.doesNotThrow(() => f.socket().emit('error', new Error(CANARY)));
  controller.abort(CANARY); await flush();
  assert.equal(f.calls.frames.length, 0);
  assert.equal(f.calls.disconnects.length, 0);
  assert.equal(f.calls.errors.length, 0);
});

test('remote close reports one zero-argument disconnect and later errors are harmless', async () => {
  const f = fixture(); await f.opened();
  f.socket().remoteClose(); f.socket().remoteClose();
  assert.deepEqual(f.calls.disconnects, [[]]);
  assert.equal(f.calls.errors.length, 0);
  assertTerminalListeners(f.socket());
  assert.doesNotThrow(() => f.socket().emit('error', new Error(CANARY)));
});

test('active abort and transport error report a fixed Error once and terminate without disconnect', async () => {
  for (const mode of ['abort', 'error']) {
    const f = fixture(); const controller = new AbortController();
    await f.opened({ signal: controller.signal });
    if (mode === 'abort') controller.abort(CANARY);
    else f.socket().emit('error', new Error(CANARY));
    await flush();
    assert.equal(f.calls.errors.length, 1);
    assert.equal(f.calls.errors[0].length, 1);
    assertFixed(f.calls.errors[0][0], mode === 'abort' ? 'aborted' : 'transport_error');
    assert.equal(f.calls.disconnects.length, 0);
    assert.equal(f.socket().calls.terminate, 1);
    assertTerminalListeners(f.socket());
    assert.doesNotThrow(() => f.socket().emit('error', new Error(CANARY)));
  }
});

test('text, Buffer and sliced Uint8Array frames are decoded without application sends', async () => {
  const f = fixture(); const handle = await f.opened();
  f.socket().message('!vote a');
  f.socket().message(Buffer.from('!source'));
  const bytes = new Uint8Array([0xff, ...new TextEncoder().encode('!help'), 0xff]);
  f.socket().message(bytes.subarray(1, bytes.length - 1));
  const validPair = String.fromCodePoint(0x1f680);
  f.socket().message(validPair);
  assert.deepEqual(f.calls.frames, [['!vote a'], ['!source'], ['!help'], [validPair]]);
  assert.equal(f.socket().calls.send, 0);
  assert.equal(f.calls.errors.length, 0);
  handle.close();
});

test('binary flags, absent flags, invalid types and malformed UTF8 fail closed', async () => {
  for (const [data, binary, absent] of [
    ['!source', true], ['!source', false, true], [{ unsafe: CANARY }, false],
    [new Uint16Array([1]), false], [new Uint8Array([0xc3, 0x28]), false],
    [String.fromCharCode(0xd800), false], [String.fromCharCode(0xdc00), false],
  ]) {
    const f = fixture(); await f.opened();
    if (absent) f.socket().emit('message', data);
    else f.socket().emit('message', data, binary);
    assert.equal(f.calls.frames.length, 0);
    assert.equal(f.calls.errors.length, 1);
    assertFixed(f.calls.errors[0][0], 'invalid_frame');
    assert.equal(f.socket().calls.terminate, 1);
    assertTerminalListeners(f.socket());
  }
});

test('frame limit admits exactly 65536 bytes and rejects an extra byte or multibyte overflow', async () => {
  const good = fixture(); const handle = await good.opened();
  good.socket().message(Buffer.alloc(65_536, 0x61));
  assert.equal(good.calls.frames[0][0].length, 65_536);
  handle.close();
  for (const data of [Buffer.alloc(65_537, 0x61), '月'.repeat(22_000)]) {
    const f = fixture(); await f.opened(); f.socket().message(data);
    assert.equal(f.calls.frames.length, 0);
    assertFixed(f.calls.errors[0][0], 'frame_limit');
    assert.equal(f.socket().calls.terminate, 1);
  }
});

test('pending frame callback does not serialize later keepalive delivery', async () => {
  const pending = deferred();
  const f = fixture({ callbacks: { onFrame: (text) => text === 'synthetic-welcome' ? pending.promise : undefined } });
  const handle = await f.opened();
  f.socket().message('synthetic-welcome');
  f.socket().message('synthetic-keepalive');
  assert.deepEqual(f.calls.frames, [['synthetic-welcome'], ['synthetic-keepalive']]);
  pending.resolve(); await flush(); handle.close();
});

test('default pending callback cap accepts 32 and rejects the next without queueing it', async () => {
  const pending = deferred();
  const f = fixture({ callbacks: { onFrame: () => pending.promise } });
  await f.opened();
  for (let index = 0; index < 32; index += 1) f.socket().message(`synthetic-${index}`);
  assert.equal(f.calls.frames.length, 32);
  assert.equal(f.calls.errors.length, 0);
  f.socket().message('synthetic-overload');
  assert.equal(f.calls.frames.length, 32);
  assert.equal(f.calls.errors.length, 1);
  assertFixed(f.calls.errors[0][0], 'frame_overload');
  assert.equal(f.socket().calls.terminate, 1);
  pending.resolve(); await flush();
  f.socket().message('late');
  assert.equal(f.calls.frames.length, 32);
  assert.equal(f.calls.errors.length, 1);
});

test('settled callback promises release their configured pending slot', async () => {
  const pending = deferred();
  const f = fixture({ config: { maxPendingFrames: 1 }, callbacks: { onFrame: (text) => text === 'first' ? pending.promise : undefined } });
  const handle = await f.opened();
  f.socket().message('first'); pending.resolve(); await flush();
  f.socket().message('second');
  assert.deepEqual(f.calls.frames, [['first'], ['second']]);
  assert.equal(f.calls.errors.length, 0);
  handle.close();
});

test('throwing or rejecting frame callbacks produce one sanitized failure with no unhandled rejection', async () => {
  for (const behavior of [
    () => { throw new Error(CANARY); },
    () => Promise.reject(new Error(CANARY)),
    () => Object.defineProperty({}, 'then', { get() { throw new Error(CANARY); } }),
    () => {
      const rejected = Promise.reject(new Error(CANARY));
      Object.defineProperty(rejected, 'then', { get() { throw new Error(CANARY); } });
      return rejected;
    },
  ]) {
    const f = fixture({ callbacks: { onFrame: behavior } }); await f.opened();
    assert.doesNotThrow(() => f.socket().message('synthetic'));
    await flush();
    assert.equal(f.calls.errors.length, 1);
    assertFixed(f.calls.errors[0][0], 'callback_failed');
    assert.equal(f.socket().calls.terminate, 1);
    assert.equal(f.calls.disconnects.length, 0);
  }
});

test('error/disconnect callback exceptions and rejected cleanup promises cannot escape or recurse', async () => {
  for (const rejected of [false, true]) {
    const behavior = () => { if (rejected) return Promise.reject(new Error(CANARY)); throw new Error(CANARY); };
    const errored = fixture({ callbacks: { onError: behavior }, socketOptions: { terminateBehavior: behavior } });
    await errored.opened();
    assert.doesNotThrow(() => errored.socket().message('binary', true));
    await flush();
    assert.equal(errored.calls.errors.length, 1);
    const disconnected = fixture({ callbacks: { onDisconnect: behavior } });
    await disconnected.opened();
    assert.doesNotThrow(() => disconnected.socket().remoteClose());
    await flush();
    assert.equal(disconnected.calls.disconnects.length, 1);
    const closed = fixture({ socketOptions: { closeBehavior: behavior } });
    const handle = await closed.opened();
    assert.doesNotThrow(() => handle.close());
    await flush();
    assert.equal(closed.calls.errors.length, 0);
  }
});

test('terminal error sink is installed before terminate can synchronously emit an error', async () => {
  const f = fixture(); await f.opened();
  f.socket().terminateBehavior = () => f.socket().emit('error', new Error(CANARY));
  assert.doesNotThrow(() => f.socket().message('binary', true));
  assert.equal(f.calls.errors.length, 1);
  assertTerminalListeners(f.socket());
});

test('default connection deadline keeps a standalone Node process alive with a never-opening fake socket', async () => {
  const moduleUrl = new URL('../src/twitch-websocket-adapter.mjs', import.meta.url).href;
  const script = `
    import { EventEmitter } from 'node:events';
    import { createTwitchWebSocketAdapter } from ${JSON.stringify(moduleUrl)};
    class Socket extends EventEmitter {
      readyState = 0;
      close() { this.readyState = 3; }
      terminate() { this.readyState = 3; }
    }
    const adapter = createTwitchWebSocketAdapter({ createSocket: () => new Socket(), connectTimeoutMs: 20 });
    try {
      await adapter.connect({ onFrame() {}, onDisconnect() {}, onError() {} });
      process.exitCode = 2;
    } catch (error) {
      if (error.message === 'connect_timeout' && !Object.hasOwn(error, 'cause')) process.stdout.write('connect_timeout\\n');
      else process.exitCode = 3;
    }
  `;
  const { stdout, stderr } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 5_000, windowsHide: true });
  assert.equal(stdout.trim(), 'connect_timeout');
  assert.equal(stderr, '');
});

test('actual HTTP/WS/coordinator modules process keepalive during pending subscribe with synthetic dependencies only', async () => {
  const clock = clockFixture();
  const pendingAck = deferred();
  const requests = [];
  const events = [];
  const rejections = [];
  const socket = new FakeSocket();
  const client = 'syntheticclient01';
  const user = '100';
  const sessionId = 'synthetic-session';
  const subscription = {
    id: 'synthetic-subscription', type: 'channel.chat.message', version: '1', status: 'enabled',
    condition: { broadcaster_user_id: user, user_id: user },
    transport: { method: 'websocket', session_id: sessionId },
  };
  function jsonResponse(body, status) {
    let sent = false;
    return { status, body: {
      cancel() {},
      getReader: () => ({
        async read() { if (sent) return { done: true }; sent = true; return { done: false, value: new TextEncoder().encode(JSON.stringify(body)) }; },
        cancel() {}, releaseLock() {},
      }),
    } };
  }
  const http = createTwitchHttpAdapters({
    fetch: (url, options) => {
      requests.push({ url, options });
      return url === 'https://id.twitch.tv/oauth2/validate'
        ? jsonResponse({ client_id: client, user_id: user, scopes: ['user:read:chat'], expires_in: 7_200 }, 200)
        : pendingAck.promise;
    },
    resolveCredential: () => 'SYNTHETIC_HTTP_CANARY',
    clientId: client, broadcasterId: user, readerId: user, timeoutMs: 8_000,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  const websocket = createTwitchWebSocketAdapter({ createSocket: () => socket, setTimer: clock.setTimer, clearTimer: clock.clearTimer });
  const board = createBoard({ now: clock.now }); board.setConnection('connected'); board.openVote();
  const coordinator = createTwitchSession({
    clientId: client, broadcasterId: user, readerId: user,
    adapters: { ...http, connect: websocket.connect },
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onEvent: (event) => { events.push(event); rejections.push(board.processEvent(event).code); },
  });
  const startTask = coordinator.start({ opaque: 'synthetic-handle' });
  await flush(); socket.open(); assert.equal((await startTask).ok, true);
  const metadata = (id, type, subscribed = false) => ({
    message_id: id, message_type: type, message_timestamp: new Date(clock.now()).toISOString(),
    ...(subscribed ? { subscription_type: 'channel.chat.message', subscription_version: '1' } : {}),
  });
  socket.message(JSON.stringify({
    metadata: metadata('synthetic-welcome', 'session_welcome'),
    payload: { session: { id: sessionId, status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null } },
  }));
  await flush(); assert.equal(coordinator.getState().phase, 'subscribing');
  await clock.advance(4_000);
  socket.message(JSON.stringify({ metadata: metadata('synthetic-keepalive', 'session_keepalive'), payload: {} }));
  await flush();
  assert.equal(coordinator.getState().phase, 'subscribing');
  assert.equal(coordinator.getState().keepaliveDeadline, BASE_TIME + 14_000);
  assert.equal(coordinator.getState().metrics.frames, 2);
  await clock.advance(1_000);
  pendingAck.resolve(jsonResponse({ data: [subscription] }, 202)); await flush();
  assert.equal(coordinator.getState().phase, 'receiving');
  assert.equal(coordinator.getState().keepaliveDeadline, BASE_TIME + 14_000);
  socket.message(JSON.stringify({
    metadata: metadata('synthetic-delivery', 'notification', true),
    payload: { subscription, event: { broadcaster_user_id: user, chatter_user_id: '300', message_id: 'synthetic-chat', message: { text: '!vote a', fragments: [] } } },
  }));
  await flush();
  assert.equal(events.length, 1);
  assert.equal(events[0].origin, 'transport-unverified');
  assert.deepEqual(rejections, ['unsupported_origin']);
  assert.equal(board.getState().vote.total, 0);
  assert.equal(coordinator.getState().realTwitchConnected, false);
  assert.equal(coordinator.getState().authorizationVerified, false);
  assert.equal(socket.calls.send, 0);
  assert.equal(requests.length, 2);
  await coordinator.stop();
  assert.equal(socket.calls.close + socket.calls.terminate, 1);
  assert.equal(clock.pending(), 0);
  assertTerminalListeners(socket);
});
