import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createCredentialVault } from '../src/credential-vault.mjs';
import { createTwitchHttpAdapters } from '../src/twitch-http-adapters.mjs';

// Synthetic canaries only. No real token, account, fetch, OAuth or WebSocket is used.
// Observable privacy/identity checks do not prove JavaScript heap erasure.
const ACCESS = 'SYNTHETIC_ACCESS_CANARY_NOT_A_REAL_TOKEN';
const REFRESH = 'SYNTHETIC_REFRESH_CANARY_NOT_A_REAL_TOKEN';
const RAW_ERROR = 'SYNTHETIC_RAW_ERROR_CANARY_DO_NOT_PUBLISH';
const BASE_TIME = Date.parse('2026-10-25T08:00:00.000Z');
const flush = () => new Promise((resolve) => setImmediate(resolve));
const runFile = promisify(execFile);
const codes = new Set([
  'invalid_input', 'invalid_grant', 'invalid_handle', 'credential_revoked', 'credential_expired',
  'credential_replaced', 'refresh_in_progress', 'refresh_failed', 'refresh_timeout', 'aborted',
  'stopped', 'invalid_clock', 'handle_not_serializable',
]);

function assertFixed(error, expected) {
  assert.ok(error instanceof Error);
  assert.ok(codes.has(error.message), error.message);
  if (expected) assert.equal(error.message, expected);
  assert.equal(Object.hasOwn(error, 'cause'), false);
  assert.doesNotMatch(String(error.stack), /SYNTHETIC_(ACCESS|REFRESH|RAW_ERROR)_CANARY/);
  assert.doesNotMatch(JSON.stringify(error), /SYNTHETIC_(ACCESS|REFRESH|RAW_ERROR)_CANARY/);
  return true;
}
function throwsFixed(callback, expected) {
  assert.throws(callback, (error) => assertFixed(error, expected));
}
async function rejectsFixed(task, expected) {
  await assert.rejects(task, (error) => assertFixed(error, expected));
}
function observe(task) { return task.then((value) => ({ value }), (error) => ({ error })); }
function deferred() {
  let resolve; let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function grant(overrides = {}) {
  return { accessToken: ACCESS, refreshToken: REFRESH, expiresIn: 3_600, scopes: ['user:read:chat'], ...overrides };
}

function manualClock() {
  let time = BASE_TIME; let nextId = 0;
  const timers = new Map();
  return {
    now: () => time,
    set: (value) => { time = value; },
    setTimer(callback, delay) { const id = ++nextId; timers.set(id, { callback, deadline: time + delay }); return id; },
    clearTimer(id) { timers.delete(id); },
    pending: () => timers.size,
    callbacks: () => [...timers.values()].map((timer) => timer.callback),
    async advance(milliseconds) {
      const target = time + milliseconds; let steps = 0;
      while (true) {
        const next = [...timers.entries()].filter(([, timer]) => timer.deadline <= target).sort((a, b) => a[1].deadline - b[1].deadline)[0];
        if (!next) break;
        if (++steps > 1_000) throw new Error('Synthetic timer loop exceeded bound.');
        const [id, timer] = next; timers.delete(id); time = timer.deadline;
        await timer.callback(); await flush();
      }
      time = target; await flush();
    },
  };
}
function fixture(options = {}) {
  const clock = manualClock();
  const vault = createCredentialVault({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, ...options });
  return { vault, clock };
}
function assertPublic(state) {
  assert.equal(state.mode, 'credential-memory-harness');
  assert.equal(state.authorizationVerified, false);
  assert.equal(state.networkConnected, false);
  assert.equal(state.realTwitchConnected, false);
  assert.deepEqual(Object.keys(state).sort(), ['authorizationVerified', 'expiresAt', 'mode', 'networkConnected', 'phase', 'realTwitchConnected', 'refreshPending']);
  assert.equal(Object.isFrozen(state), true);
  assert.doesNotMatch(JSON.stringify(state), /SYNTHETIC_|accessToken|refreshToken|scopes|user:read:chat|handle|Bearer |OAuth /);
}

test('factory is inert and exposes only a frozen host-only memory interface with false live flags', () => {
  const { vault, clock } = fixture();
  assert.equal(Object.isFrozen(vault), true);
  assert.deepEqual(Object.keys(vault).sort(), ['getState', 'refresh', 'resolveAccess', 'revoke', 'stop', 'store']);
  assert.equal(vault.getState().phase, 'empty');
  assert.equal(vault.getState().refreshPending, false);
  assert.equal(vault.getState().expiresAt, null);
  assert.equal(clock.pending(), 0);
  assertPublic(vault.getState());
});

test('configuration bounds and descriptors reject without running getters or reflecting raw errors', () => {
  for (const options of [null, [], { refreshTimeoutMs: 0 }, { refreshTimeoutMs: 60_001 }, { refreshTimeoutMs: 1.5 },
    { now: 1 }, { setTimer: null }, { clearTimer: null }, { extra: true }]) {
    throwsFixed(() => createCredentialVault(options), 'invalid_input');
  }
  let reads = 0;
  const options = {};
  Object.defineProperty(options, 'now', { enumerable: true, get() { reads += 1; throw new Error(RAW_ERROR); } });
  throwsFixed(() => createCredentialVault(options), 'invalid_input');
  assert.equal(reads, 0);
  assert.doesNotThrow(() => fixture({ refreshTimeoutMs: 1 }));
  assert.doesNotThrow(() => fixture({ refreshTimeoutMs: 60_000 }));
});

test('valid grant yields an opaque frozen object, privileged resolution and no serializable secret surface', () => {
  const { vault } = fixture(); const handle = vault.store(grant());
  assert.equal(typeof handle, 'object'); assert.notEqual(handle, null); assert.equal(Array.isArray(handle), false);
  assert.equal(Object.isFrozen(handle), true);
  assert.equal(vault.resolveAccess(handle), ACCESS);
  throwsFixed(() => JSON.stringify(handle), 'handle_not_serializable');
  throwsFixed(() => JSON.stringify({ credential: handle }), 'handle_not_serializable');
  assert.throws(() => structuredClone(handle));
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(handle))) {
    assert.equal('value' in descriptor, true);
    if (typeof descriptor.value === 'string') assert.doesNotMatch(descriptor.value, /SYNTHETIC_/);
    if (typeof descriptor.value === 'function' && descriptor.value !== handle.toJSON) {
      assert.equal(Object.isFrozen(descriptor.value), true);
      assert.equal(descriptor.value(), undefined);
    }
  }
  assert.equal(vault.getState().phase, 'ready');
  assert.equal(vault.getState().expiresAt, BASE_TIME + 3_600_000);
  assertPublic(vault.getState());
});

