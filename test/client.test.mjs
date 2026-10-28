import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createBoard } from '../src/engine.mjs';

// Contract checks with a minimal fake DOM, not a browser rendering or Twitch test.
class Element {
  constructor(id = '') {
    this.id = id;
    this._textContent = '';
    this.textContentWrites = 0;
    this.value = '';
    this.disabled = false;
    this.children = [];
    this.listeners = new Map();
    const classes = new Set();
    this.classList = {
      add: (...names) => names.forEach((name) => classes.add(name)),
      remove: (...names) => names.forEach((name) => classes.delete(name)),
      contains: (name) => classes.has(name),
      toggle: (name, enabled) => {
        const shouldEnable = enabled ?? !classes.has(name);
        if (shouldEnable) classes.add(name); else classes.delete(name);
        return shouldEnable;
      },
    };
  }
  get textContent() { return this._textContent; }
  set textContent(value) { this._textContent = value; this.textContentWrites += 1; }
  set innerHTML(_) { throw new Error('Client must render data as text, never innerHTML.'); }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  emit(name) { return this.listeners.get(name)?.({ preventDefault() {} }); }
  prepend(child) { child.parent = this; this.children.unshift(child); }
  get lastElementChild() { return this.children.at(-1); }
  remove() { this.parent.children.splice(this.parent.children.indexOf(this), 1); }
}

const response = (data, ok = true, status = ok ? 200 : 400) => ({ ok, status, json: async () => data });
const flush = () => new Promise((resolve) => setImmediate(resolve));

