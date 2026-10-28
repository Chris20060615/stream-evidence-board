import test from 'node:test';
import assert from 'node:assert/strict';
import { createHostEntryGate } from '../src/host-entry-gate.mjs';

test('time consumed by start-timer cleanup still belongs to original success-publication deadline', async () => {
  let time = 1000; let gate; let sequence = 0; let advanceOnClear = false; let stops = 0;
  const timers = new Map();
  gate = createHostEntryGate({ clientId: 'syntheticpublish27', broadcasterId: '100', readerId: '100',
    now: () => time, startTimeoutMs: 100,
    setTimer: (callback) => { const id = ++sequence; timers.set(id, callback); return id; },
    clearTimer: (id) => { timers.delete(id); if (advanceOnClear) { advanceOnClear = false; time = 1100; } },
    review: (_plan, meta) => meta.accept(),
    createOwner: () => ({ start() { advanceOnClear = true; return { ok: true }; }, stop() { stops += 1; } }) });
  try {
    const result = await gate.start();
    assert.deepEqual({ code: result.code, active: gate.getState().active, stops, timers: timers.size },
      { code: 'start_timeout', active: false, stops: 1, timers: 0 });
  } finally { gate.stop(); }
});