test('forged, copied, proxy-wrapped and foreign handles cannot resolve or revoke the current record', () => {
  const { vault } = fixture(); const handle = vault.store(grant());
  const foreign = fixture().vault.store(grant());
  const forged = Object.freeze({ ...handle });
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  for (const candidate of [null, undefined, {}, [], () => {}, forged, new Proxy(handle, {}), foreign, revoked.proxy]) {
    throwsFixed(() => vault.resolveAccess(candidate), 'invalid_handle');
    const result = vault.revoke(candidate);
    assert.equal(result.ok, false); assert.equal(result.code, 'invalid_handle');
    assertPublic(result.state); assert.equal(Object.isFrozen(result), true);
    assert.equal(vault.resolveAccess(handle), ACCESS);
  }
});

test('store snapshots grant values; later caller mutation cannot replace tokens, scope or expiry', () => {
  const { vault } = fixture(); const input = grant(); const handle = vault.store(input);
  input.accessToken = RAW_ERROR; input.refreshToken = RAW_ERROR; input.expiresIn = 1; input.scopes[0] = 'user:write:chat';
  assert.equal(vault.resolveAccess(handle), ACCESS);
  assert.equal(vault.getState().expiresAt, BASE_TIME + 3_600_000);
  assertPublic(vault.getState());
});

