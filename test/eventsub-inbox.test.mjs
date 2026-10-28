import test from 'node:test';
import assert from 'node:assert/strict';
import { createEventSubInbox } from '../src/eventsub-inbox.mjs';
import { createBoard } from '../src/engine.mjs';

// Every envelope and identity below is synthetic protocol input. No WebSocket,
// OAuth account, real Twitch delivery, or observed viewer is used by this suite.
const BASE_TIME = Date.parse('2026-10-25T08:00:00.123Z');
const PIN = { broadcasterId: '100', readerId: '200', subscriptionId: 'synthetic-sub-01' };
const SESSION = 'synthetic-session-01';

function fixture(options = {}) {
  let time = BASE_TIME;
  let sequence = 0;
  const inbox = createEventSubInbox({ ...PIN, now: () => time, ...options });
  const timestamp = () => new Date(time).toISOString();
  function metadata(type, subscription = false) {
    return {
      message_id: `synthetic-delivery-${++sequence}`, message_type: type,
      message_timestamp: timestamp(),
      ...(subscription ? { subscription_type: 'channel.chat.message', subscription_version: '1' } : {}),
    };
  }
  function subscription(status = 'enabled') {
    return {
      id: PIN.subscriptionId, type: 'channel.chat.message', version: '1', status,
      condition: { broadcaster_user_id: PIN.broadcasterId, user_id: PIN.readerId },
      transport: { method: 'websocket', session_id: SESSION },
    };
  }
  function welcome() {
    return {
      metadata: metadata('session_welcome'),
      payload: { session: { id: SESSION, status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null } },
    };
  }
  function notification(text = '!vote a') {
    const meta = metadata('notification', true);
    return {
      metadata: meta,
      payload: {
        subscription: subscription(),
        event: {
          broadcaster_user_id: PIN.broadcasterId, chatter_user_id: '300',
          message_id: `synthetic-chat-${sequence}`, message: { text, fragments: [] },
        },
      },
    };
  }
  function keepalive() { return { metadata: metadata('session_keepalive'), payload: {} }; }
  function revocation() {
    return { metadata: metadata('revocation', true), payload: { subscription: subscription('authorization_revoked') } };
  }
  function reconnect(url = 'wss://eventsub.wss.twitch.tv/ws?reconnect=synthetic') {
    return {
      metadata: metadata('session_reconnect'),
      payload: { session: { id: SESSION, status: 'reconnecting', keepalive_timeout_seconds: null, reconnect_url: url } },
    };
  }
  function receive(frame) { return inbox.receive(JSON.stringify(frame)); }
  function ready() { const result = receive(welcome()); assert.equal(result.code, 'welcome'); return result; }
  return {
    inbox, receive, ready, welcome, notification, keepalive, revocation, reconnect,
    advance: (milliseconds) => { time += milliseconds; },
  };
}

function assertRejected(result) {
  assert.equal(result.ok, false);
  assert.equal(result.event, undefined);
}

test('initial and ready snapshots remain labelled offline protocol rehearsal', () => {
  const f = fixture();
  assert.equal(f.inbox.getState().phase, 'awaiting_welcome');
  assert.equal(f.inbox.getState().keepaliveDeadline, null);
  f.ready();
  const state = f.inbox.getState();
  assert.equal(state.phase, 'ready');
  assert.equal(state.mode, 'protocol-rehearsal');
  assert.equal(state.networkConnected, false);
  assert.equal(state.keepaliveDeadline, BASE_TIME + 10_000);
});

test('notifications and keepalives before welcome cannot initialize an authenticated-looking session', () => {
  const f = fixture();
  assertRejected(f.receive(f.notification()));
  assertRejected(f.receive(f.keepalive()));
  assert.equal(f.inbox.getState().phase, 'awaiting_welcome');
  f.ready();
});

test('a valid synthetic notification maps chat identity rather than delivery identity', () => {
  const f = fixture();
  f.ready();
  const frame = f.notification();
  const result = f.receive(frame);
  assert.equal(result.ok, true);
  assert.equal(result.code, 'chat_message');
  assert.deepEqual(result.event, {
    id: frame.payload.event.message_id, deliveryId: frame.metadata.message_id,
    userId: '300', text: '!vote a', timestamp: BASE_TIME,
    timestampRaw: frame.metadata.message_timestamp, origin: 'eventsub-unverified',
  });
  assert.notEqual(result.event.id, result.event.deliveryId);
});

