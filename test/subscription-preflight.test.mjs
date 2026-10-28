import test from 'node:test';
import assert from 'node:assert/strict';
import { createSubscriptionPreflight } from '../src/subscription-preflight.mjs';
import { createBoard } from '../src/engine.mjs';

// Synthetic protocol receipts only. These fixtures are not OAuth responses,
// account authorization, a Twitch subscription, or evidence of network access.
const BASE_TIME = Date.parse('2026-10-25T08:00:00.000Z');
const CLIENT = 'synthetic-client-01';
const CHANNEL = '100';
const SESSION = 'synthetic-session-01';
const SECRET_SENTINEL = 'SYNTHETIC_ONLY_NOT_A_REAL_CREDENTIAL';

function assertOffline(state) {
  assert.equal(state.mode, 'offline-subscription-rehearsal');
  assert.equal(state.networkConnected, false);
  assert.equal(state.authorizationVerified, false);
  assert.doesNotMatch(JSON.stringify(state), /synthetic-client-01|synthetic-session-01|user:read:chat|client_id|broadcaster_user_id|SYNTHETIC_ONLY_NOT_A_REAL_CREDENTIAL|Bearer /);
}

function fixture(options = {}) {
  let time = BASE_TIME;
  const preflight = createSubscriptionPreflight({
    clientId: CLIENT, broadcasterId: CHANNEL, readerId: CHANNEL,
    now: () => time, ...options,
  });
  const validation = () => ({
    provenance: 'synthetic', httpStatus: 200,
    body: { client_id: CLIENT, user_id: CHANNEL, scopes: ['user:read:chat'], expires_in: 7_200 },
  });
  const acknowledgement = (sessionId = SESSION) => ({
    provenance: 'synthetic', httpStatus: 202,
    body: {
      data: [{
        id: 'synthetic-subscription-01', type: 'channel.chat.message', version: '1', status: 'enabled',
        condition: { broadcaster_user_id: CHANNEL, user_id: CHANNEL },
        transport: { method: 'websocket', session_id: sessionId },
      }],
    },
  });
  const checked = (result) => { assertOffline(result.state); return result; };
  const acceptValidation = (receipt = validation()) => checked(preflight.acceptValidation(receipt));
  const plan = (input = { sessionId: SESSION, welcomeReceivedAt: BASE_TIME }) => checked(preflight.planSubscription(input));
  const acknowledge = (receipt = acknowledgement()) => checked(preflight.acceptAcknowledgement(receipt));
  function prepared() {
    assert.equal(acceptValidation().code, 'validation_checked');
    const result = plan();
    assert.equal(result.code, 'subscription_planned');
    return result;
  }
  return {
    preflight, validation, acknowledgement, acceptValidation, plan, acknowledge, prepared,
    advance: (milliseconds) => { time += milliseconds; },
    at: (milliseconds) => { time = milliseconds; },
  };
}

function assertRejected(result) {
  assert.equal(result.ok, false);
  assert.equal(result.request, undefined);
  assertOffline(result.state);
}

test('initial state and an attempted plan explicitly remain offline and unverified', () => {
  const f = fixture();
  const state = f.preflight.getState();
  assertOffline(state);
  assert.equal(state.phase, 'awaiting_validation');
  assert.equal(state.validatedAt, null);
  assert.equal(state.nextValidationAt, null);
  assert.equal(state.expiresAt, null);
  assert.equal(state.subscribeDeadline, null);
  assert.equal(f.plan().code, 'validation_required');
});

test('synthetic validation pins client and reader and records expiry and hourly refresh bounds', () => {
  const f = fixture();
  const result = f.acceptValidation();
  assert.equal(result.code, 'validation_checked');
  assert.equal(result.state.phase, 'validation_checked');
  assert.equal(result.state.validatedAt, BASE_TIME);
  assert.equal(result.state.expiresAt, BASE_TIME + 7_200_000);
  assert.equal(result.state.nextValidationAt, BASE_TIME + 3_600_000);
  assert.equal(result.state.subscribeDeadline, null);
});