test('valid store atomically replaces the active handle and invalid replacement fails closed', () => {
  const { vault } = fixture(); const old = vault.store(grant());
  const current = vault.store(grant({ accessToken: `${ACCESS}_NEW`, refreshToken: `${REFRESH}_NEW` }));
  assert.notEqual(current, old);
  throwsFixed(() => vault.resolveAccess(old), 'credential_revoked');
  assert.equal(vault.resolveAccess(current), `${ACCESS}_NEW`);
  throwsFixed(() => vault.store(grant({ scopes: ['user:write:chat'] })), 'invalid_grant');
  throwsFixed(() => vault.resolveAccess(current));
  assert.equal(vault.getState().phase, 'failed');
  assertPublic(vault.getState());
});

test('grant exact own fields reject getters, cycles, symbols, unknown keys and inherited objects', () => {
  let reads = 0;
  const getter = grant();
  Object.defineProperty(getter, 'accessToken', { enumerable: true, get() { reads += 1; throw new Error(RAW_ERROR); } });
  const cycle = grant(); cycle.refreshToken = cycle;
  const hidden = grant(); Object.defineProperty(hidden, 'accessToken', { value: ACCESS, enumerable: false });
  for (const input of [null, [], getter, cycle, hidden, { ...grant(), extra: RAW_ERROR },
    { ...grant(), [Symbol('secret')]: RAW_ERROR }, Object.assign(Object.create({ inherited: true }), grant())]) {
    const { vault } = fixture(); const old = vault.store(grant());
    throwsFixed(() => vault.store(input), 'invalid_grant');
    throwsFixed(() => vault.resolveAccess(old));
    assertPublic(vault.getState());
  }
  assert.equal(reads, 0);
  const { vault } = fixture(); let entered = false;
  const reentrantGrant = new Proxy(grant(), {
    ownKeys(target) {
      if (!entered) { entered = true; vault.stop(); }
      return Reflect.ownKeys(target);
    },
  });
  throwsFixed(() => vault.store(reentrantGrant), 'stopped');
  assert.equal(vault.getState().phase, 'stopped'); assertPublic(vault.getState());
});

test('local exact read-scope policy rejects extra, duplicated, malformed and accessor array entries', () => {
  let reads = 0; const getterScopes = [];
  Object.defineProperty(getterScopes, '0', { enumerable: true, get() { reads += 1; return 'user:read:chat'; } });
  const extraScopes = ['user:read:chat']; extraScopes.extra = RAW_ERROR;
  for (const scopes of [[], 'user:read:chat', ['user:write:chat'], ['user:read:chat', 'user:write:chat'],
    ['user:read:chat', 'user:read:chat'], [null], new Array(1), getterScopes, extraScopes]) {
    const { vault } = fixture();
    throwsFixed(() => vault.store(grant({ scopes })), 'invalid_grant');
    assertPublic(vault.getState());
  }
  assert.equal(reads, 0);
});

test('both token values have strict printable ASCII and 4096-character limits', () => {
  for (const field of ['accessToken', 'refreshToken']) {
    for (const token of ['', null, 123, 'with space', `prefix\r\n${RAW_ERROR}`, '\0', '\t', '\u007f', '\u00e9', 'x'.repeat(4_097)]) {
      const { vault } = fixture();
      throwsFixed(() => vault.store(grant({ [field]: token })), 'invalid_grant');
      assertPublic(vault.getState());
    }
    const { vault } = fixture(); const handle = vault.store(grant({ [field]: '!'.repeat(4_096) }));
    assert.equal(typeof vault.resolveAccess(handle), 'string');
  }
});

test('expiry seconds must be positive safe integers and derived deadline must not overflow', () => {
  for (const expiresIn of [0, -1, 0.5, NaN, Infinity, '3600', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1]) {
    const { vault } = fixture();
    throwsFixed(() => vault.store(grant({ expiresIn })), 'invalid_grant');
    assertPublic(vault.getState());
  }
  const { vault, clock } = fixture(); clock.set(Number.MAX_SAFE_INTEGER - 500);
  throwsFixed(() => vault.store(grant({ expiresIn: 1 })), 'invalid_grant');
});

