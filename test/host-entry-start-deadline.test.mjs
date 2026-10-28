import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostEntryGate } from '../src/host-entry-gate.mjs';

// Synthetic clock explicitly advances ahead of still-pending timer delivery.
// This verifies operation-boundary deadlines, not OS scheduling or real OAuth.
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function fixture({ factoryAdvance, receiptAdvance, pending = false } = {}) {
  let now = 1000;
  const counters = { starts: 0, stops: 0 };
  const completion = deferred();
  let signal;
  const gate = createHostEntryGate({ clientId: 'syntheticdeadline27', broadcasterId: '100', readerId: '100',
    now: () => now, reviewTimeoutMs: 10000, startTimeoutMs: 100,
    review: (_plan, meta) => meta.accept(),
    createOwner: () => {
      if (factoryAdvance !== undefined) now = factoryAdvance;
      return { start: (args) => {
        counters.starts += 1; signal = args.signal;
        if (receiptAdvance !== undefined) now = receiptAdvance;
        return pending ? completion.promise : { ok: true };
      }, stop() { counters.stops += 1; } };
    } });
  return { gate, counters, completion, setTime: (value) => { now = value; },
    observe: (result) => ({ code: result.code, active: result.state.active, starts: counters.starts, stops: counters.stops, signalAborted: signal?.aborted ?? null }) };
}
test('factory returning exactly at start deadline cannot invoke owner start', async () => {
  const f = fixture({ factoryAdvance: 1100 });
  try {
    const result = await f.gate.start();
    assert.deepEqual(f.observe(result), { code: 'start_timeout', active: false, starts: 0, stops: 1, signalAborted: null });
  } finally { f.gate.stop(); }
});
test('factory returning after start deadline is retired before any owner-start side effect', async () => {
  const f = fixture({ factoryAdvance: 1101 });
  try {
    const result = await f.gate.start();
    assert.deepEqual(f.observe(result), { code: 'start_timeout', active: false, starts: 0, stops: 1, signalAborted: null });
  } finally { f.gate.stop(); }
});
test('synchronous owner success returned at deadline cannot publish active ownership', async () => {
  const f = fixture({ receiptAdvance: 1100 });
  try {
    const result = await f.gate.start();
    assert.deepEqual(f.observe(result), { code: 'start_timeout', active: false, starts: 1, stops: 1, signalAborted: true });
  } finally { f.gate.stop(); }
});
test('native owner success resolved after deadline retires even before timer callback delivery', async () => {
  const f = fixture({ pending: true });
  try {
    const pending = f.gate.start(); f.setTime(1101); f.completion.resolve({ ok: true });
    const result = await pending;
    assert.deepEqual(f.observe(result), { code: 'start_timeout', active: false, starts: 1, stops: 1, signalAborted: true });
  } finally { f.gate.stop(); }
});
test('factory and successful start strictly before deadline remain accepted without extending the window', async () => {
  const f = fixture({ factoryAdvance: 1098, receiptAdvance: 1099 });
  try {
    const result = await f.gate.start();
    assert.deepEqual(f.observe(result), { code: 'started_unverified', active: true, starts: 1, stops: 0, signalAborted: false });
    assert.equal(result.state.humanAuthorizationVerified, false); assert.equal(result.state.realTwitchConnected, false);
  } finally { f.gate.stop(); }
});
test('completed start deadline is not an active-owner lease; explicit cancel still stops exactly once', async () => {
  const f = fixture();
  try {
    assert.equal((await f.gate.start()).ok, true); f.setTime(5000);
    assert.equal(f.gate.getState().active, true); f.gate.cancel(); f.gate.cancel();
    assert.equal(f.counters.stops, 1); assert.equal(f.gate.getState().active, false);
  } finally { f.gate.stop(); }
});
test('cancellation reentered while clearing start deadline cannot publish active state afterward', async () => {
  let gate; let sequence = 0; let cancelOnClear = false; let stops = 0;
  const timers = new Map();
  gate = createHostEntryGate({ clientId: 'syntheticdeadline27', broadcasterId: '100', readerId: '100', now: () => 1000,
    setTimer: (callback) => { const id = ++sequence; timers.set(id, callback); return id; },
    clearTimer: (id) => { timers.delete(id); if (cancelOnClear) { cancelOnClear = false; gate.cancel(); } },
    review: (_plan, meta) => meta.accept(),
    createOwner: () => ({ start() { cancelOnClear = true; return { ok: true }; }, stop() { stops += 1; } }) });
  try {
    const result = await gate.start();
    assert.deepEqual({ code: result.code, activeAfterSettlement: gate.getState().active, stops, timers: timers.size },
      { code: 'cancelled', activeAfterSettlement: false, stops: 1, timers: 0 });
  } finally { gate.stop(); }
});