test('request proposal has the exact read-chat condition and WebSocket session without headers or secrets', () => {
  const f = fixture();
  const result = f.prepared();
  assert.deepEqual(result.request, {
    method: 'POST', url: 'https://api.twitch.tv/helix/eventsub/subscriptions',
    body: {
      type: 'channel.chat.message', version: '1',
      condition: { broadcaster_user_id: CHANNEL, user_id: CHANNEL },
      transport: { method: 'websocket', session_id: SESSION },
    },
    requiresSecureAuthorization: true, provenance: 'synthetic',
  });
  assert.equal(Object.hasOwn(result.request, 'headers'), false);
  assert.doesNotMatch(JSON.stringify(result.request), /Bearer |access_token|refresh_token|client_secret|"Authorization":/);
  assert.equal(result.state.subscribeDeadline, BASE_TIME + 10_000);
});

test('a matching synthetic 202 acknowledgement changes phase without asserting real authorization', () => {
  const f = fixture(); f.prepared();
  const result = f.acknowledge();
  assert.equal(result.code, 'acknowledged');
  assert.equal(result.state.phase, 'acknowledged');
  assert.deepEqual(Object.keys(result).sort(), ['code', 'message', 'ok', 'state']);
  assertOffline(result.state);
});

test('acknowledgement alone cannot replace token validation or a planned session', () => {
  const f = fixture();
  assert.equal(f.acknowledge().code, 'ack_before_plan');
  assertRejected(f.plan());
  f.acceptValidation();
  assert.equal(f.acknowledge().code, 'ack_before_plan');
});

test('own-channel-only defaults reject a different reader and broadcaster', () => {
  assert.throws(() => createSubscriptionPreflight({ clientId: CLIENT, broadcasterId: '100', readerId: '200' }));
});

test('explicitly relaxed channel policy still pins the configured reader rather than the broadcaster', () => {
  const f = fixture({ readerId: '200', ownChannelOnly: false });
  const receipt = f.validation(); receipt.body.user_id = '200';
  assert.equal(f.acceptValidation(receipt).code, 'validation_checked');
  const result = f.plan();
  assert.equal(result.code, 'subscription_planned');
  assert.deepEqual(result.request.body.condition, { broadcaster_user_id: '100', user_id: '200' });
});

test('read scope is required; extra scopes cannot turn this API into a send-chat authorization', () => {
  const f = fixture();
  const missing = f.validation(); missing.body.scopes = ['user:write:chat'];
  assert.equal(f.acceptValidation(missing).code, 'missing_scope');
  const valid = f.validation(); valid.body.scopes = ['user:read:chat', 'user:write:chat'];
  assert.equal(f.acceptValidation(valid).code, 'validation_checked');
  const result = f.plan();
  assert.equal(result.request.body.type, 'channel.chat.message');
  assertOffline(result.state);
  assert.equal(Object.hasOwn(f.preflight, 'sendMessage'), false);
});

test('wrong client, reader, missing scope and 401 validation fail closed after acknowledgement', () => {
  for (const change of [
    (r) => { r.body.client_id = 'wrong-client'; },
    (r) => { r.body.user_id = '999'; },
    (r) => { r.body.scopes = []; },
    (r) => { r.httpStatus = 401; },
  ]) {
    const f = fixture(); f.prepared(); f.acknowledge();
    const receipt = f.validation(); change(receipt);
    assertRejected(f.acceptValidation(receipt));
    assert.notEqual(f.preflight.getState().phase, 'acknowledged');
    assertRejected(f.plan());
    assertRejected(f.acknowledge());
  }
});

test('receipt provenance is mandatory and unsupported provenance cannot retain a previous validation', () => {
  for (const provenance of [undefined, 'twitch', 'live', 'verified', 1]) {
    const f = fixture(); f.acceptValidation();
    const receipt = f.validation(); receipt.provenance = provenance;
    assertRejected(f.acceptValidation(receipt));
    assertRejected(f.plan());
  }
});