test('expiry occurs at the exact deadline and observed expiry cannot be revived by clock rollback', async () => {
  const { vault, clock } = fixture(); const handle = vault.store(grant({ expiresIn: 1 }));
  await clock.advance(999); assert.equal(vault.resolveAccess(handle), ACCESS);
  await clock.advance(1); throwsFixed(() => vault.resolveAccess(handle), 'credential_expired');
  assert.equal(vault.getState().phase, 'expired');
  clock.set(BASE_TIME); throwsFixed(() => vault.resolveAccess(handle), 'credential_expired');
  assert.equal(vault.getState().phase, 'expired'); assertPublic(vault.getState());
});

test('a broken clock fails closed with a fixed error rather than retaining usable credentials', () => {
  let broken = false;
  const { vault } = fixture({ now: () => { if (broken) throw new Error(RAW_ERROR); return BASE_TIME; } });
  const handle = vault.store(grant()); broken = true;
  throwsFixed(() => vault.resolveAccess(handle), 'invalid_clock');
  broken = false; throwsFixed(() => vault.resolveAccess(handle));
  assertPublic(vault.getState());
});

test('refresh has one outstanding exchange, a private signal, and blocks access resolution while pending', async () => {
  const { vault, clock } = fixture(); const handle = vault.store(grant()); const pending = deferred(); const calls = [];
  const exchange = (input) => { calls.push(input); return pending.promise; };
  const task = observe(vault.refresh(handle, { exchange })); await flush();
  assert.equal(calls.length, 1);
  assert.deepEqual(Object.keys(calls[0]).sort(), ['refreshToken', 'signal']);
  assert.equal(calls[0].refreshToken, REFRESH); assert.ok(calls[0].signal instanceof AbortSignal);
  assert.equal(calls[0].signal.aborted, false);
  assert.equal(vault.getState().phase, 'refreshing'); assert.equal(vault.getState().refreshPending, true);
  throwsFixed(() => vault.resolveAccess(handle), 'refresh_in_progress');
  await rejectsFixed(vault.refresh(handle, { exchange }), 'refresh_in_progress');
  assert.equal(calls.length, 1); assert.equal(clock.pending(), 1); assertPublic(vault.getState());
  pending.resolve(grant({ accessToken: `${ACCESS}_ROTATED` }));
  const result = await task; assert.equal(result.error, undefined);
  assert.equal(vault.resolveAccess(result.value), `${ACCESS}_ROTATED`); assert.equal(clock.pending(), 0);
});

test('successful refresh rotates both tokens into a new identity and permanently retires the old handle', async () => {
  const { vault } = fixture(); const old = vault.store(grant());
  const next = await vault.refresh(old, { exchange: async ({ refreshToken }) => {
    assert.equal(refreshToken, REFRESH); return grant({ accessToken: `${ACCESS}_2`, refreshToken: `${REFRESH}_2` });
  } });
  assert.notEqual(next, old); throwsFixed(() => vault.resolveAccess(old), 'credential_revoked');
  assert.equal(vault.resolveAccess(next), `${ACCESS}_2`);
  const third = await vault.refresh(next, { exchange: async ({ refreshToken }) => {
    assert.equal(refreshToken, `${REFRESH}_2`); return grant({ accessToken: `${ACCESS}_3` });
  } });
  throwsFixed(() => vault.resolveAccess(next), 'credential_revoked');
  assert.equal(vault.resolveAccess(third), `${ACCESS}_3`); assertPublic(vault.getState());
});

test('refresh with a forged or foreign handle never runs exchange or disturbs current authority', async () => {
  const { vault } = fixture(); const handle = vault.store(grant()); let calls = 0;
  const foreign = fixture().vault.store(grant());
  for (const fake of [{}, { ...handle }, foreign]) {
    await rejectsFixed(vault.refresh(fake, { exchange: () => { calls += 1; return grant(); } }), 'invalid_handle');
    assert.equal(vault.resolveAccess(handle), ACCESS);
  }
  assert.equal(calls, 0); assertPublic(vault.getState());
});