test('normalized protocol rehearsal events cannot enter the simulation vote engine', () => {
  const f = fixture();
  f.ready();
  const result = f.receive(f.notification());
  const board = createBoard({ now: () => BASE_TIME });
  board.setConnection('connected');
  board.openVote();
  assert.equal(board.processEvent(result.event).code, 'unsupported_origin');
  assert.equal(board.getState().vote.total, 0);
  assert.equal(board.getState().realTwitchConnected, false);
});

test('malformed JSON, nonobjects, nonstrings, absent metadata and oversized frames are rejected', () => {
  const f = fixture();
  for (const raw of ['{broken', 'null', '[]', '"text"', '{}', '0', '', null, undefined, {}, Buffer.from('{}')]) {
    assertRejected(f.inbox.receive(raw));
  }
  const tiny = fixture({ maxFrameBytes: 200 });
  assertRejected(tiny.inbox.receive(JSON.stringify({ filler: 'x'.repeat(201) })));
  assertRejected(tiny.inbox.receive(JSON.stringify({ filler: '月'.repeat(100) })));
  assert.equal(f.inbox.getState().phase, 'awaiting_welcome');
});

test('welcome requires a session identity, connected status and positive bounded keepalive', () => {
  for (const change of [
    (x) => { delete x.payload.session.id; },
    (x) => { x.payload.session.status = 'reconnecting'; },
    (x) => { x.payload.session.keepalive_timeout_seconds = 0; },
    (x) => { x.payload.session.keepalive_timeout_seconds = -1; },
    (x) => { x.payload.session.keepalive_timeout_seconds = '10'; },
    (x) => { x.payload.session.keepalive_timeout_seconds = 10.5; },
  ]) {
    const f = fixture();
    const frame = f.welcome();
    change(frame);
    assertRejected(f.receive(frame));
    assert.equal(f.inbox.getState().phase, 'awaiting_welcome');
  }
});

test('a second welcome cannot replace an already ready session', () => {
  const f = fixture();
  f.ready();
  const frame = f.welcome();
  frame.payload.session.id = 'different-synthetic-session';
  assertRejected(f.receive(frame));
  assert.equal(f.inbox.getState().phase, 'ready');
});

test('metadata must identify the pinned notification type/version and have a delivery ID', () => {
  for (const change of [
    (x) => { delete x.metadata.message_id; },
    (x) => { x.metadata.message_id = ''; },
    (x) => { x.metadata.subscription_type = 'channel.follow'; },
    (x) => { x.metadata.subscription_version = '2'; },
    (x) => { delete x.metadata.subscription_type; },
    (x) => { x.metadata.message_timestamp = 'not-a-timestamp'; },
  ]) {
    const f = fixture(); f.ready();
    const frame = f.notification(); change(frame);
    assertRejected(f.receive(frame));
    assert.equal(f.inbox.getState().metrics.acceptedChats, 0);
  }
});

test('subscription ID/type/version/status, conditions and transport must match pinned session', () => {
  for (const change of [
    (s) => { s.id = 'another-subscription'; },
    (s) => { s.type = 'channel.follow'; },
    (s) => { s.version = '2'; },
    (s) => { s.status = 'authorization_revoked'; },
    (s) => { s.condition.broadcaster_user_id = '999'; },
    (s) => { s.condition.user_id = '999'; },
    (s) => { delete s.condition.user_id; },
    (s) => { s.condition.unexpected_condition = 'extra'; },
    (s) => { s.transport.method = 'webhook'; },
    (s) => { s.transport.session_id = 'different-synthetic-session'; },
    (s) => { delete s.transport; },
  ]) {
    const f = fixture(); f.ready();
    const frame = f.notification(); change(frame.payload.subscription);
    assertRejected(f.receive(frame));
    assert.equal(f.inbox.getState().phase, 'ready');
    assert.equal(f.inbox.getState().metrics.acceptedChats, 0);
  }
});

