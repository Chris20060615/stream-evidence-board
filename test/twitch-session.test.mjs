import test from 'node:test';
import assert from 'node:assert/strict';
import { createTwitchSession } from '../src/twitch-session.mjs';
import { createBoard } from '../src/engine.mjs';

// In-memory synthetic adapters only: no account, token, WebSocket or HTTP call.
const BASE_TIME = Date.parse('2026-10-25T08:00:00.000Z');
const CLIENT = 'synthetic-client';
const CHANNEL = '100';
const SESSION = 'synthetic-session';
const SUBSCRIPTION = 'synthetic-subscription';
const PRIVATE_SENTINEL = 'SYNTHETIC_PRIVATE_ERROR_DO_NOT_PUBLISH';
const flush = () => new Promise((resolve) => setImmediate(resolve));
function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function manualClock() {
  let time = BASE_TIME;
  let sequence = 0;
  const timers = new Map();
  return {
    now: () => time,
    setTimer: (callback, delay) => {
      const id = ++sequence;
      timers.set(id, { callback, deadline: time + delay });
      return id;
    },
    clearTimer: (id) => { timers.delete(id); },
    pending: () => timers.size,
    scheduled: () => [...timers.values()],
    async advance(milliseconds) {
      const target = time + milliseconds;
      let executed = 0;
      while (true) {
        const next = [...timers.entries()]
          .filter(([, timer]) => timer.deadline <= target)
          .sort((a, b) => a[1].deadline - b[1].deadline)[0];
        if (!next) break;
        if (++executed > 1_000) throw new Error('Synthetic timer loop exceeded test bound.');
        const [id, timer] = next; timers.delete(id); time = timer.deadline;
        await timer.callback(); await flush();
      }
      time = target;
      await flush();
    },
  };
}

function assertUnverified(state) {
  assert.equal(state.mode, 'transport-harness');
  assert.equal(state.realTwitchConnected, false);
  assert.equal(state.authorizationVerified, false);
  assert.doesNotMatch(JSON.stringify(state), /synthetic-client|synthetic-session|synthetic-subscription|synthetic-credential-handle|SYNTHETIC_PRIVATE_ERROR_DO_NOT_PUBLISH|Bearer |access_token|Authorization/);
}

