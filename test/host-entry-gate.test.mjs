import test from 'node:test';
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createHostEntryGate } from '../src/host-entry-gate.mjs';
import { createDeviceSessionOwner } from '../src/device-session-owner.mjs';

const RAW = 'SYNTHETIC_PRIVATE_ENTRY_ERROR_NOT_REAL';
const base = { clientId: 'syntheticentry26', broadcasterId: '100', readerId: '100' };
const flush = () => new Promise((done) => setImmediate(done));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
function fixture(options = {}) {
  const calls = { reviews: 0, factories: 0, starts: 0, stops: 0 };
  let gate;
  const owner = { start: (args) => { calls.starts += 1; calls.signal = args.signal; return { ok: true, private: RAW }; }, stop: () => { calls.stops += 1; } };
  gate = createHostEntryGate({ ...base,
    review: (_plan, meta) => { calls.reviews += 1; calls.meta = meta; return meta.accept(); },
    createOwner: () => { calls.factories += 1; return owner; }, ...options });
  return { gate, calls, owner };
}
function publicOnly(value) {
  assert.doesNotMatch(JSON.stringify(value), /SYNTHETIC_PRIVATE|syntheticentry26|broadcasterId|readerId|accept|expiresAt|private/);
  const state = value.state ?? value;
  assert.equal(state.networkConnected, false); assert.equal(state.realTwitchConnected, false);
  assert.equal(state.authorizationVerified, false); assert.equal(state.humanAuthorizationVerified, false);
  assert.equal(Object.isFrozen(state), true);
}