test('validation rejects malformed bodies and unsafe expires_in without retaining eligibility', () => {
  for (const change of [
    (r) => { r.body = null; }, (r) => { r.body = []; },
    (r) => { r.body.scopes = 'user:read:chat'; },
    (r) => { r.body.scopes = ['user:read:chat', 1]; },
    (r) => { r.body.expires_in = '3600'; },
    (r) => { r.body.expires_in = 0; }, (r) => { r.body.expires_in = -1; },
    (r) => { r.body.expires_in = 30.5; }, (r) => { r.body.expires_in = NaN; },
    (r) => { r.body.expires_in = Infinity; },
    (r) => { r.body.expires_in = Number.MAX_SAFE_INTEGER; },
    (r) => { delete r.body.client_id; }, (r) => { delete r.body.user_id; },
  ]) {
    const f = fixture(); f.acceptValidation();
    const receipt = f.validation(); change(receipt);
    assertRejected(f.acceptValidation(receipt));
    assertRejected(f.plan());
  }
});

test('token minimum lifetime admits exactly 30 seconds and refuses a shorter validation', () => {
  const f = fixture();
  const exact = f.validation(); exact.body.expires_in = 30;
  assert.equal(f.acceptValidation(exact).code, 'validation_checked');
  assert.equal(f.plan().code, 'subscription_planned');
  const short = f.validation(); short.body.expires_in = 29;
  assert.equal(f.acceptValidation(short).code, 'insufficient_lifetime');
  assertRejected(f.plan());
});

test('planning and acknowledgement each recheck remaining lifetime at their receive time', () => {
  const f = fixture();
  const receipt = f.validation(); receipt.body.expires_in = 30;
  f.acceptValidation(receipt); f.advance(1);
  assert.equal(f.plan().code, 'insufficient_lifetime');
  const g = fixture();
  const ackReceipt = g.validation(); ackReceipt.body.expires_in = 30;
  g.acceptValidation(ackReceipt); g.plan(); g.advance(1);
  assert.equal(g.acknowledge().code, 'insufficient_lifetime');
  assert.notEqual(g.preflight.getState().phase, 'acknowledged');
});

test('validation becomes required at the exact hourly refresh boundary', () => {
  const f = fixture(); f.prepared(); f.acknowledge();
  f.advance(3_599_999);
  assert.equal(f.preflight.getState().phase, 'acknowledged');
  f.advance(1);
  assert.equal(f.preflight.getState().phase, 'validation_required');
  assertRejected(f.plan({ sessionId: 'fresh-session', welcomeReceivedAt: BASE_TIME + 3_600_000 }));
});

test('token expiry invalidates an acknowledged state at its exact boundary', () => {
  const f = fixture();
  const receipt = f.validation(); receipt.body.expires_in = 60;
  f.acceptValidation(receipt); f.plan(); f.acknowledge();
  f.advance(59_999);
  assert.equal(f.preflight.getState().phase, 'acknowledged');
  f.advance(1);
  assert.equal(f.preflight.getState().phase, 'expired');
  assertRejected(f.plan({ sessionId: 'fresh-session', welcomeReceivedAt: BASE_TIME + 60_000 }));
});

test('successful acknowledgement is not invalidated merely by passing the subscribe deadline', () => {
  const f = fixture(); f.prepared(); f.acknowledge();
  f.advance(10_001);
  assert.equal(f.preflight.getState().phase, 'acknowledged');
  assertOffline(f.preflight.getState());
});

test('a repeated same-session proposal after the old subscribe deadline preserves acknowledged state', () => {
  const f = fixture(); f.prepared(); f.acknowledge(); f.advance(10_001);
  const result = f.plan();
  assert.equal(result.code, 'already_acknowledged');
  assert.equal(result.state.phase, 'acknowledged');
});