function fixture({ config = {}, overrides = {}, onEvent, onAction } = {}) {
  const clock = manualClock();
  let sequence = 0;
  const calls = { validate: [], connect: [], subscribe: [], close: 0 };
  const events = [];
  const actions = [];
  const credential = Object.freeze({ fixtureId: 'synthetic-credential-handle' });
  const validation = () => ({
    httpStatus: 200,
    body: { client_id: CLIENT, user_id: CHANNEL, scopes: ['user:read:chat'], expires_in: 7_200 },
  });
  const acknowledgement = (sessionId = SESSION) => ({
    httpStatus: 202,
    body: { data: [{
      id: SUBSCRIPTION, type: 'channel.chat.message', version: '1', status: 'enabled',
      condition: { broadcaster_user_id: CHANNEL, user_id: CHANNEL },
      transport: { method: 'websocket', session_id: sessionId },
    }] },
  });
  const adapters = {
    async validate(parameters) {
      calls.validate.push(parameters);
      return overrides.validate ? overrides.validate(parameters, calls.validate.length) : validation();
    },
    async connect(callbacks) {
      const connection = { callbacks, handle: { close() { calls.close += 1; } } };
      calls.connect.push(connection);
      return overrides.connect ? overrides.connect(callbacks, connection.handle) : connection.handle;
    },
    async subscribe(parameters) {
      calls.subscribe.push(parameters);
      return overrides.subscribe ? overrides.subscribe(parameters, calls.subscribe.length) : acknowledgement(parameters.request.body.transport.session_id);
    },
  };
  const session = createTwitchSession({
    clientId: CLIENT, broadcasterId: CHANNEL, readerId: CHANNEL,
    adapters, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    onEvent: onEvent ?? ((event) => { events.push(event); }),
    onAction: onAction ?? ((action) => { actions.push(action); }),
    ...config,
  });
  function metadata(type, subscription = false) {
    return {
      message_id: `synthetic-delivery-${++sequence}`, message_type: type,
      message_timestamp: new Date(clock.now()).toISOString(),
      ...(subscription ? { subscription_type: 'channel.chat.message', subscription_version: '1' } : {}),
    };
  }
  function welcome(sessionId = SESSION) {
    return {
      metadata: metadata('session_welcome'),
      payload: { session: { id: sessionId, status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null } },
    };
  }
  function notification(text = '!vote a', sessionId = SESSION) {
    const subscription = acknowledgement(sessionId).body.data[0];
    return {
      metadata: metadata('notification', true),
      payload: {
        subscription,
        event: { broadcaster_user_id: CHANNEL, chatter_user_id: '300', message_id: `synthetic-chat-${sequence}`, message: { text, fragments: [] } },
      },
    };
  }
  const keepalive = () => ({ metadata: metadata('session_keepalive'), payload: {} });
  function revocation() {
    const subscription = acknowledgement().body.data[0];
    subscription.status = 'authorization_revoked';
    return { metadata: metadata('revocation', true), payload: { subscription } };
  }
  function reconnect() {
    return {
      metadata: metadata('session_reconnect'),
      payload: { session: { id: SESSION, status: 'reconnecting', keepalive_timeout_seconds: null, reconnect_url: 'wss://eventsub.wss.twitch.tv/ws?reconnect=synthetic' } },
    };
  }
  const socket = () => calls.connect.at(-1).callbacks;
  const emit = (frame) => socket().onFrame(typeof frame === 'string' ? frame : JSON.stringify(frame));
  async function start(handle = credential) {
    const result = await session.start(handle);
    assertUnverified(session.getState());
    return result;
  }
  async function receiving() {
    const result = await start(); assert.equal(result.ok, true);
    await emit(welcome());
    assert.equal(session.getState().phase, 'receiving');
    assertUnverified(session.getState());
  }
  return {
    session, clock, calls, credential, validation, acknowledgement, events, actions,
    welcome, notification, keepalive, revocation, reconnect, socket, emit, start, receiving,
  };
}

test('new coordinator is idle and requires explicit injected adapters rather than opening a network path', () => {
  const f = fixture();
  assert.equal(f.session.getState().phase, 'idle');
  assertUnverified(f.session.getState());
  assert.equal(f.calls.validate.length, 0);
  assert.equal(f.calls.connect.length, 0);
  assert.equal(f.calls.subscribe.length, 0);
  assert.throws(() => createTwitchSession({ clientId: CLIENT, broadcasterId: CHANNEL, readerId: CHANNEL }));
});

test('startup validates before connecting and does not subscribe before welcome', async () => {
  const pendingValidation = deferred();
  const f = fixture({ overrides: { validate: () => pendingValidation.promise } });
  const task = f.start();
  await flush();
  assert.equal(f.session.getState().phase, 'validating');
  assert.equal(f.calls.connect.length, 0);
  pendingValidation.resolve(f.validation());
  assert.equal((await task).ok, true);
  assert.equal(f.session.getState().phase, 'awaiting_welcome');
  assert.equal(f.calls.subscribe.length, 0);
  assert.equal(f.session.getState().welcomeDeadline, BASE_TIME + 10_000);
  await f.session.stop();
});

test('opaque credentials are passed by reference only to private validate/subscribe adapters', async () => {
  const f = fixture(); await f.receiving();
  assert.equal(f.calls.validate[0].credential, f.credential);
  assert.equal(f.calls.subscribe[0].credential, f.credential);
  assert.deepEqual(Object.keys(f.calls.connect[0].callbacks).sort(), ['onDisconnect', 'onError', 'onFrame', 'signal']);
  assert.ok(f.calls.validate[0].signal instanceof AbortSignal);
  assert.ok(f.calls.subscribe[0].signal instanceof AbortSignal);
  assert.deepEqual(Object.keys(f.calls.subscribe[0].request).sort(), ['body', 'method', 'url']);
  assert.deepEqual(f.calls.subscribe[0].request, {
    method: 'POST', url: 'https://api.twitch.tv/helix/eventsub/subscriptions',
    body: {
      type: 'channel.chat.message', version: '1',
      condition: { broadcaster_user_id: CHANNEL, user_id: CHANNEL },
      transport: { method: 'websocket', session_id: SESSION },
    },
  });
  assertUnverified(f.session.getState());
  await f.session.stop();
});