test('exchange synchronous exceptions and rejected promises fail closed without raw cause/error text', async () => {
  for (const exchange of [() => { throw new Error(`${RAW_ERROR}:${REFRESH}`); }, () => Promise.reject({ message: RAW_ERROR, refreshToken: REFRESH })]) {
    const { vault, clock } = fixture(); const handle = vault.store(grant());
    await rejectsFixed(vault.refresh(handle, { exchange }), 'refresh_failed');
    throwsFixed(() => vault.resolveAccess(handle));
    assert.equal(vault.getState().phase, 'failed'); assert.equal(clock.pending(), 0); assertPublic(vault.getState());
  }
});

test('malformed refresh grants fail closed and never echo unexpected callback data', async () => {
  for (const output of [null, { error: RAW_ERROR }, grant({ refreshToken: '\r\n' }), grant({ scopes: ['user:read:chat', 'user:write:chat'] })]) {
    const { vault } = fixture(); const handle = vault.store(grant());
    await rejectsFixed(vault.refresh(handle, { exchange: async () => output }), 'invalid_grant');
    throwsFixed(() => vault.resolveAccess(handle)); assertPublic(vault.getState());
  }
});

test('refresh options are exact own data and malformed descriptors never execute exchange getters', async () => {
  let reads = 0; const options = {};
  Object.defineProperty(options, 'exchange', { enumerable: true, get() { reads += 1; throw new Error(RAW_ERROR); } });
  for (const input of [null, [], options, { exchange: null }, { exchange: () => grant(), extra: RAW_ERROR }, { exchange: () => grant(), signal: {} }]) {
    const { vault } = fixture(); const handle = vault.store(grant());
    await rejectsFixed(vault.refresh(handle, input), 'invalid_input'); assertPublic(vault.getState());
  }
  assert.equal(reads, 0);
  for (const trigger of ['ownKeys', 'secondClock']) {
    let armed = false; let clockReads = 0; let entered = false; let inner; let outerCalls = 0; let innerCalls = 0;
    let vault; let handle; const pending = deferred();
    const beginInner = () => {
      if (entered) return; entered = true;
      inner = observe(vault.refresh(handle, { exchange: () => { innerCalls += 1; return pending.promise; } }));
    };
    const f = fixture({ now: () => {
      if (armed && ++clockReads === 2 && trigger === 'secondClock') beginInner();
      return BASE_TIME;
    } });
    vault = f.vault; handle = vault.store(grant());
    const options = { exchange: () => { outerCalls += 1; return grant(); } };
    const input = trigger === 'ownKeys' ? new Proxy(options, {
      ownKeys(target) { beginInner(); return Reflect.ownKeys(target); },
    }) : options;
    armed = true;
    await rejectsFixed(vault.refresh(handle, input), 'refresh_in_progress');
    assert.equal(innerCalls, 1); assert.equal(outerCalls, 0); assert.equal(f.clock.pending(), 1);
    assert.equal(vault.getState().phase, 'refreshing');
    pending.resolve(grant({ accessToken: `${ACCESS}_INNER` }));
    const result = await inner; assert.equal(result.error, undefined);
    assert.equal(vault.resolveAccess(result.value), `${ACCESS}_INNER`);
    assert.equal(f.clock.pending(), 0); assertPublic(vault.getState());
  }
});

test('hanging exchange times out even when it ignores abort; late grant cannot revive the retired record', async () => {
  const { vault, clock } = fixture({ refreshTimeoutMs: 20 }); const old = vault.store(grant()); const pending = deferred(); let signal;
  const task = observe(vault.refresh(old, { exchange: (input) => { signal = input.signal; return pending.promise; } }));
  await flush(); await clock.advance(20);
  assertFixed((await task).error, 'refresh_timeout'); assert.equal(signal.aborted, true);
  assert.equal(clock.pending(), 0); assert.equal(vault.getState().phase, 'failed');
  const current = vault.store(grant({ accessToken: `${ACCESS}_AFTER_TIMEOUT` }));
  pending.resolve(grant({ accessToken: `${ACCESS}_LATE` })); await flush();
  assert.equal(vault.resolveAccess(current), `${ACCESS}_AFTER_TIMEOUT`);
  throwsFixed(() => vault.resolveAccess(old)); assertPublic(vault.getState());
});

