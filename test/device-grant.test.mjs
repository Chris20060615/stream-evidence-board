import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createDeviceGrantHarness } from '../src/device-grant.mjs';
import { createCredentialVault } from '../src/credential-vault.mjs';

// Synthetic private codes/tokens and injected adapters only. No actual OAuth,
// Twitch account, network, browser, credential loader or device activation.
const CLIENT = 'syntheticdevice01';
const DEVICE = 'SYNTHETIC_DEVICE_CODE_CANARY_NOT_REAL';
const USER_CODE = 'ABCD1234';
const URI = `https://www.twitch.tv/activate?public=true&device-code=${USER_CODE}`;
const ACCESS = 'SYNTHETIC_ACCESS_CANARY_NOT_A_REAL_TOKEN';
const REFRESH = 'SYNTHETIC_REFRESH_CANARY_NOT_A_REAL_TOKEN';
const RAW_ERROR = 'SYNTHETIC_RAW_ERROR_CANARY_DO_NOT_PUBLISH';
const BASE = Date.parse('2026-10-25T08:00:00.000Z');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const runFile = promisify(execFile);

function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function deviceReceipt(overrides = {}) {
  return { httpStatus: 200, body: { device_code: DEVICE, user_code: USER_CODE, verification_uri: URI, expires_in: 1_800, interval: 5, ...overrides } };
}
function tokenReceipt(overrides = {}) {
  return { httpStatus: 200, body: { access_token: ACCESS, refresh_token: REFRESH, expires_in: 3_600, scope: ['user:read:chat'], token_type: 'bearer', ...overrides } };
}
const oauthError = (error, extra = {}) => ({ httpStatus: 400, body: { error, ...extra } });
const twitchPending = () => ({ httpStatus: 400, body: { status: 400, message: 'authorization_pending' } });

function manualClock() {
  let time = BASE; let next = 0; const timers = new Map();
  return {
    now: () => time,
    set: (value) => { time = value; },
    setTimer(callback, delay) { const id = ++next; timers.set(id, { callback, at: time + delay }); return id; },
    clearTimer: (id) => timers.delete(id),
    pending: () => timers.size,
    callbacks: () => [...timers.values()].map((timer) => timer.callback),
    scheduled: () => [...timers.values()],
    async advance(ms) {
      const target = time + ms; let count = 0;
      while (true) {
        const nextTimer = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!nextTimer) break;
        if (++count > 1_000) throw new Error('Synthetic timer loop bound.');
        const [id, timer] = nextTimer; timers.delete(id); time = timer.at;
        await timer.callback(); await flush();
      }
      time = target; await flush();
    },
  };
}
function assertPrivate(value) {
  assert.doesNotMatch(JSON.stringify(value), /syntheticdevice01|ABCD1234|twitch\.tv\/activate|SYNTHETIC_(DEVICE|ACCESS|REFRESH|RAW_ERROR)|user:read:chat|"(?:access_token|refresh_token|device_code|user_code|scope|scopes|verificationUri|userCode)"\s*:/);
}
function frozenData(value) {
  if (value && typeof value === 'object') {
    assert.equal(Object.isFrozen(value), true);
    for (const child of Object.values(value)) { assert.notEqual(typeof child, 'function'); frozenData(child); }
  }
}
function assertPublic(state) {
  assert.equal(state.mode, 'device-grant-harness');
  assert.equal(state.networkConnected, false); assert.equal(state.realTwitchConnected, false); assert.equal(state.authorizationVerified, false);
  assert.deepEqual(Object.keys(state).sort(), ['authorizationVerified', 'busy', 'expiresAt', 'lastCode', 'mode', 'networkConnected', 'nextPollAt', 'phase', 'pollAttempts', 'pollIntervalMs', 'realTwitchConnected']);
  frozenData(state); assertPrivate(state);
}
function assertResult(result, code) {
  assert.equal(typeof result.ok, 'boolean'); assert.equal(typeof result.code, 'string'); assert.equal(typeof result.message, 'string');
  if (code) assert.equal(result.code, code);
  assert.deepEqual(Object.keys(result).sort(), ['code', 'message', 'ok', 'state']);
  assertPublic(result.state); frozenData(result); assertPrivate(result);
}
function fixture({ config = {}, device, poll, onPrompt, onGrant } = {}) {
  const clock = manualClock(); const calls = { device: [], poll: [], prompts: [], grants: [] };
  const harness = createDeviceGrantHarness({
    clientId: CLIENT, now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    adapters: {
      device(input) { calls.device.push({ input, at: clock.now() }); return device ? device(input, calls.device.length) : deviceReceipt(); },
      poll(input) { calls.poll.push({ input, at: clock.now() }); return poll ? poll(input, calls.poll.length) : tokenReceipt(); },
    },
    onPrompt(prompt, meta) { calls.prompts.push({ prompt, meta, at: clock.now() }); return onPrompt?.(prompt, meta, calls.prompts.length); },
    onGrant(grant, meta) { calls.grants.push({ grant, meta, at: clock.now() }); return onGrant?.(grant, meta, calls.grants.length); },
    ...config,
  });
  async function begin(options) { const pending = harness.start(options); await flush(); return { pending }; }
  return { harness, calls, clock, begin };
}