test('identity, scope and 401 validation mismatches fail before opening a socket', async () => {
  for (const change of [
    (r) => { r.httpStatus = 401; },
    (r) => { r.body.client_id = 'other-client'; },
    (r) => { r.body.user_id = '999'; },
    (r) => { r.body.scopes = ['user:write:chat']; },
    (r) => { r.body.expires_in = 1; },
  ]) {
    let f;
    f = fixture({ overrides: { validate: () => { const receipt = f.validation(); change(receipt); return receipt; } } });
    const result = await f.start();
    assert.equal(result.ok, false);
    assert.equal(f.calls.connect.length, 0);
    assert.equal(f.calls.subscribe.length, 0);
    assert.equal(f.clock.pending(), 0);
    assertUnverified(f.session.getState());
  }
});

test('credential-shaped fields in adapter receipts cannot become public state or permit connection', async () => {
  for (const key of ['access_token', 'Authorization', 'headers', 'client-secret']) {
    let f;
    f = fixture({ overrides: { validate: () => ({ ...f.validation(), extra: { [key]: PRIVATE_SENTINEL } }) } });
    const result = await f.start();
    assert.equal(result.ok, false);
    assert.equal(result.code, 'credential_fields');
    assert.doesNotMatch(JSON.stringify({ result, state: f.session.getState() }), /SYNTHETIC_PRIVATE_ERROR_DO_NOT_PUBLISH/);
    assert.equal(f.calls.connect.length, 0);
  }
});

test('validation and connect adapter exceptions are sanitized and fail closed', async () => {
  for (const adapter of ['validate', 'connect']) {
    const f = fixture({ overrides: { [adapter]: () => { throw new Error(PRIVATE_SENTINEL); } } });
    const result = await f.start();
    assert.equal(result.ok, false);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_ERROR_DO_NOT_PUBLISH/);
    assertUnverified(f.session.getState());
    assert.equal(f.clock.pending(), 0);
  }
});

test('a malformed welcome cannot subscribe or emit a chat event', async () => {
  const f = fixture(); await f.start();
  const invalid = f.welcome(); invalid.payload.session.keepalive_timeout_seconds = 0;
  await f.emit(invalid);
  assert.equal(f.calls.subscribe.length, 0);
  assert.equal(f.events.length, 0);
  assertUnverified(f.session.getState());
  await f.session.stop();
});

test('welcome timeout closes the socket and removes owned timers', async () => {
  const f = fixture(); await f.start();
  await f.clock.advance(10_000);
  assert.equal(f.session.getState().phase, 'timed_out');
  assert.equal(f.calls.close, 1);
  assert.equal(f.clock.pending(), 0);
  assert.equal(f.calls.subscribe.length, 0);
});

test('matching acknowledgement enables guarded events only with transport-unverified provenance', async () => {
  const f = fixture(); await f.receiving();
  const frame = f.notification();
  await f.emit(frame);
  assert.equal(f.events.length, 1);
  assert.deepEqual(f.events[0], {
    id: frame.payload.event.message_id, userId: '300', text: '!vote a',
    timestamp: BASE_TIME, timestampRaw: frame.metadata.message_timestamp,
    deliveryId: frame.metadata.message_id, origin: 'transport-unverified',
  });
  assertUnverified(f.session.getState());
  await f.session.stop();
});