test('unsolicited post-acknowledgement 401 or mismatched receipts clear the old acknowledged state', () => {
  for (const change of [
    (r) => { r.httpStatus = 401; },
    (r) => { r.body.data[0].condition.user_id = '999'; },
  ]) {
    const f = fixture(); f.prepared(); f.acknowledge();
    const receipt = f.acknowledgement(); change(receipt);
    assertRejected(f.acknowledge(receipt));
    assert.equal(f.preflight.getState().phase, 'failed');
    assertRejected(f.plan());
  }
});

test('acknowledgement after hourly invalidation retains the precise validation-required reason', () => {
  const f = fixture(); f.prepared(); f.acknowledge(); f.advance(3_600_000);
  assert.equal(f.preflight.getState().phase, 'validation_required');
  const result = f.acknowledge();
  assert.equal(result.code, 'validation_required');
  assertRejected(result);
  assert.notEqual(result.state.phase, 'acknowledged');
});

test('subscribe deadline starts at local welcome receipt, rather than proposal time', () => {
  const f = fixture(); f.acceptValidation(); f.advance(5_000);
  const result = f.plan({ sessionId: SESSION, welcomeReceivedAt: BASE_TIME });
  assert.equal(result.code, 'subscription_planned');
  assert.equal(result.state.subscribeDeadline, BASE_TIME + 10_000);
  f.advance(5_000);
  assert.equal(f.acknowledge().code, 'window_expired');
});

test('planning before the deadline succeeds and planning at its exact boundary fails', () => {
  const f = fixture(); f.acceptValidation(); f.advance(9_999);
  assert.equal(f.plan().code, 'subscription_planned');
  const g = fixture(); g.acceptValidation(); g.advance(10_000);
  assert.equal(g.plan().code, 'window_expired');
  assertRejected(g.acknowledge());
});

test('acknowledgement at the exact subscribe deadline fails closed', () => {
  const f = fixture(); f.prepared(); f.advance(10_000);
  assert.equal(f.acknowledge().code, 'window_expired');
  assert.notEqual(f.preflight.getState().phase, 'acknowledged');
  assertRejected(f.plan());
});

test('missing, future, noninteger and unsafe local welcome receipts cannot start a window', () => {
  for (const input of [
    undefined, {}, { sessionId: SESSION },
    { sessionId: SESSION, welcomeReceivedAt: BASE_TIME + 1 },
    { sessionId: SESSION, welcomeReceivedAt: -1 },
    { sessionId: SESSION, welcomeReceivedAt: BASE_TIME + 0.5 },
    { sessionId: SESSION, welcomeReceivedAt: NaN },
    { sessionId: SESSION, welcomeReceivedAt: '2026-10-25T08:00:00Z' },
    { sessionId: '../unsafe', welcomeReceivedAt: BASE_TIME },
    { sessionId: '', welcomeReceivedAt: BASE_TIME },
  ]) {
    const f = fixture(); f.acceptValidation();
    assertRejected(f.preflight.planSubscription(input));
    assert.equal(f.preflight.getState().subscribeDeadline, null);
  }
});

test('repeated same-session plans cannot replace the original welcome receive time', () => {
  const f = fixture(); f.prepared(); f.advance(5_000);
  assert.equal(f.plan({ sessionId: SESSION, welcomeReceivedAt: BASE_TIME + 5_000 }).code, 'invalid_welcome');
  assert.equal(f.preflight.getState().subscribeDeadline, BASE_TIME + 10_000);
  assert.equal(f.plan().code, 'subscription_planned');
});

test('different active session is rejected without extending the planned deadline', () => {
  const f = fixture(); f.prepared(); f.advance(5_000);
  assert.equal(f.plan({ sessionId: 'different-session', welcomeReceivedAt: BASE_TIME + 5_000 }).code, 'session_mismatch');
  assert.equal(f.preflight.getState().subscribeDeadline, BASE_TIME + 10_000);
});

