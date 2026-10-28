import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { confirmOwnChannel } from '../src/operator-confirmation.mjs';

function input() {
  const reader = new EventEmitter();
  reader.closed = false;
  return reader;
}

test('review retries unmatched or blank input without echo and accepts only the corrected own-channel phrase', async () => {
  const reader = input();
  const abort = new AbortController();
  const invalidCalls = [];
  let settled = false;
  const decision = confirmOwnChannel({ reader, signal: abort.signal, channelLogin: 'syntheticowner',
    onInvalid(...args) { invalidCalls.push(args); } });
  decision.then(() => { settled = true; });
  for (const value of ['', 'START anotherowner', 'SYNTHETIC_PRIVATE_INPUT']) reader.emit('line', value);
  await Promise.resolve();
  assert.equal(settled, false);
  assert.deepEqual(invalidCalls, [[], [], []]);
  reader.emit('line', '  START syntheticowner  ');
  const result = await decision;
  assert.deepEqual(result, { ok: true, code: 'confirmation_accepted' });
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_INPUT|anotherowner/);
  assert.equal(reader.listenerCount('line'), 0);
  assert.equal(reader.listenerCount('close'), 0);
});

test('review keeps its original deadline through retries and rejects a late phrase even before the timer callback', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  try {
    const reader = input();
    const decision = confirmOwnChannel({ reader, signal: new AbortController().signal, channelLogin: 'syntheticowner', timeoutMs: 1000 });
    t.mock.timers.tick(900);
    reader.emit('line', 'START anotherowner');
    t.mock.timers.setTime(2000);
    reader.emit('line', 'START syntheticowner');
    assert.deepEqual(await decision, { ok: false, code: 'confirmation_timeout' });
    assert.equal(reader.listenerCount('line'), 0);
  } finally { t.mock.timers.reset(); }
});

test('review distinguishes explicit cancellation, input close and timeout and retires signal listeners', async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 1000 });
  try {
    for (const kind of ['cancel', 'eof', 'abort', 'timeout']) {
      const reader = input();
      const abort = new AbortController();
      const decision = confirmOwnChannel({ reader, signal: abort.signal, channelLogin: 'syntheticowner', timeoutMs: 1000 });
      if (kind === 'cancel') reader.emit('line', 'CANCEL');
      if (kind === 'eof') { reader.closed = true; reader.emit('close'); }
      if (kind === 'abort') abort.abort();
      if (kind === 'timeout') t.mock.timers.tick(1000);
      assert.deepEqual(await decision, { ok: false, code: kind === 'eof' ? 'confirmation_input_closed'
        : kind === 'timeout' ? 'confirmation_timeout' : 'confirmation_cancelled' });
      assert.equal(reader.listenerCount('line'), 0);
      assert.equal(reader.listenerCount('close'), 0);
      abort.abort();
    }
  } finally { t.mock.timers.reset(); }
});