test('notifications before acknowledgement are not buffered and emitted later', async () => {
  const pendingAck = deferred();
  const f = fixture({ overrides: { subscribe: () => pendingAck.promise } });
  await f.start();
  const welcomeTask = f.emit(f.welcome()); await flush();
  assert.equal(f.session.getState().phase, 'subscribing');
  await f.emit(f.notification());
  assert.equal(f.events.length, 0);
  pendingAck.resolve(f.acknowledgement()); await welcomeTask;
  assert.equal(f.session.getState().phase, 'receiving');
  assert.equal(f.events.length, 0);
  await f.session.stop();
});

test('non-202, mismatched subscription and credential-bearing acknowledgement close intake', async () => {
  for (const change of [
    (r) => { r.httpStatus = 401; },
    (r) => { r.body.data[0].condition.broadcaster_user_id = '999'; },
    (r) => { r.body.data[0].transport.session_id = 'other-session'; },
    (r) => { r.body.data[0].status = 'authorization_revoked'; },
    (r) => { r.extra = { access_token: PRIVATE_SENTINEL }; },
  ]) {
    let f;
    f = fixture({ overrides: { subscribe: () => { const receipt = f.acknowledgement(); change(receipt); return receipt; } } });
    await f.start(); const result = await f.emit(f.welcome());
    assert.notEqual(f.session.getState().phase, 'receiving');
    assert.equal(f.calls.close, 1);
    assert.equal(f.clock.pending(), 0);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_ERROR_DO_NOT_PUBLISH/);
    await f.emit(f.notification());
    assert.equal(f.events.length, 0);
    assertUnverified(f.session.getState());
  }
});

test('subscription adapter exception is sanitized and closes the socket', async () => {
  const f = fixture({ overrides: { subscribe: () => { throw new Error(PRIVATE_SENTINEL); } } });
  await f.start();
  const result = await f.emit(f.welcome());
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_ERROR_DO_NOT_PUBLISH/);
  assert.notEqual(f.session.getState().phase, 'receiving');
  assert.equal(f.calls.close, 1);
  assert.equal(f.clock.pending(), 0);
});

test('delayed acknowledgement cannot extend the original welcome liveness deadline', async () => {
  const pendingAck = deferred();
  const f = fixture({ overrides: { subscribe: () => pendingAck.promise } });
  await f.start();
  const welcomeTask = f.emit(f.welcome()); await flush();
  await f.clock.advance(5_000);
  pendingAck.resolve(f.acknowledgement()); await welcomeTask;
  assert.equal(f.session.getState().phase, 'receiving');
  assert.equal(f.session.getState().keepaliveDeadline, BASE_TIME + 10_000);
  await f.clock.advance(5_000);
  assert.equal(f.session.getState().phase, 'receiving');
  await f.clock.advance(1);
  assert.equal(f.session.getState().phase, 'timed_out');
  assert.equal(f.calls.close, 1);
});

test('valid pending keepalive updates receive-clock liveness without buffering chat', async () => {
  const pendingAck = deferred();
  const f = fixture({ overrides: { subscribe: () => pendingAck.promise } });
  await f.start();
  const welcomeTask = f.emit(f.welcome()); await flush();
  await f.clock.advance(4_000); await f.emit(f.keepalive());
  await f.clock.advance(1_000);
  pendingAck.resolve(f.acknowledgement()); await welcomeTask;
  assert.equal(f.session.getState().keepaliveDeadline, BASE_TIME + 14_000);
  assert.equal(f.events.length, 0);
  await f.session.stop();
});

test('late subscription acknowledgement after the exact local deadline cannot revive a run', async () => {
  const pendingAck = deferred();
  const f = fixture({ overrides: { subscribe: () => pendingAck.promise } });
  await f.start();
  const welcomeTask = f.emit(f.welcome()); await flush();
  await f.clock.advance(10_000);
  assert.notEqual(f.session.getState().phase, 'receiving');
  pendingAck.resolve(f.acknowledgement()); await welcomeTask;
  assert.notEqual(f.session.getState().phase, 'receiving');
  assert.equal(f.calls.close, 1);
  assert.equal(f.clock.pending(), 0);
  assert.equal(f.events.length, 0);
});