test('external abort settles an ignoring exchange immediately and suppresses its raw reason', async () => {
  const { vault, clock } = fixture(); const old = vault.store(grant()); const pending = deferred(); const controller = new AbortController(); let owned;
  const task = observe(vault.refresh(old, { signal: controller.signal, exchange: ({ signal }) => { owned = signal; return pending.promise; } }));
  await flush(); controller.abort(new Error(`${RAW_ERROR}:${ACCESS}`));
  assertFixed((await task).error, 'aborted'); assert.equal(owned.aborted, true); assert.equal(clock.pending(), 0);
  pending.reject(new Error(`${RAW_ERROR}:${REFRESH}`)); await flush();
  throwsFixed(() => vault.resolveAccess(old)); assertPublic(vault.getState());
});

test('pre-aborted refresh never invokes the exchange callback', async () => {
  const { vault, clock } = fixture(); const handle = vault.store(grant()); const controller = new AbortController(); let calls = 0;
  controller.abort(RAW_ERROR);
  await rejectsFixed(vault.refresh(handle, { signal: controller.signal, exchange: () => { calls += 1; return grant(); } }), 'aborted');
  assert.equal(calls, 0); assert.equal(clock.pending(), 0);
  throwsFixed(() => vault.resolveAccess(handle)); assertPublic(vault.getState());
});

test('revoke immediately aborts/settles pending refresh; its late result cannot override a later store', async () => {
  const { vault, clock } = fixture(); const old = vault.store(grant()); const pending = deferred(); let signal;
  const task = observe(vault.refresh(old, { exchange: (input) => { signal = input.signal; return pending.promise; } }));
  await flush(); const revoked = vault.revoke(old);
  assert.equal(revoked.ok, true); assert.equal(revoked.code, 'revoked'); assert.equal(Object.isFrozen(revoked), true);
  assertFixed((await task).error, 'credential_revoked'); assert.equal(signal.aborted, true); assert.equal(clock.pending(), 0);
  const current = vault.store(grant({ accessToken: `${ACCESS}_AFTER_REVOKE` }));
  pending.resolve(grant({ accessToken: `${ACCESS}_LATE` })); await flush();
  assert.equal(vault.resolveAccess(current), `${ACCESS}_AFTER_REVOKE`); assertPublic(vault.getState());
  const other = fixture(); const initial = other.vault.store(grant()); let fromAbort;
  const reentrantTask = observe(other.vault.refresh(initial, { exchange: ({ signal: owned }) => {
    owned.addEventListener('abort', () => { fromAbort = other.vault.store(grant({ accessToken: `${ACCESS}_FROM_ABORT` })); }, { once: true });
    return new Promise(() => {});
  } }));
  await flush(); other.vault.revoke(initial);
  assertFixed((await reentrantTask).error, 'credential_revoked');
  assert.equal(other.vault.resolveAccess(fromAbort), `${ACCESS}_FROM_ABORT`);
  assertPublic(other.vault.getState());
});

test('stop settles pending refresh and permanently refuses future store/resolve/refresh', async () => {
  const { vault, clock } = fixture(); const old = vault.store(grant()); const pending = deferred(); let signal;
  const task = observe(vault.refresh(old, { exchange: (input) => { signal = input.signal; return pending.promise; } }));
  await flush(); const stopped = vault.stop();
  assert.equal(stopped.ok, true); assert.equal(stopped.code, 'stopped'); assertPublic(stopped.state);
  assertFixed((await task).error, 'stopped'); assert.equal(signal.aborted, true); assert.equal(clock.pending(), 0);
  pending.resolve(grant()); await flush();
  throwsFixed(() => vault.store(grant()), 'stopped'); throwsFixed(() => vault.resolveAccess(old), 'stopped');
  await rejectsFixed(vault.refresh(old, { exchange: () => grant() }), 'stopped');
  assert.equal(vault.stop().code, 'stopped'); assert.equal(vault.getState().phase, 'stopped');
});