test('factory is inert and exposes only frozen lifecycle controls with false authenticity flags', () => {
  const f = fixture(); assert.equal(Object.isFrozen(f.harness), true);
  assert.deepEqual(Object.keys(f.harness).sort(), ['cancel', 'getState', 'start', 'stop']);
  assert.equal(f.harness.getState().phase, 'idle'); assert.equal(f.harness.getState().busy, false);
  assert.equal(f.calls.device.length + f.calls.poll.length + f.calls.prompts.length + f.calls.grants.length, 0);
  assert.equal(f.clock.pending(), 0); assertPublic(f.harness.getState());
});

test('constructor requires explicit adapters/callbacks and rejects malformed descriptors without invoking them', () => {
  const base = { clientId: CLIENT, adapters: { device() {}, poll() {} }, onPrompt() {}, onGrant() {} };
  for (const input of [null, [], {}, { ...base, clientId: '' }, { ...base, clientId: 'unsafe-client' },
    { ...base, adapters: {} }, { ...base, onPrompt: undefined }, { ...base, onGrant: undefined },
    { ...base, ioTimeoutMs: 0 }, { ...base, ioTimeoutMs: 60_001 }, { ...base, extra: RAW_ERROR }]) {
    assert.throws(() => createDeviceGrantHarness(input), (error) => {
      assert.equal(error.message, 'invalid_input'); assert.equal(Object.hasOwn(error, 'cause'), false); assertPrivate(error); return true;
    });
  }
  let reads = 0; const getter = { ...base };
  Object.defineProperty(getter, 'adapters', { enumerable: true, get() { reads += 1; throw new Error(RAW_ERROR); } });
  assert.throws(() => createDeviceGrantHarness(getter), /invalid_input/); assert.equal(reads, 0);
});