test('delivery and chat replays are suppressed and invalid-channel frames never reach callbacks', async () => {
  const f = fixture(); await f.receiving();
  const original = f.notification(); await f.emit(original); await f.emit(original);
  const redelivery = f.notification(); redelivery.payload.event.message_id = original.payload.event.message_id;
  await f.emit(redelivery);
  const wrongChannel = f.notification(); wrongChannel.payload.event.broadcaster_user_id = '999';
  await f.emit(wrongChannel); await f.emit('{malformed');
  assert.equal(f.events.length, 1);
  assert.equal(f.session.getState().phase, 'receiving');
  assertUnverified(f.session.getState());
  await f.session.stop();
});

test('keepalive refreshes the guard watchdog while malformed replay cannot refresh it', async () => {
  const f = fixture(); await f.receiving();
  const original = f.notification(); await f.emit(original);
  await f.clock.advance(5_000); await f.emit(f.keepalive());
  assert.equal(f.session.getState().keepaliveDeadline, BASE_TIME + 15_000);
  await f.clock.advance(5_000);
  const malformed = structuredClone(original); malformed.payload.subscription.condition.user_id = '999';
  await f.emit(malformed);
  assert.equal(f.session.getState().keepaliveDeadline, BASE_TIME + 15_000);
  await f.clock.advance(5_001);
  assert.equal(f.session.getState().phase, 'timed_out');
  assert.equal(f.calls.close, 1);
});

test('matching revocation and reconnect freeze intake and close the owned socket', async () => {
  for (const frameType of ['revocation', 'reconnect']) {
    const f = fixture(); await f.receiving();
    await f.emit(f[frameType]());
    assert.equal(f.session.getState().phase, frameType === 'revocation' ? 'revoked' : 'reconnect_required');
    assert.equal(f.calls.close, 1);
    assert.equal(f.clock.pending(), 0);
    await f.emit(f.notification());
    assert.equal(f.events.length, 0);
    assertUnverified(f.session.getState());
  }
});

test('disconnect and transport-error callbacks fail closed without publishing private error text', async () => {
  for (const callback of ['onDisconnect', 'onError']) {
    const f = fixture(); await f.receiving();
    const result = await f.socket()[callback](new Error(PRIVATE_SENTINEL));
    assert.notEqual(f.session.getState().phase, 'receiving');
    assert.equal(f.calls.close, 1);
    assert.equal(f.clock.pending(), 0);
    assert.doesNotMatch(JSON.stringify({ result, state: f.session.getState() }), /SYNTHETIC_PRIVATE_ERROR_DO_NOT_PUBLISH/);
    assertUnverified(f.session.getState());
  }
});

test('a throwing event callback is sanitized and stops further event delivery', async () => {
  const f = fixture({ onEvent: () => { throw new Error(PRIVATE_SENTINEL); } });
  await f.receiving();
  const result = await f.emit(f.notification());
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_ERROR_DO_NOT_PUBLISH/);
  assert.notEqual(f.session.getState().phase, 'receiving');
  assert.equal(f.calls.close, 1);
  assert.equal(f.clock.pending(), 0);
});

test('stop clears timers/socket and makes all captured callbacks unable to revive the run', async () => {
  const f = fixture(); await f.receiving();
  const oldSocket = f.socket();
  const result = await f.session.stop(PRIVATE_SENTINEL);
  assert.equal(f.session.getState().phase, 'stopped');
  assert.equal(f.calls.close, 1);
  assert.equal(f.clock.pending(), 0);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_PRIVATE_ERROR_DO_NOT_PUBLISH/);
  await oldSocket.onFrame(JSON.stringify(f.notification()));
  await oldSocket.onError(new Error(PRIVATE_SENTINEL));
  await oldSocket.onDisconnect(PRIVATE_SENTINEL);
  assert.equal(f.events.length, 0);
  assert.equal(f.session.getState().phase, 'stopped');
  assert.equal(f.calls.close, 1);
});