test('notification requires the target broadcaster, numeric chatter identity and chat message ID', () => {
  for (const change of [
    (e) => { e.broadcaster_user_id = '999'; },
    (e) => { delete e.broadcaster_user_id; },
    (e) => { e.chatter_user_id = 'display-name'; },
    (e) => { e.chatter_user_id = 300; },
    (e) => { e.chatter_user_id = '0'; },
    (e) => { delete e.chatter_user_id; },
    (e) => { delete e.message_id; },
    (e) => { e.message_id = ''; },
  ]) {
    const f = fixture(); f.ready();
    const frame = f.notification(); change(frame.payload.event);
    assertRejected(f.receive(frame));
  }
});

test('cross-channel Shared Chat is rejected under the conservative local policy', () => {
  const f = fixture(); f.ready();
  const frame = f.notification();
  frame.payload.event.source_broadcaster_user_id = '999';
  assertRejected(f.receive(frame));
  assert.equal(f.inbox.getState().metrics.acceptedChats, 0);
});

test('a local-source or null-source Shared Chat field does not change the target channel', () => {
  for (const source of [PIN.broadcasterId, null]) {
    const f = fixture(); f.ready();
    const frame = f.notification();
    frame.payload.event.source_broadcaster_user_id = source;
    assert.equal(f.receive(frame).code, 'chat_message');
  }
});

test('the local board text boundary accepts 300 characters and rejects longer/nontext content', () => {
  const f = fixture(); f.ready();
  assert.equal(f.receive(f.notification('x'.repeat(300))).code, 'chat_message');
  for (const value of ['x'.repeat(301), null, {}, 123]) {
    assertRejected(f.receive(f.notification(value)));
  }
});

test('RFC3339 nanosecond precision is preserved as an explicit millisecond normalization', () => {
  const f = fixture(); f.ready();
  const frame = f.notification();
  frame.metadata.message_timestamp = '2026-10-25T08:00:00.123456789Z';
  const result = f.receive(frame);
  assert.equal(result.code, 'chat_message');
  assert.equal(result.event.timestamp, BASE_TIME);
  assert.equal(result.event.timestampRaw, frame.metadata.message_timestamp);
});

test('RFC3339 timezone offsets normalize to the same instant', () => {
  const f = fixture(); f.ready();
  const frame = f.notification();
  frame.metadata.message_timestamp = '2026-10-25T16:00:00.123+08:00';
  const result = f.receive(frame);
  assert.equal(result.code, 'chat_message');
  assert.equal(result.event.timestamp, BASE_TIME);
});

test('invalid calendar dates and non-RFC3339 timestamp shapes are rejected', () => {
  for (const timestamp of ['2026-02-30T08:00:00.123Z', '2026-10-25', '2026-10-25 08:00:00Z', '2026-10-25T08:00:00.1234567890Z', '2026-10-25T08:00:00+99:00']) {
    const f = fixture(); f.ready();
    const frame = f.notification(); frame.metadata.message_timestamp = timestamp;
    const result = f.receive(frame);
    assertRejected(result);
    assert.equal(result.code, 'invalid_metadata');
  }
});

test('message-age and future clock-skew boundaries are enforced', () => {
  const f = fixture({ maxMessageAgeMs: 1_000 }); f.ready();
  const boundary = f.notification();
  boundary.metadata.message_timestamp = new Date(BASE_TIME - 1_000).toISOString();
  assert.equal(f.receive(boundary).code, 'chat_message');
  const stale = f.notification();
  stale.metadata.message_timestamp = new Date(BASE_TIME - 1_001).toISOString();
  assert.equal(f.receive(stale).code, 'stale_message');
  const allowedSkew = f.notification();
  allowedSkew.metadata.message_timestamp = new Date(BASE_TIME + 5_000).toISOString();
  assert.equal(f.receive(allowedSkew).code, 'chat_message');
  const future = f.notification();
  future.metadata.message_timestamp = new Date(BASE_TIME + 5_001).toISOString();
  assert.equal(f.receive(future).code, 'future_message');
});

test('nanosecond timestamp boundaries are checked before millisecond normalization', () => {
  const f = fixture({ maxMessageAgeMs: 1_000 }); f.ready();
  const future = f.notification();
  future.metadata.message_timestamp = '2026-10-25T08:00:05.123000001Z';
  assert.equal(f.receive(future).code, 'future_message');
  const stale = f.notification();
  stale.metadata.message_timestamp = '2026-10-25T07:59:59.122999999Z';
  assert.equal(f.receive(stale).code, 'stale_message');
});