test('fixed POST proposals are frozen and use plural scopes without client-secret or real transport', async () => {
  const f = fixture(); const { pending } = await f.begin();
  const device = f.calls.device[0].input;
  assert.deepEqual(Object.keys(device).sort(), ['request', 'signal']);
  assert.equal(Object.isFrozen(device), true); frozenData(device.request); assert.ok(device.signal instanceof AbortSignal);
  assert.deepEqual(device.request, { method: 'POST', url: 'https://id.twitch.tv/oauth2/device', body: { client_id: CLIENT, scopes: 'user:read:chat' } });
  assert.equal(f.calls.poll.length, 0); await f.clock.advance(5_000);
  const poll = f.calls.poll[0].input;
  assert.equal(Object.isFrozen(poll), true); frozenData(poll.request);
  assert.deepEqual(poll.request, { method: 'POST', url: 'https://id.twitch.tv/oauth2/token', body: { client_id: CLIENT, scopes: 'user:read:chat', device_code: DEVICE, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' } });
  assertResult(await pending, 'grant_delivered'); assert.equal(f.clock.pending(), 0);
});

test('private prompt and vault-compatible grant callbacks are frozen and remain absent from public state', async () => {
  const vault = createCredentialVault({ now: () => BASE }); let handle;
  const f = fixture({ onGrant: (grant) => { handle = vault.store(grant); } });
  const { pending } = await f.begin(); const { prompt, meta } = f.calls.prompts[0];
  assert.deepEqual(prompt, { userCode: USER_CODE, verificationUri: URI, expiresAt: BASE + 1_800_000 });
  frozenData(prompt); assert.equal(Object.isFrozen(meta), true); assert.deepEqual(Object.keys(meta), ['signal']); assert.ok(meta.signal instanceof AbortSignal);
  assertPublic(f.harness.getState()); await f.clock.advance(5_000);
  const delivered = f.calls.grants[0]; frozenData(delivered.grant); assert.equal(Object.isFrozen(delivered.meta), true);
  assert.deepEqual(delivered.grant, { accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 3_600, scopes: ['user:read:chat'] });
  assert.equal(vault.resolveAccess(handle), ACCESS); assert.equal(vault.getState().authorizationVerified, false);
  const result = await pending; assert.equal(result.ok, true); assertResult(result, 'grant_delivered');
});

test('missing interval defaults to five seconds and the first poll never runs early', async () => {
  const receipt = deviceReceipt(); delete receipt.body.interval;
  const f = fixture({ device: () => receipt }); const { pending } = await f.begin();
  assert.equal(f.harness.getState().pollIntervalMs, 5_000); assert.equal(f.harness.getState().nextPollAt, BASE + 5_000);
  const earlyWait = f.clock.scheduled().find((timer) => timer.at === BASE + 5_000);
  earlyWait.callback(); await flush();
  assert.equal(f.calls.poll.length, 0); assert.equal(f.harness.getState().nextPollAt, BASE + 5_000);
  await f.clock.advance(4_999); assert.equal(f.calls.poll.length, 0);
  await f.clock.advance(1); assert.equal(f.calls.poll[0].at, BASE + 5_000); assertResult(await pending, 'grant_delivered');
});

test('first poll interval starts after prompt completion while device expiry remains anchored to request start', async () => {
  const prompt = deferred(); const f = fixture({ device: () => deviceReceipt({ interval: 1 }), onPrompt: () => prompt.promise });
  const { pending } = await f.begin(); assert.equal(f.harness.getState().phase, 'prompting');
  await f.clock.advance(500); prompt.resolve(); await flush();
  assert.equal(f.harness.getState().nextPollAt, BASE + 1_500); assert.equal(f.harness.getState().expiresAt, BASE + 1_800_000);
  await f.clock.advance(999); assert.equal(f.calls.poll.length, 0);
  await f.clock.advance(1); assertResult(await pending, 'grant_delivered');
});

test('Twitch pending and RFC pending retain interval, slow_down adds five seconds permanently', async () => {
  const replies = [twitchPending(), oauthError('slow_down'), oauthError('slow_down'), oauthError('authorization_pending'), tokenReceipt()];
  const f = fixture({ poll: () => replies.shift() }); const { pending } = await f.begin(); const deadline = f.harness.getState().expiresAt;
  await f.clock.advance(5_000); assert.equal(f.harness.getState().nextPollAt, BASE + 10_000);
  assert.equal(f.harness.getState().pollIntervalMs, 5_000);
  await f.clock.advance(5_000); assert.equal(f.harness.getState().pollIntervalMs, 10_000); assert.equal(f.harness.getState().nextPollAt, BASE + 20_000);
  await f.clock.advance(10_000); assert.equal(f.harness.getState().pollIntervalMs, 15_000); assert.equal(f.harness.getState().nextPollAt, BASE + 35_000);
  await f.clock.advance(15_000); assert.equal(f.harness.getState().nextPollAt, BASE + 50_000); assert.equal(f.harness.getState().expiresAt, deadline);
  await f.clock.advance(15_000); assert.deepEqual(f.calls.poll.map((call) => call.at - BASE), [5_000, 10_000, 20_000, 35_000, 50_000]);
  assertResult(await pending, 'grant_delivered');
});

test('polls are serial and a pending response schedules from its completion time', async () => {
  const response = deferred(); const f = fixture({ config: { ioTimeoutMs: 10_000 }, device: () => deviceReceipt({ interval: 1 }), poll: (_, number) => number === 1 ? response.promise : tokenReceipt() });
  const { pending } = await f.begin(); await f.clock.advance(1_000); assert.equal(f.harness.getState().phase, 'polling');
  await f.clock.advance(4_000); assert.equal(f.calls.poll.length, 1);
  response.resolve(twitchPending()); await flush(); assert.equal(f.harness.getState().nextPollAt, BASE + 6_000);
  await f.clock.advance(999); assert.equal(f.calls.poll.length, 1);
  await f.clock.advance(1); assert.equal(f.calls.poll.length, 2); assertResult(await pending, 'grant_delivered');
});

test('request latency cannot extend conservative expiry and expiry preempts the first poll exactly', async () => {
  const response = deferred(); const f = fixture({ device: () => response.promise }); const { pending } = await f.begin();
  await f.clock.advance(1_000); response.resolve(deviceReceipt({ expires_in: 2 })); await flush();
  assert.equal(f.calls.prompts[0].prompt.expiresAt, BASE + 2_000); assert.equal(f.harness.getState().expiresAt, BASE + 2_000);
  await f.clock.advance(999); assert.equal(f.calls.poll.length, 0);
  await f.clock.advance(1); assertResult(await pending, 'device_expired'); assert.equal(f.calls.poll.length, 0);
  f.clock.set(BASE); assert.equal(f.harness.getState().phase, 'expired'); assertPublic(f.harness.getState());
  const overflow = fixture(); overflow.clock.set(Number.MAX_SAFE_INTEGER - 500);
  assertResult(await overflow.harness.start(), 'invalid_device_response'); assert.equal(overflow.calls.prompts.length, 0); assert.equal(overflow.clock.pending(), 0);
});

test('a device response received at the original expiry never invokes prompt or poll', async () => {
  const response = deferred(); const f = fixture({ device: () => response.promise }); const { pending } = await f.begin();
  await f.clock.advance(1_000); response.resolve(deviceReceipt({ expires_in: 1 })); await flush();
  assertResult(await pending, 'device_expired'); assert.equal(f.calls.prompts.length + f.calls.poll.length + f.calls.grants.length, 0);
});

test('pending token response cannot extend device lifetime or admit a late success', async () => {
  const response = deferred(); const f = fixture({ device: () => deviceReceipt({ expires_in: 2, interval: 1 }), poll: () => response.promise });
  const { pending } = await f.begin(); await f.clock.advance(1_000); assert.equal(f.calls.poll.length, 1);
  await f.clock.advance(1_000); assertResult(await pending, 'device_expired'); assert.equal(f.calls.poll[0].input.signal.aborted, true);
  response.resolve(tokenReceipt()); await flush(); assert.equal(f.calls.grants.length, 0); assert.equal(f.clock.pending(), 0);
});

test('only exact activation authority/path and allowed unique matching query keys are accepted', async () => {
  const allowed = ['https://www.twitch.tv/activate', 'https://www.twitch.tv/activate?public=true', `https://www.twitch.tv/activate?device-code=${USER_CODE}`, `https://www.twitch.tv/activate?device-code=${USER_CODE}&public=true`];
  for (const verification_uri of allowed) {
    const f = fixture({ device: () => deviceReceipt({ verification_uri }) }); const { pending } = await f.begin();
    assert.equal(f.calls.prompts.length, 1); f.harness.cancel(); assertResult(await pending, 'cancelled');
  }
  const bad = ['http://www.twitch.tv/activate', 'https://www.twitch.tv.evil.invalid/activate', 'https://user@www.twitch.tv/activate',
    'https://www.twitch.tv:443/activate', 'https://www.twitch.tv/activate#', 'https://www.twitch.tv/activate#fragment',
    'https://www.twitch.tv/activate/', 'https://www.twitch.tv/activate?public=false', 'https://www.twitch.tv/activate?public=true&public=true',
    'https://www.twitch.tv/activate?device-code=WRONG', `${URI}&device-code=${USER_CODE}`, `${URI}&redirect=https://never-contact.invalid`];
  for (const verification_uri of bad) {
    const f = fixture({ device: () => deviceReceipt({ verification_uri }) });
    const result = await f.harness.start(); assertResult(result, 'invalid_device_response');
    assert.equal(f.calls.prompts.length + f.calls.poll.length + f.calls.grants.length, 0);
  }
});

test('device receipt schema rejects unknown fields, accessors, cycles, unsafe codes and numeric bounds', async () => {
  let reads = 0; const accessor = deviceReceipt();
  Object.defineProperty(accessor.body, 'device_code', { enumerable: true, get() { reads += 1; throw new Error(RAW_ERROR); } });
  const cycle = deviceReceipt(); cycle.body.device_code = cycle.body;
  const thenGetter = deviceReceipt();
  Object.defineProperty(thenGetter, 'then', { enumerable: true, get() { reads += 1; throw new Error(RAW_ERROR); } });
  const responses = [null, { httpStatus: 200, body: null }, { ...deviceReceipt(), extra: RAW_ERROR }, accessor, cycle, thenGetter,
    deviceReceipt({ extra: ACCESS }), deviceReceipt({ device_code: '\r\n' }), deviceReceipt({ device_code: 'x'.repeat(4_097) }),
    deviceReceipt({ user_code: 'bad code' }), deviceReceipt({ expires_in: 0 }), deviceReceipt({ expires_in: 3_601 }),
    deviceReceipt({ expires_in: 1.5 }), deviceReceipt({ interval: 0 }), deviceReceipt({ interval: 3_601 }), deviceReceipt({ verification_uri: 'x'.repeat(2_049) })];
  for (const receipt of responses) {
    const f = fixture({ device: () => receipt }); const result = await f.harness.start(); assert.equal(result.ok, false); assertResult(result, 'invalid_device_response');
    assert.equal(f.calls.prompts.length + f.calls.poll.length + f.calls.grants.length, 0); assert.equal(f.clock.pending(), 0);
  }
  const native = Promise.resolve(deviceReceipt());
  Object.defineProperty(native, 'then', { get() { reads += 1; throw new Error(RAW_ERROR); } });
  const f = fixture({ device: () => native }); const started = await f.begin();
  assert.equal(f.calls.prompts.length, 1); f.harness.cancel(); assertResult(await started.pending, 'cancelled');
  assert.equal(reads, 0);
});

test('token type accepts bearer case-insensitively but local grant policy requires refresh and exact read scope', async () => {
  const accepted = fixture({ device: () => deviceReceipt({ interval: 1 }), poll: () => tokenReceipt({ token_type: 'BeArEr', expires_in: 14_400 }) });
  const first = await accepted.begin(); await accepted.clock.advance(1_000); assertResult(await first.pending, 'grant_delivered');
  assert.equal(accepted.calls.grants[0].grant.expiresIn, 14_400);
  const missing = tokenReceipt(); delete missing.body.refresh_token;
  for (const receipt of [missing, tokenReceipt({ scope: [] }), tokenReceipt({ scope: ['user:read:chat', 'user:write:chat'] }), tokenReceipt({ scope: ['user:read:chat', 'user:read:chat'] }),
    tokenReceipt({ token_type: 'mac' }), tokenReceipt({ access_token: '\r\n' }), tokenReceipt({ refresh_token: 'x'.repeat(4_097) }),
    tokenReceipt({ expires_in: 0 }), tokenReceipt({ expires_in: Number.MAX_SAFE_INTEGER }),
    tokenReceipt({ expires_in: Math.floor(Number.MAX_SAFE_INTEGER / 1_000) }), tokenReceipt({ unknown: ACCESS })]) {
    const f = fixture({ device: () => deviceReceipt({ interval: 1 }), poll: () => receipt }); const { pending } = await f.begin(); await f.clock.advance(1_000);
    assertResult(await pending, 'invalid_token_response'); assert.equal(f.calls.grants.length, 0); assert.equal(f.clock.pending(), 0);
  }
});

test('token receipt accessors and cycles are rejected without raw error/canary reflection', async () => {
  let reads = 0; const getter = tokenReceipt();
  Object.defineProperty(getter.body, 'access_token', { enumerable: true, get() { reads += 1; throw new Error(RAW_ERROR); } });
  const cycle = tokenReceipt(); cycle.body.scope = [cycle];
  for (const receipt of [getter, cycle, { ...tokenReceipt(), headers: { Authorization: ACCESS } }]) {
    const f = fixture({ device: () => deviceReceipt({ interval: 1 }), poll: () => receipt }); const { pending } = await f.begin(); await f.clock.advance(1_000);
    assertResult(await pending, 'invalid_token_response'); assert.equal(f.calls.grants.length, 0);
  }
  assert.equal(reads, 0);
});

test('only pending/slowdown continue; denial, expired device, invalid code and unknown errors are terminal', async () => {
  const terminal = [
    [oauthError('access_denied'), 'authorization_denied'], [oauthError('expired_token'), 'device_expired'],
    [oauthError('invalid_grant'), 'grant_rejected'], [oauthError('invalid_client'), 'authorization_rejected'],
    [oauthError('unknown-private-error'), 'unknown_oauth_error'], [{ httpStatus: 400, body: { status: 400, message: 'invalid device code' } }, 'invalid_device_code'],
    [{ httpStatus: 429, body: { error: 'slow_down' } }, 'poll_rejected'], [{ httpStatus: 503, body: { message: RAW_ERROR } }, 'poll_rejected'],
  ];
  for (const [receipt, code] of terminal) {
    const f = fixture({ device: () => deviceReceipt({ interval: 1 }), poll: () => receipt }); const { pending } = await f.begin(); await f.clock.advance(1_000);
    assertResult(await pending, code); assert.equal(f.calls.poll.length, 1); assert.equal(f.calls.grants.length, 0);
    await f.clock.advance(100_000); assert.equal(f.calls.poll.length, 1); assert.equal(f.clock.pending(), 0);
  }
});

test('bounded OAuth description/URI fields are discarded and never visited or exposed', async () => {
  const f = fixture({ device: () => deviceReceipt({ interval: 1 }), poll: (_, number) => number === 1 ? oauthError('authorization_pending', {
    error_description: `${RAW_ERROR}:${ACCESS}`, error_uri: `https://never-contact.invalid/?private=${REFRESH}`,
  }) : tokenReceipt() });
  const { pending } = await f.begin(); await f.clock.advance(1_000); assertPublic(f.harness.getState());
  await f.clock.advance(1_000); assertResult(await pending, 'grant_delivered'); assert.equal(f.calls.poll.length, 2);
});

test('a concurrent start is busy and does not restart the active deadline or first poll', async () => {
  const f = fixture(); const { pending } = await f.begin(); const before = f.harness.getState();
  assertResult(await f.harness.start(), 'busy'); assert.deepEqual(f.harness.getState(), before); assert.equal(f.calls.device.length, 1);
  await f.clock.advance(5_000); assertResult(await pending, 'grant_delivered');
});

test('cancel settles a hanging device request, permits restart, and ignores its late response', async () => {
  const old = deferred(); const f = fixture({ device: (_, number) => number === 1 ? old.promise : deviceReceipt({ interval: 1 }) });
  const first = await f.begin(); assertResult(f.harness.cancel(), 'cancelled'); assertResult(await first.pending, 'cancelled');
  assert.equal(f.calls.device[0].input.signal.aborted, true);
  const second = await f.begin(); old.resolve(deviceReceipt({ user_code: 'OLD1234', verification_uri: 'https://www.twitch.tv/activate' })); await flush();
  assert.equal(f.calls.prompts.length, 1); assert.equal(f.calls.prompts[0].prompt.userCode, USER_CODE);
  await f.clock.advance(1_000); assertResult(await second.pending, 'grant_delivered'); assert.equal(f.calls.grants.length, 1);
});

test('cancel during polling and a stale timer cannot corrupt the next generation', async () => {
  const old = deferred(); const f = fixture({ device: () => deviceReceipt({ interval: 1 }), poll: (_, number) => number === 1 ? old.promise : tokenReceipt() });
  const first = await f.begin(); await f.clock.advance(1_000); const stale = f.clock.callbacks();
  f.harness.cancel(); assertResult(await first.pending, 'cancelled');
  const second = await f.begin(); const before = f.harness.getState();
  for (const callback of stale) callback(); old.resolve(tokenReceipt({ access_token: `${ACCESS}_OLD` })); await flush();
  assert.deepEqual(f.harness.getState(), before); await f.clock.advance(1_000);
  assertResult(await second.pending, 'grant_delivered'); assert.equal(f.calls.grants.length, 1); assert.equal(f.calls.grants[0].grant.accessToken, ACCESS);
});

test('stop is terminal/idempotent and ignores delayed device completion without showing a prompt', async () => {
  const old = deferred(); const f = fixture({ device: () => old.promise }); const { pending } = await f.begin();
  assertResult(f.harness.stop(), 'stopped'); assertResult(await pending, 'stopped');
  assertResult(f.harness.stop(), 'stopped'); assertResult(await f.harness.start(), 'stopped');
  old.resolve(deviceReceipt()); await flush(); assert.equal(f.calls.prompts.length + f.calls.poll.length + f.calls.grants.length, 0);
  assert.equal(f.clock.pending(), 0); assertPublic(f.harness.getState());
});

test('native external pre-abort/malformed signal never starts device work; later abort clears wait timers', async () => {
  const pre = new AbortController(); pre.abort(new Error(RAW_ERROR)); const before = fixture();
  assertResult(await before.harness.start({ signal: pre.signal }), 'aborted'); assert.equal(before.calls.device.length, 0);
  let reads = 0; const getter = {};
  Object.defineProperty(getter, 'signal', { enumerable: true, get() { reads += 1; throw new Error(RAW_ERROR); } });
  for (const options of [null, [], { signal: {} }, { extra: true }, getter]) {
    const f = fixture(); assertResult(await f.harness.start(options), 'invalid_input'); assert.equal(f.calls.device.length, 0);
  }
  assert.equal(reads, 0);
  const controller = new AbortController(); const f = fixture(); const { pending } = await f.begin({ signal: controller.signal });
  controller.abort(new Error(`${RAW_ERROR}:${ACCESS}`)); assertResult(await pending, 'aborted');
  assert.equal(f.calls.poll.length, 0); assert.equal(f.clock.pending(), 0); assertPublic(f.harness.getState());
});

test('device and poll exceptions are terminal without retry or raw cause/error reflection', async () => {
  const f = fixture({ device: () => { throw new Error(`${RAW_ERROR}:${DEVICE}`); } });
  assertResult(await f.harness.start(), 'device_failed'); assert.equal(f.calls.prompts.length, 0);
  const rejected = fixture({ device: () => ({ httpStatus: 401, body: { message: `${RAW_ERROR}:${DEVICE}` } }) });
  assertResult(await rejected.harness.start(), 'device_rejected'); assert.equal(rejected.calls.prompts.length, 0);
  const p = fixture({ device: () => deviceReceipt({ interval: 1 }), poll: () => Promise.reject({ message: RAW_ERROR, access_token: ACCESS }) });
  const { pending } = await p.begin(); await p.clock.advance(1_000); assertResult(await pending, 'poll_failed');
  await p.clock.advance(100_000); assert.equal(p.calls.poll.length, 1); assert.equal(p.clock.pending(), 0);
});

test('device and poll I/O timeouts settle even when dependencies ignore abort and late values cannot deliver', async () => {
  const device = deferred(); const d = fixture({ config: { ioTimeoutMs: 20 }, device: () => device.promise });
  const first = await d.begin(); await d.clock.advance(20); assertResult(await first.pending, 'device_timeout');
  assert.equal(d.calls.device[0].input.signal.aborted, true); device.resolve(deviceReceipt()); await flush(); assert.equal(d.calls.prompts.length, 0);
  const poll = deferred(); const p = fixture({ config: { ioTimeoutMs: 20 }, device: () => deviceReceipt({ interval: 1 }), poll: () => poll.promise });
  const second = await p.begin(); await p.clock.advance(1_000); await p.clock.advance(20); assertResult(await second.pending, 'poll_timeout');
  assert.equal(p.calls.poll[0].input.signal.aborted, true); poll.resolve(tokenReceipt()); await flush(); assert.equal(p.calls.grants.length, 0); assert.equal(p.clock.pending(), 0);
});

test('private prompt/grant callback waits are bounded and late completion does not rewrite terminal result', async () => {
  const prompt = deferred(); const a = fixture({ config: { ioTimeoutMs: 20 }, onPrompt: () => prompt.promise });
  const first = await a.begin(); await a.clock.advance(20); assertResult(await first.pending, 'prompt_timeout');
  assert.equal(a.calls.prompts[0].meta.signal.aborted, true); prompt.resolve(); await flush(); assert.equal(a.calls.poll.length, 0);
  const expiring = fixture({ device: () => deviceReceipt({ expires_in: 1 }), onPrompt: () => new Promise(() => {}) });
  const expires = await expiring.begin(); await expiring.clock.advance(1_000); assertResult(await expires.pending, 'device_expired');
  assert.equal(expiring.calls.prompts[0].meta.signal.aborted, true); assert.equal(expiring.calls.poll.length, 0);
  const grant = deferred(); const b = fixture({ config: { ioTimeoutMs: 20 }, device: () => deviceReceipt({ interval: 1 }), onGrant: () => grant.promise });
  const second = await b.begin(); await b.clock.advance(1_000); assert.equal(b.harness.getState().phase, 'delivering_grant');
  await b.clock.advance(20); assertResult(await second.pending, 'grant_timeout');
  assert.equal(b.calls.grants[0].meta.signal.aborted, true); const state = b.harness.getState(); grant.resolve(); await flush(); assert.deepEqual(b.harness.getState(), state);
});

test('prompt/grant callback exceptions remain private and cannot claim successful delivery', async () => {
  const p = fixture({ onPrompt: () => { throw new Error(`${RAW_ERROR}:${USER_CODE}`); } });
  assertResult(await p.harness.start(), 'prompt_failed'); assert.equal(p.calls.poll.length, 0);
  const g = fixture({ device: () => deviceReceipt({ interval: 1 }), onGrant: () => Promise.reject(new Error(`${RAW_ERROR}:${ACCESS}`)) });
  const { pending } = await g.begin(); await g.clock.advance(1_000); assertResult(await pending, 'grant_failed'); assert.equal(g.clock.pending(), 0);
});

test('callback reentry cannot duplicate a run; cancel/restart and terminal stop keep generation ownership', async () => {
  let f; let busy; let second;
  f = fixture({ device: () => deviceReceipt({ interval: 1 }), onPrompt: (_, __, number) => {
    if (number === 1) { busy = f.harness.start(); f.harness.cancel(); second = f.harness.start(); }
  } });
  const first = await f.begin(); assertResult(await busy, 'busy'); assertResult(await first.pending, 'cancelled');
  await f.clock.advance(1_000); assertResult(await second, 'grant_delivered'); assert.equal(f.calls.device.length, 2); assert.equal(f.calls.grants.length, 1);
  let g; g = fixture({ device: () => deviceReceipt({ interval: 1 }), onGrant: () => { g.harness.stop(); } });
  const started = await g.begin(); await g.clock.advance(1_000); assertResult(await started.pending, 'stopped'); assert.equal(g.harness.getState().phase, 'stopped');
});

test('receipt descriptor reentry into cancel/stop cannot start late polls or deliver a stale grant', async () => {
  let f; let entered = false;
  const response = new Proxy(deviceReceipt(), { ownKeys(target) { if (!entered) { entered = true; f.harness.cancel(); } return Reflect.ownKeys(target); } });
  f = fixture({ device: () => response }); assertResult(await f.harness.start(), 'cancelled'); assert.equal(f.calls.prompts.length + f.calls.poll.length, 0);
  let g; entered = false;
  const token = new Proxy(tokenReceipt(), { ownKeys(target) { if (!entered) { entered = true; g.harness.stop(); } return Reflect.ownKeys(target); } });
  g = fixture({ device: () => deviceReceipt({ interval: 1 }), poll: () => token }); const { pending } = await g.begin();
  await g.clock.advance(1_000); assertResult(await pending, 'stopped'); assert.equal(g.calls.grants.length, 0);
});

test('clock rollback during an active attempt fails closed and snapshots remain immutable', async () => {
  const wait = deferred(); const f = fixture({ device: () => wait.promise }); const { pending } = await f.begin();
  f.clock.set(BASE + 1); assertPublic(f.harness.getState()); f.clock.set(BASE);
  const failed = f.harness.getState(); assert.equal(failed.lastCode, 'invalid_clock'); assertResult(await pending, 'invalid_clock');
  assert.throws(() => { failed.phase = 'completed'; }); wait.resolve(deviceReceipt()); await flush();
  assert.equal(f.calls.prompts.length, 0); assertPublic(f.harness.getState());
});

test('default referenced I/O deadline settles a standalone hanging adapter without early process exit', async () => {
  const moduleUrl = new URL('../src/device-grant.mjs', import.meta.url).href;
  const script = `import {createDeviceGrantHarness} from ${JSON.stringify(moduleUrl)};
    const h=createDeviceGrantHarness({clientId:'syntheticdevice01',ioTimeoutMs:20,adapters:{device:()=>new Promise(()=>{}),poll:()=>{throw Error('must-not-poll')}},onPrompt:()=>{throw Error('must-not-prompt')},onGrant:()=>{throw Error('must-not-deliver')}});
    const result=await h.start(); if(result.code!=='device_timeout'||result.ok||result.state.networkConnected||result.state.authorizationVerified)process.exitCode=2;else console.log('device_timeout');
  `;
  const result = await runFile(process.execPath, ['--input-type=module', '-e', script], { timeout: 3_000, windowsHide: true });
  assert.equal(result.stdout.trim(), 'device_timeout'); assert.equal(result.stderr, '');
});