async function harness(script = 'app.mjs', initialResponses = []) {
  const html = await readFile(new URL(`../public/${script === 'app.mjs' ? 'index' : 'overlay'}.html`, import.meta.url), 'utf8');
  const source = await readFile(new URL(`../public/${script}`, import.meta.url), 'utf8');
  const elements = new Map([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => [match[1], new Element(match[1])]));
  if (elements.has('viewer')) elements.get('viewer').value = 'sim-viewer-1';
  if (elements.has('command')) elements.get('command').value = '!vote a';
  const queue = [...initialResponses];
  const requests = [];
  const timers = new Map();
  let timerId = 0;
  let localTime;
  class LocalDate extends Date { static now() { return localTime ?? Date.now(); } }
  const missingIds = [];
  let uuid = 0;
  const context = vm.createContext({
    document: {
      getElementById(id) {
        if (!elements.has(id)) missingIds.push(id);
        return elements.get(id) ?? null;
      },
      createElement: () => new Element(),
    },
    crypto: { randomUUID: () => `sim-event-${++uuid}` },
    fetch: async (path, options) => {
      requests.push({ path, options });
      if (!queue.length) throw new Error('Test response queue exhausted.');
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    setTimeout: (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    AbortController,
    console,
    Date: LocalDate,
  });
  vm.runInContext(source, context, { filename: script });
  await flush();
  return {
    elements,
    requests,
    missingIds,
    enqueue: (...items) => queue.push(...items),
    setNow: (time) => { localTime = time; },
    async tick() {
      const entry = [...timers].filter(([, timer]) => timer.delay === 500)[0];
      assert.ok(entry, 'poll timer is registered');
      timers.delete(entry[0]);
      await entry[1].callback(); await flush();
    },
    async fireTimer(delay) {
      const entry = [...timers].find(([, timer]) => delay === 'cue' ? timer.delay > 5000 : timer.delay === delay);
      assert.ok(entry, `timer ${delay} is registered`);
      timers.delete(entry[0]);
      await entry[1].callback(); await flush();
    },
    async emit(id, event = 'click') { await elements.get(id).emit(event); await flush(); },
  };
}

function boardState({ connected = true, open = true, vote = false } = {}) {
  const board = createBoard();
  if (connected) board.setConnection('connected');
  if (open) board.openVote();
  if (vote) board.processEvent({ id: 'existing', userId: 'existing-viewer', text: '!vote a', origin: 'simulated' });
  return board.getState();
}

test('controller uses real HTML selectors and renders claim/source as plain text', async () => {
  const state = structuredClone(boardState({ vote: true }));
  state.card.claim = '<img src=x onerror=alert(1)>';
  const app = await harness('app.mjs', [response(state)]);
  assert.deepEqual(app.missingIds, []);
  assert.equal(app.elements.get('claim').textContent, state.card.claim);
  assert.equal(app.elements.get('source-link').href, state.card.source.url);
  assert.equal(app.elements.get('count-a').textContent, '1');
  assert.equal(app.elements.get('bar-a').value, 100);
  assert.equal(app.elements.get('bar-b').value, 0);
  assert.match(app.elements.get('total').textContent, /1 simulated voter$/);
  assert.match(app.elements.get('sync').textContent, /Twitch not connected/);
});

test('controller action network failure retains stale warning through finally, then poll recovers', async () => {
  const state = boardState();
  const app = await harness('app.mjs', [response(state), new Error('network down')]);
  await app.emit('connect');
  assert.match(app.elements.get('sync').textContent, /unavailable.*stale/);
  assert.equal(app.elements.get('connection').textContent, 'Local connection lost');
  assert.equal(app.elements.get('timer').textContent, 'State unavailable');
  assert.equal(app.elements.get('open').disabled, true);
  assert.equal(app.elements.get('close').disabled, true);
  assert.equal(app.elements.get('replay').disabled, true);
  assert.equal(app.elements.get('connection-dot').classList.contains('connected'), false);
  app.enqueue(response(state));
  await app.tick();
  assert.match(app.elements.get('sync').textContent, /reachable/);
  assert.equal(app.elements.get('connection').textContent, 'Simulator connected');
});

test('controller marks HTTP state errors unavailable even when response has an error code', async () => {
  const app = await harness('app.mjs', [response(boardState()), response({ ok: false, code: 'internal_error' }, false, 500)]);
  await app.tick();
  assert.match(app.elements.get('sync').textContent, /unavailable.*stale/);
  assert.equal(app.elements.get('timer').textContent, 'State unavailable');
});

test('replay sends the identical simulated event ID, viewer, command and original timestamp', async () => {
  const state = boardState();
  const app = await harness('app.mjs', [
    response(state),
    response({ ok: true, code: 'vote_recorded', message: 'Simulated vote recorded.', state }),
    response({ ok: false, code: 'duplicate_event', message: 'Already processed.', state }, false),
  ]);
  await app.emit('command-form', 'submit');
  await app.emit('replay');
  const posts = app.requests.filter((request) => request.options.method === 'POST');
  assert.equal(posts.length, 2);
  const first = JSON.parse(posts[0].options.body);
  const replay = JSON.parse(posts[1].options.body);
  assert.deepEqual(replay, first);
  assert.equal(first.origin, 'simulated');
  assert.equal(first.userId, 'sim-viewer-1');
  assert.equal(first.text, '!vote a');
  assert.equal(Number.isSafeInteger(first.timestamp), true);
  assert.match(app.elements.get('feedback').textContent, /^duplicate_event/);
  assert.equal(app.elements.get('feedback').classList.contains('error'), true);
});

test('an older poll cannot overwrite a newer acknowledged controller action', async () => {
  let releaseInitialPoll;
  const olderPoll = new Promise((resolve) => { releaseInitialPoll = resolve; });
  const connected = boardState({ open: false });
  const app = await harness('app.mjs', [olderPoll, response({ ok: true, code: 'connection_changed', state: connected })]);
  await app.emit('connect');
  releaseInitialPoll(response(boardState({ connected: false, open: false })));
  await flush();
  assert.equal(app.elements.get('connection').textContent, 'Simulator connected');
});

test('overlay renders matching selectors and marks failure stale before recovering', async () => {
  const state = boardState({ vote: true });
  const overlay = await harness('overlay.mjs', [response(state), new Error('network down'), response(state)]);
  assert.deepEqual(overlay.missingIds, []);
  assert.equal(overlay.elements.get('overlay-count-a').textContent, '1');
  assert.equal(overlay.elements.get('overlay-source').href, state.card.source.url);
  assert.match(overlay.elements.get('overlay-connection').textContent, /real Twitch pending/);
  await overlay.tick();
  assert.match(overlay.elements.get('overlay-connection').textContent, /LOCAL CONNECTION LOST.*stale/);
  assert.equal(overlay.elements.get('overlay-phase').textContent, 'State unavailable');
  await overlay.tick();
  assert.match(overlay.elements.get('overlay-connection').textContent, /real Twitch pending/);
  assert.equal(overlay.elements.get('overlay-count-a').textContent, '1');
});

function sourceState() {
  const board = createBoard();
  board.setConnection('connected');
  board.processEvent({ id: 'synthetic-source-cue', userId: 'synthetic-source-viewer', text: '!source', origin: 'simulated' });
  return board.getState();
}

for (const script of ['app.mjs', 'overlay.mjs']) {
  const prefix = script === 'app.mjs' ? '' : 'overlay-';
  const cueId = prefix + 'source-cue';
  const panelId = prefix + 'source-panel';
  const linkId = script === 'app.mjs' ? 'source-link' : 'overlay-source';

  test(`${script}: source cue labels synthetic activity once and hides at an expired snapshot without removing source`, async () => {
    const active = sourceState();
    const expired = structuredClone(active);
    expired.sourceCue = { ...active.sourceCue, active: false, requestedAt: null, expiresAt: null };
    const client = await harness(script, [response(active), response(active), response(expired)]);
    const cue = client.elements.get(cueId);
    assert.deepEqual(client.missingIds, []);
    assert.equal(cue.hidden, false);
    assert.match(cue.textContent, /Simulated source request.*locally/);
    assert.equal(client.elements.get(panelId).classList.contains('source-requested'), true);
    const writes = cue.textContentWrites;
    await client.tick();
    assert.equal(cue.textContentWrites, writes, 'unchanged polls must not repeatedly rewrite the live cue');
    await client.tick();
    assert.equal(cue.hidden, true);
    assert.equal(cue.textContent, '');
    assert.equal(client.elements.get(panelId).classList.contains('source-requested'), false);
    assert.equal(client.elements.get(linkId).href, active.card.source.url);
  });

  test(`${script}: network loss immediately hides cue and recovery respects disconnected state`, async () => {
    const active = sourceState();
    const disconnected = structuredClone(active);
    disconnected.connection.status = 'disconnected';
    const client = await harness(script, [response(active), new Error('network down'), response(disconnected)]);
    await client.tick();
    assert.equal(client.elements.get(cueId).hidden, true);
    assert.equal(client.elements.get(panelId).classList.contains('source-requested'), false);
    assert.equal(client.elements.get(linkId).href, active.card.source.url);
    await client.tick();
    assert.equal(client.elements.get(cueId).hidden, true, 'an inconsistent active flag may not override disconnected state');
  });

  test(`${script}: an unverified cue origin never gets the simulated-request badge`, async () => {
    const state = structuredClone(sourceState());
    state.sourceCue.origin = 'eventsub-unverified';
    const client = await harness(script, [response(state)]);
    assert.equal(client.elements.get(cueId).hidden, true);
    assert.equal(client.elements.get(panelId).classList.contains('source-requested'), false);
  });

  test(`${script}: a hanging state request times out and hides the active cue`, async () => {
    const active = sourceState();
    const never = new Promise(() => {});
    const client = await harness(script, [response(active), never]);
    const polling = client.tick();
    await flush();
    assert.equal(client.elements.get(cueId).hidden, false);
    await client.fireTimer(5000);
    await polling;
    assert.equal(client.elements.get(cueId).hidden, true);
    const statusId = script === 'app.mjs' ? 'sync' : 'overlay-connection';
    assert.match(client.elements.get(statusId).textContent, /unavailable|LOCAL CONNECTION LOST/);
  });

  test(`${script}: local deadline hides the cue even before the next state poll`, async () => {
    const active = sourceState();
    const client = await harness(script, [response(active), response(active)]);
    client.setNow(active.sourceCue.expiresAt);
    await client.fireTimer('cue');
    assert.equal(client.elements.get(cueId).hidden, true);
    await client.tick();
    assert.equal(client.elements.get(cueId).hidden, true, 'a stale active flag may not revive an expired cue');
    assert.equal(client.elements.get(linkId).href, active.card.source.url);
  });
}

test('an older failed poll cannot suppress a newer confirmed action and cue', async () => {
  let releaseOld;
  const old = new Promise((resolve) => { releaseOld = resolve; });
  const active = sourceState();
  const app = await harness('app.mjs', [old, response({ ok: true, code: 'source', state: active })]);
  await app.emit('connect');
  releaseOld(response({ ok: false, code: 'internal_error' }, false, 500));
  await flush();
  assert.match(app.elements.get('sync').textContent, /reachable/);
  assert.equal(app.elements.get('source-cue').hidden, false);
  app.enqueue(new Error('fresh failure'));
  await app.tick();
  assert.match(app.elements.get('sync').textContent, /unavailable/);
  assert.equal(app.elements.get('source-cue').hidden, true);
});

test('retrying an unavailable controller does not temporarily revive a cached source cue', async () => {
  const active = sourceState();
  let releaseRetry;
  const retry = new Promise((resolve) => { releaseRetry = resolve; });
  const app = await harness('app.mjs', [response(active), new Error('network down'), retry]);
  await app.tick();
  const action = app.elements.get('connect').emit('click');
  await flush();
  assert.equal(app.elements.get('source-cue').hidden, true);
  assert.match(app.elements.get('sync').textContent, /unavailable/);
  releaseRetry(response({ ok: true, code: 'source', state: active }));
  await action;
  await flush();
  assert.equal(app.elements.get('source-cue').hidden, false);
});