test('store replacement cancels pending exchange and ignores late completion without nulling its new record', async () => {
  const { vault, clock } = fixture(); const old = vault.store(grant()); const pending = deferred(); let signal;
  const task = observe(vault.refresh(old, { exchange: (input) => { signal = input.signal; return pending.promise; } }));
  await flush(); const current = vault.store(grant({ accessToken: `${ACCESS}_REPLACEMENT` }));
  assertFixed((await task).error, 'credential_replaced'); assert.equal(signal.aborted, true); assert.equal(clock.pending(), 0);
  assert.equal(vault.resolveAccess(current), `${ACCESS}_REPLACEMENT`);
  pending.resolve(grant({ accessToken: `${ACCESS}_OLD_LATE` })); await flush();
  assert.equal(vault.resolveAccess(current), `${ACCESS}_REPLACEMENT`); assertPublic(vault.getState());
  const other = fixture(); const initial = other.vault.store(grant()); let replacement; let entered = false;
  const output = new Proxy(grant(), {
    ownKeys(target) {
      if (!entered) { entered = true; replacement = other.vault.store(grant({ accessToken: `${ACCESS}_REENTRANT` })); }
      return Reflect.ownKeys(target);
    },
  });
  await rejectsFixed(other.vault.refresh(initial, { exchange: async () => output }), 'credential_replaced');
  assert.equal(other.vault.resolveAccess(replacement), `${ACCESS}_REENTRANT`);
  assertPublic(other.vault.getState());
  const third = fixture(); const beforeOuter = third.vault.store(grant()); let fromAbort;
  const interrupted = observe(third.vault.refresh(beforeOuter, { exchange: ({ signal }) => {
    signal.addEventListener('abort', () => { fromAbort = third.vault.store(grant({ accessToken: `${ACCESS}_INNER_STORE` })); }, { once: true });
    return new Promise(() => {});
  } }));
  await flush();
  throwsFixed(() => third.vault.store(grant({ accessToken: `${ACCESS}_OUTER_STORE` })), 'credential_replaced');
  assertFixed((await interrupted).error, 'credential_replaced');
  assert.equal(third.vault.resolveAccess(fromAbort), `${ACCESS}_INNER_STORE`);
  assert.equal(third.clock.pending(), 0); assertPublic(third.vault.getState());
});

test('invalid store replacement also cancels pending exchange fail-closed', async () => {
  const { vault, clock } = fixture(); const old = vault.store(grant()); const pending = deferred();
  const task = observe(vault.refresh(old, { exchange: () => pending.promise })); await flush();
  throwsFixed(() => vault.store({ accessToken: ACCESS }), 'invalid_grant');
  assertFixed((await task).error, 'credential_replaced'); assert.equal(clock.pending(), 0);
  pending.resolve(grant()); await flush();
  throwsFixed(() => vault.resolveAccess(old)); assert.equal(vault.getState().phase, 'failed'); assertPublic(vault.getState());
});

test('old canceled timer/completion cannot terminate or erase a newer pending refresh', async () => {
  const { vault, clock } = fixture({ refreshTimeoutMs: 50 }); const old = vault.store(grant()); const first = deferred();
  const firstTask = observe(vault.refresh(old, { exchange: () => first.promise })); await flush();
  const oldTimer = clock.callbacks()[0];
  const current = vault.store(grant({ accessToken: `${ACCESS}_CURRENT` }));
  assertFixed((await firstTask).error, 'credential_replaced');
  const second = deferred(); const secondTask = observe(vault.refresh(current, { exchange: () => second.promise })); await flush();
  assert.equal(clock.pending(), 1); oldTimer(); first.resolve(grant({ accessToken: `${ACCESS}_STALE` })); await flush();
  assert.equal(vault.getState().phase, 'refreshing'); assert.equal(clock.pending(), 1);
  second.resolve(grant({ accessToken: `${ACCESS}_LATEST` })); const latest = (await secondTask).value;
  assert.equal(vault.resolveAccess(latest), `${ACCESS}_LATEST`); assert.equal(clock.pending(), 0); assertPublic(vault.getState());
});