test('delivery-ID duplicates and same-chat-ID redeliveries each produce no second chat event', () => {
  const f = fixture(); f.ready();
  const original = f.notification();
  assert.equal(f.receive(original).code, 'chat_message');
  const alteredDelivery = structuredClone(original);
  alteredDelivery.payload.event.chatter_user_id = '301';
  alteredDelivery.payload.event.message.text = '!vote b';
  const deliveryReplay = f.receive(alteredDelivery);
  assert.equal(deliveryReplay.code, 'duplicate_delivery');
  assert.equal(deliveryReplay.event, undefined);
  const newDelivery = f.notification();
  newDelivery.payload.event.message_id = original.payload.event.message_id;
  const chatReplay = f.receive(newDelivery);
  assert.equal(chatReplay.code, 'duplicate_chat_message');
  assert.equal(chatReplay.event, undefined);
  assert.equal(f.inbox.getState().metrics.acceptedChats, 1);
  assert.equal(f.inbox.getState().metrics.duplicateDeliveries, 1);
  assert.equal(f.inbox.getState().metrics.duplicateChats, 1);
});

test('valid duplicate delivery refreshes liveness using receive time rather than its old timestamp', () => {
  const f = fixture(); f.ready();
  const original = f.notification();
  f.receive(original);
  f.advance(5_000);
  assert.equal(f.receive(original).code, 'duplicate_delivery');
  assert.equal(f.inbox.getState().keepaliveDeadline, BASE_TIME + 15_000);
  f.advance(5_001);
  assert.equal(f.inbox.getState().phase, 'ready');
});

test('valid same-chat redelivery refreshes liveness without emitting another normalized event', () => {
  const f = fixture(); f.ready();
  const original = f.notification(); f.receive(original);
  f.advance(5_000);
  const replay = f.notification(); replay.payload.event.message_id = original.payload.event.message_id;
  assert.equal(f.receive(replay).code, 'duplicate_chat_message');
  assert.equal(f.inbox.getState().keepaliveDeadline, BASE_TIME + 15_000);
  assert.equal(f.inbox.getState().metrics.acceptedChats, 1);
});

test('a malformed replay with a valid delivery ID cannot refresh liveness', () => {
  const f = fixture(); f.ready();
  const original = f.notification(); f.receive(original);
  f.advance(5_000);
  original.payload.subscription.condition.user_id = '999';
  assertRejected(f.receive(original));
  assert.equal(f.inbox.getState().keepaliveDeadline, BASE_TIME + 10_000);
  f.advance(5_001);
  assert.equal(f.inbox.getState().phase, 'timed_out');
});

test('watchdog keeps the exact deadline valid and becomes terminal strictly after it', () => {
  const f = fixture(); f.ready();
  f.advance(10_000);
  assert.equal(f.inbox.getState().phase, 'ready');
  f.advance(1);
  assert.equal(f.inbox.getState().phase, 'timed_out');
  assert.equal(f.receive(f.keepalive()).code, 'timed_out');
  assert.equal(f.receive(f.welcome()).code, 'timed_out');
  assertRejected(f.receive(f.notification()));
});

test('valid keepalive refreshes deadline and is counted without a chat event', () => {
  const f = fixture(); f.ready(); f.advance(9_000);
  const result = f.receive(f.keepalive());
  assert.equal(result.code, 'keepalive');
  assert.equal(result.event, undefined);
  assert.equal(f.inbox.getState().keepaliveDeadline, BASE_TIME + 19_000);
  assert.equal(f.inbox.getState().metrics.keepalives, 1);
});

test('unknown message types and invalid keepalive payloads do not extend the watchdog', () => {
  const f = fixture(); f.ready(); f.advance(5_000);
  const unknown = f.keepalive(); unknown.metadata.message_type = 'unsupported_type';
  assertRejected(f.receive(unknown));
  const malformed = f.keepalive(); malformed.payload = [];
  assertRejected(f.receive(malformed));
  assert.equal(f.inbox.getState().keepaliveDeadline, BASE_TIME + 10_000);
});

test('dedupe capacity evicts old delivery and chat identities without pretending unlimited replay retention', () => {
  const f = fixture({ maxDeliveryIds: 2 }); f.ready();
  const original = f.notification(); f.receive(original);
  f.receive(f.notification()); f.receive(f.notification());
  assert.equal(f.receive(original).code, 'chat_message');
});

