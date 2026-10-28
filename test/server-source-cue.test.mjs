import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/server.mjs';
import { createBoard } from '../src/engine.mjs';

// Actual local HTTP checks with a synthetic clock; no browser or Twitch traffic.
let clock = 20000;
const board = createBoard({ now: () => clock, sourceCueMs: 1000 });
const app = createApp({ board });
let base;
before(async () => {
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.address().port}`;
});
after(async () => { await new Promise((resolve) => app.close(resolve)); });
async function post(path, data) {
  const response = await fetch(base + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Board-Client': 'local-simulator' }, body: JSON.stringify(data)
  });
  return { status: response.status, data: await response.json() };
}

test('HTTP source request publishes simulated cue state before a vote and expires without chat output', async () => {
  board.setConnection('connected');
  const result = await post('/api/simulate', { id: 'synthetic-source-http-1', userId: 'synthetic-viewer-http-1', text: '!source', timestamp: clock });
  assert.equal(result.status, 200);
  assert.equal(result.data.sourceCuePublished, true);
  assert.equal(result.data.state.sourceCue.origin, 'simulated');
  assert.equal(result.data.state.sourceCue.active, true);
  assert.equal(result.data.state.vote.phase, 'idle');
  assert.equal(result.data.state.vote.total, 0);
  const state = await (await fetch(base + '/api/state')).json();
  assert.deepEqual(state.sourceCue, result.data.state.sourceCue);
  assert.doesNotMatch(JSON.stringify(state), /synthetic-viewer-http|synthetic-source-http/);
  for (const [path, cueId] of [['/', 'source-cue'], ['/overlay', 'overlay-source-cue']]) {
    const html = await (await fetch(base + path)).text();
    assert.match(html, new RegExp(`id="${cueId}"[^>]*aria-live="polite"[^>]*hidden`));
    assert.match(html, /SIMULATION · NO TWITCH CONNECTION/);
  }
  clock += 1000;
  const expired = await (await fetch(base + '/api/state')).json();
  assert.equal(expired.sourceCue.active, false);
  assert.equal(expired.sourceCue.requestCount, 1);
  assert.equal(expired.realTwitchConnected, false);
});

test('disconnected source previews cannot become cues by replaying after reconnect and reset clears cues', async () => {
  clock += 1000;
  board.reset();
  board.setConnection('disconnected');
  const event = { id: 'synthetic-source-http-2', userId: 'synthetic-viewer-http-2', text: '!source', timestamp: clock };
  const offline = await post('/api/simulate', event);
  assert.equal(offline.status, 200);
  assert.equal(offline.data.code, 'source');
  assert.match(offline.data.reply, /https:\/\/science.nasa.gov\/moon\/facts\//);
  assert.equal(offline.data.sourceCuePublished, false);
  assert.equal(offline.data.state.sourceCue.active, false);
  await post('/api/connection', { status: 'connected' });
  const replay = await post('/api/simulate', event);
  assert.equal(replay.status, 400);
  assert.equal(replay.data.code, 'duplicate_event');
  assert.equal(replay.data.state.sourceCue.requestCount, 0);
  const fresh = await post('/api/simulate', { ...event, id: 'synthetic-source-http-3' });
  assert.equal(fresh.data.state.sourceCue.active, true);
  const reset = await post('/api/reset', {});
  assert.equal(reset.data.state.sourceCue.active, false);
  assert.equal(reset.data.state.sourceCue.requestCount, 0);
});