test('fresh validation allows another session but cannot extend a previously recorded session window', () => {
  const f = fixture(); f.prepared(); f.advance(5_000);
  f.acceptValidation();
  assert.equal(f.plan({ sessionId: SESSION, welcomeReceivedAt: BASE_TIME + 5_000 }).code, 'invalid_welcome');
  f.acceptValidation();
  assert.equal(f.plan({ sessionId: 'different-session', welcomeReceivedAt: BASE_TIME + 5_000 }).code, 'subscription_planned');
});

test('invalidation and revalidation do not reset the first receive time of an expired session', () => {
  const f = fixture(); f.prepared();
  f.preflight.invalidate('synthetic local reset');
  f.advance(10_000); f.acceptValidation();
  assert.equal(f.plan({ sessionId: SESSION, welcomeReceivedAt: BASE_TIME + 10_000 }).code, 'invalid_welcome');
  f.acceptValidation();
  assert.equal(f.plan().code, 'window_expired');
});

test('acknowledgement requires exact 202, enabled singleton subscription and matching identity fields', () => {
  for (const change of [
    (r) => { r.httpStatus = 200; }, (r) => { r.httpStatus = 401; },
    (r) => { r.body.data = []; },
    (r) => { r.body.data.push(structuredClone(r.body.data[0])); },
    (r) => { r.body.data[0].id = ''; },
    (r) => { r.body.data[0].status = 'webhook_callback_verification_pending'; },
    (r) => { r.body.data[0].type = 'channel.follow'; },
    (r) => { r.body.data[0].version = '2'; },
    (r) => { r.body.data[0].condition.broadcaster_user_id = '999'; },
    (r) => { r.body.data[0].condition.user_id = '999'; },
    (r) => { r.body.data[0].condition.extra = 'unexpected'; },
    (r) => { r.body.data[0].transport.method = 'webhook'; },
    (r) => { r.body.data[0].transport.session_id = 'another-session'; },
  ]) {
    const f = fixture(); f.prepared();
    const receipt = f.acknowledgement(); change(receipt);
    assertRejected(f.acknowledge(receipt));
    assert.equal(f.preflight.getState().phase, 'failed');
    assertRejected(f.plan());
  }
});

test('extra official acknowledgement fields are discarded instead of exposed in state', () => {
  const f = fixture(); f.prepared();
  const receipt = f.acknowledgement();
  Object.assign(receipt.body, { total: 1, total_cost: 0, max_total_cost: 10 });
  Object.assign(receipt.body.data[0], { cost: 0, created_at: '2026-10-25T08:00:00Z' });
  const result = f.acknowledge(receipt);
  assert.equal(result.code, 'acknowledged');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-subscription-01|created_at|max_total_cost/);
});

test('credential-shaped fields anywhere in validation or acknowledgement are rejected without echo or retention', () => {
  for (const key of ['access_token', 'refresh-token', 'AUTHORIZATION', 'client_secret', 'password', 'cookie', 'Api.Key', 'headers', 'private_key', 'credentials']) {
    const f = fixture(); f.acceptValidation();
    const receipt = f.validation(); receipt.body.extra = { [key]: SECRET_SENTINEL };
    const result = f.acceptValidation(receipt);
    assert.equal(result.code, 'credential_fields', key);
    assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_ONLY_NOT_A_REAL_CREDENTIAL/);
    assertRejected(f.plan());
    const g = fixture(); g.prepared();
    const ack = g.acknowledgement(); ack.extra = { [key]: SECRET_SENTINEL };
    const ackResult = g.acknowledge(ack);
    assert.equal(ackResult.code, 'credential_fields', key);
    assert.doesNotMatch(JSON.stringify(ackResult), /SYNTHETIC_ONLY_NOT_A_REAL_CREDENTIAL/);
    assertRejected(g.plan());
  }
});