test('old credential expiry bounds a pending refresh earlier than its I/O timeout', async () => {
  const { vault, clock } = fixture({ refreshTimeoutMs: 5_000 }); const old = vault.store(grant({ expiresIn: 1 })); const pending = deferred(); let signal;
  const task = observe(vault.refresh(old, { exchange: (input) => { signal = input.signal; return pending.promise; } }));
  await flush(); await clock.advance(999); assert.equal(vault.getState().phase, 'refreshing');
  await clock.advance(1); assertFixed((await task).error, 'credential_expired'); assert.equal(signal.aborted, true);
  assert.equal(vault.getState().phase, 'expired'); assert.equal(clock.pending(), 0);
  clock.set(BASE_TIME); pending.resolve(grant()); await flush();
  throwsFixed(() => vault.resolveAccess(old), 'credential_expired'); assertPublic(vault.getState());
});

test('hostile thenable errors are sanitized and retired handles expose no retained token through descriptors', async () => {
  const { vault } = fixture(); const old = vault.store(grant());
  const thenable = Object.create(null);
  Object.defineProperty(thenable, 'then', { get() { throw new Error(`${RAW_ERROR}:${REFRESH}`); } });
  await rejectsFixed(vault.refresh(old, { exchange: () => thenable }), 'refresh_failed');
  const descriptors = Object.getOwnPropertyDescriptors(old);
  for (const descriptor of Object.values(descriptors)) {
    assert.notEqual(descriptor.value, ACCESS); assert.notEqual(descriptor.value, REFRESH);
  }
  throwsFixed(() => JSON.stringify(old), 'handle_not_serializable');
  assertPublic(vault.getState());
});

test('default referenced timer settles an ignored hanging refresh in a standalone process', async () => {
  const moduleUrl = new URL('../src/credential-vault.mjs', import.meta.url).href;
  const script = `import { createCredentialVault } from ${JSON.stringify(moduleUrl)};
    const vault = createCredentialVault({refreshTimeoutMs:20});
    const handle=vault.store({accessToken:'synthetic-access',refreshToken:'synthetic-refresh',expiresIn:3600,scopes:['user:read:chat']});
    try { await vault.refresh(handle,{exchange:()=>new Promise(()=>{})}); process.exitCode=2; }
    catch(error) { if(error.message!=='refresh_timeout') process.exitCode=3; else console.log('refresh_timeout'); }
  `;
  const result = await runFile(process.execPath, ['--input-type=module', '-e', script], { timeout: 3_000, windowsHide: true });
  assert.equal(result.stdout.trim(), 'refresh_timeout'); assert.equal(result.stderr, '');
});

test('vault resolves only the current handle for actual HTTP adapter with fake fetch and no live authorization', async () => {
  const { vault, clock } = fixture(); const handle = vault.store(grant()); const calls = [];
  const adapters = createTwitchHttpAdapters({
    clientId: 'syntheticclient01', broadcasterId: '100', readerId: '100',
    resolveCredential: vault.resolveAccess, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    fetch: async (url, options) => {
      calls.push({ url, options });
      let read = false;
      return { status: 200, body: { getReader: () => ({
        read: async () => {
          if (read) return { done: true }; read = true;
          return { done: false, value: new TextEncoder().encode(JSON.stringify({ client_id: 'syntheticclient01', user_id: '100', scopes: ['user:read:chat'], expires_in: 3_600, ignored: REFRESH })) };
        }, cancel() {}, releaseLock() {},
      }) } };
    },
  });
  const receipt = await adapters.validate({ credential: handle });
  assert.equal(calls.length, 1); assert.equal(calls[0].url, 'https://id.twitch.tv/oauth2/validate');
  assert.deepEqual(calls[0].options.headers, { Authorization: `OAuth ${ACCESS}` });
  assert.doesNotMatch(calls[0].url, /SYNTHETIC_|token|credential/);
  assert.equal(calls[0].options.body, undefined);
  assert.equal(receipt.httpStatus, 200); assert.equal(Object.isFrozen(receipt.body.scopes), true);
  assert.doesNotMatch(JSON.stringify(receipt), /SYNTHETIC_|accessToken|refreshToken/);
  vault.revoke(handle);
  await assert.rejects(adapters.validate({ credential: handle }), (error) => {
    assert.equal(error.message, 'credential_resolution_failed'); assert.equal(Object.hasOwn(error, 'cause'), false); return true;
  });
  assert.equal(calls.length, 1); assert.equal(clock.pending(), 0); assertPublic(vault.getState());
});