test('late validation and late socket handles after stop are discarded and closed privately', async () => {
  const pendingValidation = deferred();
  const f = fixture({ overrides: { validate: () => pendingValidation.promise } });
  const startTask = f.start(); await flush(); await f.session.stop();
  pendingValidation.resolve(f.validation()); await startTask;
  assert.equal(f.calls.connect.length, 0);
  assert.equal(f.session.getState().phase, 'stopped');
  const pendingConnect = deferred();
  const g = fixture({ overrides: { connect: () => pendingConnect.promise } });
  const connectTask = g.start(); await flush(); await g.session.stop();
  pendingConnect.resolve(g.calls.connect[0].handle); await connectTask; await flush();
  assert.equal(g.session.getState().phase, 'stopped');
  assert.equal(g.calls.close, 1);
  assert.equal(g.clock.pending(), 0);
});

test('a late acknowledgement after stop cannot establish an inbox', async () => {
  const pendingAck = deferred();
  const f = fixture({ overrides: { subscribe: () => pendingAck.promise } });
  await f.start();
  const welcomeTask = f.emit(f.welcome()); await flush(); await f.session.stop();
  pendingAck.resolve(f.acknowledgement()); await welcomeTask;
  assert.equal(f.session.getState().phase, 'stopped');
  assert.equal(f.events.length, 0);
  assert.equal(f.clock.pending(), 0);
  assert.equal(f.calls.close, 1);
});

test('active duplicate start cannot create another socket and old callbacks cannot affect a fresh run', async () => {
  const f = fixture(); await f.receiving();
  assert.equal((await f.start()).code, 'already_started');
  assert.equal(f.calls.validate.length, 1);
  assert.equal(f.calls.connect.length, 1);
  const oldSocket = f.socket();
  await f.session.stop(); await f.start();
  await f.emit(f.welcome('fresh-synthetic-session'));
  assert.equal(f.session.getState().phase, 'receiving');
  await oldSocket.onError(new Error(PRIVATE_SENTINEL));
  await oldSocket.onFrame(JSON.stringify(f.notification()));
  assert.equal(f.session.getState().phase, 'receiving');
  assert.equal(f.events.length, 0);
  assert.equal(f.calls.close, 1);
  await f.session.stop();
});

test('periodic validation is injected and a failed refresh removes the prior receiving state', async () => {
  const f = fixture({
    config: { validationIntervalMs: 1_000 },
    overrides: { validate: (_, count) => count === 1 ? f.validation() : { httpStatus: 401, body: {} } },
  });
  await f.receiving(); await f.clock.advance(1_000);
  assert.equal(f.calls.validate.length, 2);
  assert.notEqual(f.session.getState().phase, 'receiving');
  assert.equal(f.calls.close, 1);
  assert.equal(f.clock.pending(), 0);
  assertUnverified(f.session.getState());
});

test('successful refresh keeps the same subscription and does not resubscribe', async () => {
  const f = fixture({ config: { validationIntervalMs: 1_000 } });
  await f.receiving(); await f.clock.advance(1_000);
  assert.equal(f.calls.validate.length, 2);
  assert.equal(f.calls.subscribe.length, 1);
  assert.equal(f.calls.connect.length, 1);
  assert.equal(f.session.getState().phase, 'receiving');
  await f.session.stop();
});

test('coordinated synthetic events still cannot vote or publish a source cue in the existing board', async () => {
  const board = createBoard({ now: () => BASE_TIME }); board.setConnection('connected'); board.openVote();
  const rejections = [];
  const f = fixture({ onEvent: (event) => { rejections.push(board.processEvent(event).code); } });
  await f.receiving(); await f.emit(f.notification('!vote a')); await f.emit(f.notification('!source'));
  assert.deepEqual(rejections, ['unsupported_origin', 'unsupported_origin']);
  assert.equal(board.getState().vote.total, 0);
  assert.equal(board.getState().sourceCue.active, false);
  assert.equal(board.getState().realTwitchConnected, false);
  assertUnverified(f.session.getState());
  await f.session.stop();
});