test('entry construction and public plan are inert; read-only scope and no send/persistence remain fixed', () => {
  const f = fixture(); const plan = f.gate.getPlan();
  assert.deepEqual(f.calls, { reviews: 0, factories: 0, starts: 0, stops: 0 });
  assert.equal(Object.isFrozen(f.gate), true); assert.equal(Object.isFrozen(plan), true); assert.equal(Object.isFrozen(plan.scopes), true);
  assert.deepEqual(plan.scopes, ['user:read:chat']); assert.equal(plan.sendsChat, false); assert.equal(plan.persistsCredentials, false);
  assert.equal(plan.humanAuthorizationVerified, false); publicOnly(f.gate.getState()); f.gate.stop();
});
test('invalid, cross-channel, accessor and hostile configuration cannot widen a review plan or echo errors', () => {
  const config = { ...base, review() {}, createOwner() {} };
  for (const value of [null, {}, { ...config, clientId: 'bad-id' }, { ...config, readerId: '200' }, { ...config, broadcasterId: 'notnumeric' },
    { ...config, scopes: ['user:write:chat'] }, { ...config, reviewTimeoutMs: 0 }, { ...config, startTimeoutMs: 60001 }]) {
    assert.throws(() => createHostEntryGate(value), { message: 'invalid_input' });
  }
  let reads = 0; const getter = { ...config };
  Object.defineProperty(getter, 'review', { get() { reads += 1; throw new Error(RAW); } });
  assert.throws(() => createHostEntryGate(getter), { message: 'invalid_input' }); assert.equal(reads, 0);
  assert.throws(() => createHostEntryGate(new Proxy(config, { getPrototypeOf() { throw new Error(RAW); } })), { message: 'invalid_input' });
});
test('serialized booleans and approval-shaped objects never construct an owner', async () => {
  for (const decision of [true, false, { approved: true }, {}, null]) {
    const f = fixture({ review: () => decision });
    assert.equal((await f.gate.start()).code, 'review_denied'); assert.equal(f.calls.factories, 0); f.gate.stop();
  }
});
test('only current private decision starts once; private receipt fields do not enter output', async () => {
  let plan, first, second;
  const f = fixture({ review: (value, meta) => { plan = value; first = meta.accept(); second = meta.accept(); return first; } });
  const result = await f.gate.start();
  assert.equal(result.code, 'started_unverified'); assert.equal(result.ok, true); assert.equal(second, null);
  assert.equal(Object.isFrozen(first), true); assert.equal(plan, f.gate.getPlan()); assert.equal(f.calls.starts, 1); publicOnly(result);
  assert.equal((await f.gate.start()).code, 'busy'); f.gate.cancel(); assert.equal(f.calls.stops, 1);
});
test('deferred review cannot create side effects before private decision resolves', async () => {
  const decision = deferred(); let meta;
  const f = fixture({ review: (_plan, value) => { meta = value; return decision.promise; } });
  const pending = f.gate.start(); await flush(); assert.equal(f.calls.factories, 0);
  assert.equal(f.gate.getState().phase, 'reviewing'); decision.resolve(meta.accept());
  assert.equal((await pending).ok, true); f.gate.stop();
});
test('old private decision cannot approve a replacement run after cancellation', async () => {
  const decisions = []; let old;
  const f = fixture({ review: (_plan, meta) => { const d = deferred(); decisions.push({ d, meta }); return d.promise; } });
  const first = f.gate.start(); old = decisions[0].meta.accept(); f.gate.cancel(); assert.equal((await first).code, 'cancelled');
  const second = f.gate.start(); decisions[0].d.resolve(old); decisions[1].d.resolve(old);
  assert.equal((await second).code, 'review_denied'); assert.equal(f.calls.factories, 0); f.gate.stop();
});
test('denial is terminal for that request but a later explicit run can review again', async () => {
  let attempts = 0;
  const f = fixture({ review: (_plan, meta) => ++attempts === 1 ? null : meta.accept() });
  assert.equal((await f.gate.start()).code, 'review_denied'); assert.equal((await f.gate.start()).ok, true);
  assert.equal(attempts, 2); assert.equal(f.calls.factories, 1); f.gate.stop();
});
test('review exceptions and native rejections have fixed failures without raw diagnostics', async () => {
  for (const review of [() => { throw new Error(RAW); }, () => Promise.reject(new Error(RAW))]) {
    const f = fixture({ review }); const result = await f.gate.start();
    assert.equal(result.code, 'review_failed'); publicOnly(result); assert.equal(f.calls.factories, 0); f.gate.stop();
  }
});
test('unresolved review reaches a referenced deadline and late acceptance cannot start', async () => {
  const d = deferred(); let meta;
  const f = fixture({ reviewTimeoutMs: 5, review: (_plan, value) => { meta = value; return d.promise; } });
  assert.equal((await f.gate.start()).code, 'review_timeout'); assert.equal(meta.signal.aborted, true);
  assert.equal(meta.accept(), null); d.resolve(true); await flush(); assert.equal(f.calls.factories, 0); f.gate.stop();
});
test('decision expires at the exact deadline even before the scheduled callback runs', async () => {
  let now = 1000; let meta; const d = deferred();
  const f = fixture({ now: () => now, reviewTimeoutMs: 100, review: (_plan, value) => { meta = value; return d.promise; } });
  const pending = f.gate.start(); const decision = meta.accept(); now = 1100; d.resolve(decision);
  assert.equal((await pending).code, 'review_timeout'); assert.equal(f.calls.factories, 0); f.gate.stop();
});
test('pre-aborted, malformed and accessor start input never invokes review', async () => {
  const f = fixture(); const controller = new AbortController(); controller.abort();
  assert.equal((await f.gate.start({ signal: controller.signal })).code, 'aborted');
  let reads = 0; const value = {}; Object.defineProperty(value, 'signal', { get() { reads += 1; throw new Error(RAW); } });
  for (const bad of [value, { signal: {} }, { approved: true }, null]) assert.equal((await f.gate.start(bad)).code, 'invalid_input');
  assert.equal(reads, 0); assert.equal(f.calls.reviews, 0); f.gate.stop();
});
test('abort owns review lifetime and removes external listener before stale decisions settle', async () => {
  const controller = new AbortController(); const d = deferred(); let meta;
  const f = fixture({ review: (_plan, value) => { meta = value; return d.promise; } });
  const pending = f.gate.start({ signal: controller.signal }); assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
  controller.abort(); assert.equal((await pending).code, 'aborted'); assert.equal(meta.signal.aborted, true);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0); d.resolve(meta.accept()); await flush();
  assert.equal(f.calls.factories, 0); f.gate.stop();
});
test('a second start during pending review cannot create another review or owner', async () => {
  const d = deferred(); let count = 0;
  const f = fixture({ review: () => { count += 1; return d.promise; } });
  const first = f.gate.start(); assert.equal((await f.gate.start()).code, 'busy');
  assert.equal(count, 1); f.gate.cancel(); assert.equal((await first).code, 'cancelled'); d.resolve(false); f.gate.stop();
});
test('cancellation inside synchronous factory disposes its returned owner without starting it', async () => {
  let f; let stop = 0; let start = 0;
  f = fixture({ createOwner: () => { f.gate.cancel(); return { start() { start += 1; }, stop() { stop += 1; } }; } });
  assert.equal((await f.gate.start()).code, 'cancelled'); assert.equal(start, 0); assert.equal(stop, 1); f.gate.stop();
});
test('invalid owner start getter is not invoked and valid owned stop is still called', async () => {
  let reads = 0, stops = 0;
  const owner = { stop() { stops += 1; } }; Object.defineProperty(owner, 'start', { get() { reads += 1; return () => {}; } });
  const f = fixture({ createOwner: () => owner });
  assert.equal((await f.gate.start()).code, 'owner_unavailable'); assert.equal(reads, 0); assert.equal(stops, 1); f.gate.stop();
});
test('cancellation while owner starts aborts its lifetime and late success cannot revive entry', async () => {
  const d = deferred(); const f = fixture(); f.owner.start = ({ signal }) => { f.calls.signal = signal; return d.promise; };
  const pending = f.gate.start(); f.gate.cancel(); assert.equal((await pending).code, 'cancelled');
  assert.equal(f.calls.signal.aborted, true); assert.equal(f.calls.stops, 1); d.resolve({ ok: true, private: RAW });
  await flush(); assert.equal(f.gate.getState().active, false); assert.equal(f.calls.stops, 1); f.gate.stop();
});
test('owner throw rejection false and accessor success receipts fail closed without echo', async () => {
  let reads = 0; const getter = {}; Object.defineProperty(getter, 'ok', { get() { reads += 1; return true; } });
  for (const start of [() => { throw new Error(RAW); }, () => Promise.reject(new Error(RAW)), () => ({ ok: false, private: RAW }), () => getter]) {
    const f = fixture(); f.owner.start = start; const result = await f.gate.start();
    assert.equal(result.code, 'start_failed'); publicOnly(result); assert.equal(f.calls.stops, 1); f.gate.stop();
  }
  assert.equal(reads, 0);
});
test('pending owner start has a bounded deadline and owned stop need not settle', async () => {
  const f = fixture({ startTimeoutMs: 5 }); f.owner.start = () => new Promise(() => {}); f.owner.stop = () => new Promise(() => {});
  assert.equal((await f.gate.start()).code, 'start_timeout'); assert.equal(f.gate.getState().active, false); f.gate.stop();
});
test('active ownership abort and teardown reentry cannot start a new review', async () => {
  const controller = new AbortController(); const f = fixture(); let reentry;
  f.owner.stop = () => { f.calls.stops += 1; reentry = f.gate.start(); return Promise.reject(new Error(RAW)); };
  assert.equal((await f.gate.start({ signal: controller.signal })).ok, true); controller.abort();
  assert.equal((await reentry).code, 'busy'); assert.equal(f.calls.stops, 1);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0); publicOnly(f.gate.getState()); await flush(); f.gate.stop();
});
test('terminal stop cannot be revived by a pending review callback or later explicit start', async () => {
  const d = deferred(); let meta; const f = fixture({ review: (_plan, value) => { meta = value; return d.promise; } });
  const pending = f.gate.start(); f.gate.stop(); assert.equal((await pending).code, 'stopped');
  d.resolve(meta.accept()); await flush(); assert.equal((await f.gate.start()).code, 'stopped'); assert.equal(f.calls.factories, 0);
});
test('clock cancellation before timer installation cannot leak a new timer or invoke review', async () => {
  let f; let installed = 0;
  f = fixture({ now: () => { f.gate.cancel(); return 1000; }, setTimer: () => { installed += 1; return 1; } });
  assert.equal((await f.gate.start()).code, 'cancelled'); assert.equal(installed, 0); assert.equal(f.calls.reviews, 0); f.gate.stop();
});
test('timer-factory cancellation clears its late handle without invoking review', async () => {
  let f; const cleared = [];
  f = fixture({ setTimer: () => { f.gate.cancel(); return 73; }, clearTimer: (value) => cleared.push(value) });
  assert.equal((await f.gate.start()).code, 'cancelled'); assert.deepEqual(cleared, [73]); assert.equal(f.calls.reviews, 0); f.gate.stop();
});
test('foreign review thenable is not assimilated and cannot supply a decision', async () => {
  let reads = 0; const value = {}; Object.defineProperty(value, 'then', { get() { reads += 1; throw new Error(RAW); } });
  const f = fixture({ review: () => value }); assert.equal((await f.gate.start()).code, 'review_denied');
  assert.equal(reads, 0); assert.equal(f.calls.factories, 0); f.gate.stop();
});
test('actual device owner issues no synthetic HTTP before review, then aborts its pending device acquisition', async () => {
  const decision = deferred(); const response = deferred(); let meta, owner, fetches = 0, cancels = 0;
  const f = fixture({ review: (_plan, value) => { meta = value; return decision.promise; }, createOwner: (plan) => {
    owner = createDeviceSessionOwner({ clientId: plan.clientId, broadcasterId: plan.broadcasterId, readerId: plan.readerId,
      fetchImpl: () => { fetches += 1; return response.promise; }, connect: () => { throw new Error('unexpected_socket'); },
      exchange: () => { throw new Error('unexpected_exchange'); }, onPrompt: () => { throw new Error('unexpected_prompt'); } });
    return owner;
  } });
  const pending = f.gate.start(); await flush(); assert.equal(fetches, 0); assert.equal(owner, undefined);
  decision.resolve(meta.accept()); await flush(); assert.equal(fetches, 1);
  f.gate.cancel(); assert.equal((await pending).code, 'cancelled'); assert.equal(owner.getState().phase, 'stopped');
  response.resolve({ status: 400, body: { cancel() { cancels += 1; } } }); await flush();
  assert.equal(cancels, 1); publicOnly(f.gate.getState()); f.gate.stop();
});
const cli = fileURLToPath(new URL('../scripts/review-host-entry.mjs', import.meta.url));
const runCli = (args) => spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8' });
test('review-only CLI help exposes no activation switch or owner action', () => {
  const run = runCli(['--help']); assert.equal(run.status, 0); const body = JSON.parse(run.stdout);
  assert.equal(body.activationAvailable, false); assert.equal(body.mode, 'review-only'); assert.equal(run.stderr, '');
});
test('public identifier CLI emits fixed review plan while entry stays idle and unverified', () => {
  const run = runCli(['--client-id', base.clientId, '--broadcaster-id', '100', '--reader-id', '100']);
  assert.equal(run.status, 0); const body = JSON.parse(run.stdout); assert.equal(body.activationAvailable, false);
  assert.equal(body.networkActivated, false); assert.deepEqual(body.plan.scopes, ['user:read:chat']); assert.equal(body.state.phase, 'idle');
});
test('CLI rejects activation credentials duplicate fields and cross-channel IDs without echoing supplied values', () => {
  const normal = ['--client-id', base.clientId, '--broadcaster-id', '100', '--reader-id', '100'];
  for (const args of [[], [...normal, '--start'], [...normal, '--token', RAW], [...normal, '--client-id', RAW],
    ['--client-id', base.clientId, '--broadcaster-id', '100', '--reader-id', '200']]) {
    const run = runCli(args); assert.equal(run.status, 2); assert.doesNotMatch(run.stdout + run.stderr, /SYNTHETIC_PRIVATE/);
    assert.equal(JSON.parse(run.stdout).activationAvailable, false);
  }
});