test('dedupe TTL expires at its boundary while the session remains active', () => {
  const f = fixture({ deliveryTtlMs: 1_000 }); f.ready();
  const original = f.notification(); f.receive(original);
  f.advance(999);
  assert.equal(f.receive(original).code, 'duplicate_delivery');
  f.advance(1);
  assert.equal(f.receive(original).code, 'chat_message');
});

test('a matching revocation freezes intake and cannot be revived by another welcome', () => {
  const f = fixture(); f.ready();
  assert.equal(f.receive(f.revocation()).code, 'revoked');
  assert.equal(f.inbox.getState().phase, 'revoked');
  assertRejected(f.receive(f.notification()));
  assertRejected(f.receive(f.welcome()));
  assert.equal(f.inbox.getState().phase, 'revoked');
});

test('unrelated or enabled-subscription revocation cannot freeze the current session', () => {
  for (const change of [
    (s) => { s.id = 'unrelated-subscription'; },
    (s) => { s.status = 'enabled'; },
    (s) => { s.condition.broadcaster_user_id = '999'; },
    (s) => { s.transport.session_id = 'unrelated-session'; },
  ]) {
    const f = fixture(); f.ready();
    const frame = f.revocation(); change(frame.payload.subscription);
    assertRejected(f.receive(frame));
    assert.equal(f.inbox.getState().phase, 'ready');
    assert.equal(f.receive(f.notification()).code, 'chat_message');
  }
});

test('official reconnect URL yields an action without opening a network connection or handing over the session', () => {
  const f = fixture(); f.ready();
  const result = f.receive(f.reconnect());
  assert.equal(result.code, 'reconnect_requested');
  assert.equal(f.inbox.getState().phase, 'reconnect_requested');
  assert.equal(f.inbox.getState().networkConnected, false);
  assert.ok(result.action);
  assert.match(JSON.stringify(result.action), /wss:\/\/eventsub\.wss\.twitch\.tv/);
  assertRejected(f.receive(f.notification()));
  assertRejected(f.receive(f.welcome()));
});

test('reconnect URL lookalikes, unsafe schemes, credentials, fragments and nondefault ports are rejected', () => {
  for (const url of [
    'ws://eventsub.wss.twitch.tv/ws', 'https://eventsub.wss.twitch.tv/ws',
    'wss://eventsub.wss.twitch.tv.attacker.example/ws', 'wss://attacker.example/ws',
    'wss://attacker@eventsub.wss.twitch.tv/ws', 'wss://eventsub.wss.twitch.tv:444/ws',
    'wss://eventsub.wss.twitch.tv/ws#fragment', 'wss://eventsub.wss.twitch.tv/ws#',
    'file:///tmp/socket', 'not-a-url',
  ]) {
    const f = fixture(); f.ready();
    const result = f.receive(f.reconnect(url));
    assertRejected(result);
    assert.equal(result.action, undefined);
    assert.equal(f.inbox.getState().phase, 'ready');
  }
});

test('close is terminal and public state omits private raw chat, viewer and session identities', () => {
  const f = fixture(); f.ready();
  const frame = f.notification('private synthetic raw chat text');
  frame.payload.event.chatter_user_id = '9876543210123';
  f.receive(frame);
  const publicJson = JSON.stringify(f.inbox.getState());
  assert.doesNotMatch(publicJson, /private synthetic raw chat text|9876543210123|synthetic-session-01|synthetic-chat-/);
  f.inbox.close();
  assert.equal(f.inbox.getState().phase, 'closed');
  assert.equal(f.receive(f.welcome()).code, 'closed');
  assertRejected(f.receive(f.notification()));
  assert.equal(f.inbox.getState().networkConnected, false);
});

test('constructor rejects invalid pinned identities, clocks and resource limits', () => {
  for (const change of [
    { broadcasterId: 'display-name' }, { readerId: '0' }, { readerId: 200 },
    { subscriptionId: '' }, { subscriptionId: '../secret' },
    { maxFrameBytes: 0 }, { maxFrameBytes: 1_048_577 },
    { maxDeliveryIds: 0 }, { maxDeliveryIds: 100_001 },
    { deliveryTtlMs: 0 }, { maxMessageAgeMs: 0 },
    { now: () => NaN }, { now: () => -1 }, { now: () => 1.5 },
  ]) {
    assert.throws(() => createEventSubInbox({ ...PIN, ...change }));
  }
});