test('public snapshots are frozen aggregates and contain no credential, channel, session or raw chat data', async () => {
  const f = fixture(); await f.receiving(); await f.emit(f.notification('synthetic-private-chat-text'));
  const snapshot = f.session.getState();
  assertUnverified(snapshot);
  assert.doesNotMatch(JSON.stringify(snapshot), /synthetic-private-chat-text|"userId":|"chatter_user_id":|"user_id":|httpStatus|https?:\/\//);
  assert.throws(() => { snapshot.phase = 'receiving'; }, TypeError);
  assert.throws(() => { snapshot.metrics.emittedEvents = 900; }, TypeError);
  await f.session.stop();
  assert.equal(snapshot.phase, 'receiving');
  assert.equal(f.session.getState().phase, 'stopped');
});

test('stopping a hanging validation aborts its signal and settles start before the adapter resolves', async () => {
  const pending = deferred();
  const f = fixture({ overrides: { validate: () => pending.promise } });
  let settled = false;
  const task = f.start().then((result) => { settled = true; return result; });
  await flush();
  const signal = f.calls.validate[0].signal;
  assert.ok(signal instanceof AbortSignal);
  assert.equal(signal.aborted, false);
  await f.session.stop(); await flush();
  const settledBeforeAdapter = settled;
  pending.resolve(f.validation()); await task;
  assert.equal(settledBeforeAdapter, true);
  assert.equal(signal.aborted, true);
  assert.equal(f.calls.connect.length, 0);
  assert.equal(f.clock.pending(), 0);
});

test('hanging validation and connect adapters terminate at the injected I/O timeout', async () => {
  for (const adapter of ['validate', 'connect']) {
    const pending = deferred();
    const f = fixture({ config: { ioTimeoutMs: 1_000 }, overrides: { [adapter]: () => pending.promise } });
    const task = f.start(); await flush();
    await f.clock.advance(1_000);
    const result = await task;
    assert.equal(result.code, adapter === 'validate' ? 'validation_timeout' : 'transport_timeout');
    assert.equal(f.session.getState().phase, 'timed_out');
    const parameters = adapter === 'validate' ? f.calls.validate[0] : f.calls.connect[0].callbacks;
    assert.equal(parameters.signal.aborted, true);
    assert.equal(f.clock.pending(), 0);
    pending.resolve(adapter === 'validate' ? f.validation() : f.calls.connect[0].handle);
    await flush();
    assert.equal(f.calls.close, adapter === 'connect' ? 1 : 0);
    assert.equal(f.session.getState().phase, 'timed_out');
  }
});

test('hanging subscription aborts at its I/O timeout and late acknowledgement cannot revive intake', async () => {
  const pending = deferred();
  const f = fixture({ config: { ioTimeoutMs: 1_000 }, overrides: { subscribe: () => pending.promise } });
  await f.start();
  const task = f.emit(f.welcome()); await flush();
  await f.clock.advance(1_000);
  const result = await task;
  assert.equal(result.code, 'subscription_timeout');
  assert.equal(f.calls.subscribe[0].signal.aborted, true);
  assert.equal(f.session.getState().phase, 'timed_out');
  assert.equal(f.calls.close, 1);
  assert.equal(f.clock.pending(), 0);
  pending.resolve(f.acknowledgement()); await flush();
  assert.equal(f.session.getState().phase, 'timed_out');
  assert.equal(f.events.length, 0);
});

test('a cancelled but already queued old timer cannot remove ownership of the new run timer', async () => {
  const f = fixture(); await f.start();
  const deadline = f.session.getState().welcomeDeadline;
  const queuedOldCallback = f.clock.scheduled().find((timer) => timer.deadline === deadline).callback;
  await f.session.stop(); await f.start();
  assert.equal(f.session.getState().phase, 'awaiting_welcome');
  await queuedOldCallback(); await flush();
  assert.equal(f.session.getState().phase, 'awaiting_welcome');
  await f.session.stop();
  assert.equal(f.clock.pending(), 0);
});