test('receipt getters are rejected without invoking accessors or retrieving their values', () => {
  const f = fixture();
  let getterInvoked = false;
  const receipt = f.validation();
  Object.defineProperty(receipt.body, 'extra', { enumerable: true, get() { getterInvoked = true; return SECRET_SENTINEL; } });
  assertRejected(f.acceptValidation(receipt));
  assert.equal(getterInvoked, false);
});

test('cyclic, deeply nested and oversized object receipts fail within bounded scanning policy', () => {
  const cycle = fixture(); const cyclicReceipt = cycle.validation(); cyclicReceipt.body.self = cyclicReceipt;
  assertRejected(cycle.acceptValidation(cyclicReceipt));
  const deep = fixture(); const deepReceipt = deep.validation(); let current = deepReceipt.body;
  for (let index = 0; index < 20; index += 1) { current.extra = {}; current = current.extra; }
  assertRejected(deep.acceptValidation(deepReceipt));
  const large = fixture(); const largeReceipt = large.validation();
  largeReceipt.body.extra = Array.from({ length: 1_001 }, (_, index) => ({ value: index }));
  assertRejected(large.acceptValidation(largeReceipt));
});

test('snapshots and request proposals are deeply frozen and input mutation cannot change pinned output', () => {
  const f = fixture(); const receipt = f.validation();
  f.acceptValidation(receipt); receipt.body.user_id = '999'; receipt.body.expires_in = 1;
  const result = f.plan();
  assert.equal(result.code, 'subscription_planned');
  assert.throws(() => { result.request.body.condition.user_id = '999'; }, TypeError);
  assert.throws(() => { result.request.body.transport.session_id = 'mutated'; }, TypeError);
  assert.throws(() => { result.state.phase = 'acknowledged'; }, TypeError);
  const oldState = f.preflight.getState();
  f.acknowledge();
  assert.equal(oldState.phase, 'subscription_planned');
  assert.equal(f.preflight.getState().phase, 'acknowledged');
});

test('local invalidation clears acknowledgement and does not echo its caller-supplied reason', () => {
  const f = fixture(); f.prepared(); f.acknowledge();
  const result = f.preflight.invalidate(SECRET_SENTINEL);
  assertOffline(result.state);
  assert.doesNotMatch(JSON.stringify(result), /SYNTHETIC_ONLY_NOT_A_REAL_CREDENTIAL/);
  assertRejected(f.plan());
  assertRejected(f.acknowledge());
});

test('offline validation and acknowledgement still cannot authorize unverified EventSub vote intake', () => {
  const f = fixture(); f.prepared(); f.acknowledge();
  const board = createBoard({ now: () => BASE_TIME }); board.setConnection('connected'); board.openVote();
  const result = board.processEvent({ id: 'synthetic-chat', userId: CHANNEL, text: '!vote a', timestamp: BASE_TIME, origin: 'eventsub-unverified' });
  assert.equal(result.code, 'unsupported_origin');
  assert.equal(board.getState().vote.total, 0);
  assert.equal(board.getState().realTwitchConnected, false);
  assertOffline(f.preflight.getState());
});

test('constructor rejects invalid identities, policy values, limits and clocks', () => {
  for (const change of [
    { clientId: '' }, { clientId: '../unsafe' }, { broadcasterId: 'display-name' }, { readerId: 100 },
    { ownChannelOnly: 'false' }, { validationIntervalMs: 0 }, { validationIntervalMs: 3_600_001 },
    { subscribeWindowMs: 0 }, { subscribeWindowMs: 10_001 }, { minTokenRemainingMs: 0 },
    { minTokenRemainingMs: Number.MAX_SAFE_INTEGER + 1 },
    { now: () => NaN }, { now: () => -1 }, { now: () => 1.5 },
  ]) {
    assert.throws(() => createSubscriptionPreflight({ clientId: CLIENT, broadcasterId: CHANNEL, readerId: CHANNEL, ...change }));
  }
});
