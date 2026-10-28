import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createApp } from '../src/server.mjs';

let app;
let base;
const headers = { 'Content-Type': 'application/json', 'X-Board-Client': 'local-simulator' };
async function post(path, data, extra = {}) {
  const response = await fetch(base + path, { method: 'POST', headers: { ...headers, ...extra }, body: JSON.stringify(data) });
  return { status: response.status, body: await response.json() };
}
before(async () => {
  app = createApp();
  await new Promise((resolve) => app.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${app.address().port}`;
});
after(async () => { await new Promise((resolve) => app.close(resolve)); });

test('controller and overlay assets are served with security headers and explicit simulation labels', async () => {
  for (const path of ['/', '/overlay']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const html = await response.text();
    assert.match(html, /SIMULATION · NO TWITCH CONNECTION/);
    assert.doesNotMatch(html, /<script(?![^>]*src=)/);
  }
  for (const path of ['/app.mjs', '/overlay.mjs', '/style.css']) assert.equal((await fetch(base + path)).status, 200);
});

test('server round trip: source, disconnected rejection, open vote, replay, change, close', async () => {
  await post('/api/reset', {});
  const initial = await (await fetch(base + '/api/state')).json();
  assert.equal(initial.mode, 'simulated');
  assert.equal(initial.realTwitchConnected, false);
  const source = await post('/api/simulate', { id: 'source-1', userId: 'sim-1', text: '!source' });
  assert.equal(source.status, 200);
  assert.match(JSON.stringify(source.body.reply), /https:\/\/science.nasa.gov\/moon\/facts\//);
  await post('/api/vote/open', { durationMs: 60000 });
  const disconnected = await post('/api/simulate', { id: 'vote-offline', userId: 'sim-1', text: '!vote a' });
  assert.equal(disconnected.status, 400);
  assert.equal(disconnected.body.code, 'disconnected');
  await post('/api/connection', { status: 'connected' });
  const event = { id: 'vote-1', userId: 'sim-1', text: '!vote a' };
  const accepted = await post('/api/simulate', event);
  assert.equal(accepted.status, 200);
  assert.equal(accepted.body.state.vote.counts.a, 1);
  await post('/api/simulate', event);
  const changed = await post('/api/simulate', { ...event, id: 'vote-2', text: '!vote b' });
  assert.equal(changed.body.state.vote.total, 1);
  assert.equal(changed.body.state.vote.counts.a, 0);
  assert.equal(changed.body.state.vote.counts.b, 1);
  await post('/api/vote/close', {});
  const closed = await post('/api/simulate', { ...event, id: 'vote-3' });
  assert.equal(closed.status, 400);
  assert.equal(closed.body.state.vote.total, 1);
});

test('simulator endpoint cannot claim a real Twitch origin', async () => {
  const result = await post('/api/simulate', { id: 'fake-real', userId: 'nobody', text: '!vote a', origin: 'twitch' });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'unsupported_origin');
});

test('HTTP simulator preserves event time so earlier-round messages cannot enter a new vote', async () => {
  await post('/api/reset', {});
  await post('/api/connection', { status: 'connected' });
  await post('/api/vote/open', { durationMs: 60000 });
  const result = await post('/api/simulate', { id: 'stale-http', userId: 'sim-stale', text: '!vote a', timestamp: 1 });
  assert.equal(result.status, 400);
  assert.equal(result.body.code, 'stale_event');
  assert.equal(result.body.state.vote.total, 0);
});

test('cross-origin writes, missing custom header, invalid host and content type are blocked', async () => {
  assert.equal((await post('/api/reset', {}, { Origin: 'https://example.org' })).status, 403);
  assert.equal((await post('/api/reset', {}, { 'X-Board-Client': '' })).status, 403);
  assert.equal((await post('/api/reset', {}, { 'Content-Type': 'text/plain' })).status, 415);
  // Node fetch normalizes Host, so use the HTTP client to send the actual header.
  const status = await new Promise((resolve, reject) => {
    const request = httpRequest(base + '/api/state', { headers: { Host: 'example.org' } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
    request.end();
  });
  assert.equal(status, 403);
});

test('malformed JSON and nonobject payloads return actionable errors without crashing', async () => {
  for (const body of ['{broken', '[]', 'null', '"string"']) {
    const response = await fetch(base + '/api/reset', { method: 'POST', headers, body });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, 'bad_request');
  }
  assert.equal((await fetch(base + '/api/state')).status, 200);
});

test('unsupported routes and methods do not expose source, environment or arbitrary files', async () => {
  for (const path of ['/src/server.mjs', '/.env', '/package.json', '/evidence/twitchcon-registered.jpg', '/not-a-page']) {
    assert.equal((await fetch(base + path)).status, 404);
  }
  assert.equal((await fetch(base + '/', { method: 'DELETE' })).status, 405);
  const response = await fetch(base + '/api/state');
  const state = await response.json();
  assert.doesNotMatch(JSON.stringify(state), /sim-1|vote-1|userId|password|access_token/);
});

test('a separate server instance has no inherited votes', async () => {
  const other = createApp();
  await new Promise((resolve) => other.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch(`http://127.0.0.1:${other.address().port}/api/state`);
    const state = await response.json();
    assert.equal(state.vote.total, 0);
    assert.equal(state.realTwitchConnected, false);
  } finally { await new Promise((resolve) => other.close(resolve)); }
});
