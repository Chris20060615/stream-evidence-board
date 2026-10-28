import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';

// Installed Twurple classes are real; only external fetch/WebSocket are replaced.
// This proves local SDK wiring, never Twitch/TLS/account/OBS operation.
test('actual SDK device grant, bound identity, subscription acknowledgement, tally, refresh and retirement', async () => {
  const physicalAttempts = {};
  for (const [name, target, key] of [['netConnect', net.Socket.prototype, 'connect'], ['tlsConnect', tls, 'connect'],
    ['dnsLookup', dns, 'lookup'], ['httpRequest', http, 'request'], ['httpsRequest', https, 'request']]) {
    physicalAttempts[name] = 0;
    mock.method(target, key, () => { physicalAttempts[name] += 1; throw new Error('Physical network forbidden in synthetic composition.'); });
  }
  const savedFetch = globalThis.fetch;
  const sockets = [];
  const routes = [];
  let pendingPolls = 1;
  let refreshes = 0;
  let wrongIdentity = false;
  let holdValidate = false;
  let resolveValidation;
  let resolveSubscription;
  let sequence = 0;
  let grants = 0;
  let privatePrompts = 0;
  const identity = { client_id: 'syntheticsdk01', user_id: '321', login: 'syntheticowner', scopes: ['user:read:chat'], expires_in: 120 };
  const subscription = { id: 'synthetic-subscription', type: 'channel.chat.message', version: '1', status: 'enabled',
    condition: { broadcaster_user_id: '321', user_id: '321' }, transport: { method: 'websocket', session_id: 'synthetic-session' },
    created_at: '2026-10-27T00:00:00Z', cost: 0 };
  const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
  const metadata = (type) => ({ message_id: `synthetic-delivery-${++sequence}`, message_type: type,
    message_timestamp: new Date(Date.now()).toISOString(), subscription_type: 'channel.chat.message', subscription_version: '1' });
  const welcome = () => ({ metadata: metadata('session_welcome'), payload: { session: {
    id: 'synthetic-session', status: 'connected', keepalive_timeout_seconds: 600, reconnect_url: null } } });
  const chat = (text, id = `synthetic-chat-${sequence + 1}`) => ({ metadata: metadata('notification'), payload: { subscription,
    event: { broadcaster_user_id: '321', broadcaster_user_login: 'syntheticowner', chatter_user_id: '654', message_id: id,
      message: { text, fragments: [] }, badges: [], cheer: null, reply: null, channel_points_custom_reward_id: null } } });
  class SyntheticSocket {
    constructor(url) { assert.equal(url, 'wss://eventsub.wss.twitch.tv/ws'); this.readyState = 0; this.closed = 0; sockets.push(this); }
    open() { this.readyState = 1; this.onopen?.({}); }
    frame(value) { this.onmessage?.({ data: JSON.stringify(value) }); }
    close() { this.closed += 1; this.readyState = 3; this.onclose?.({ code: 1000, reason: '', wasClean: true }); }
    terminate() { this.readyState = 3; }
  }
  mock.module('@d-fischer/isomorphic-ws', { namedExports: { WebSocket: SyntheticSocket, Server: class {} } });
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input);
    routes.push(url.pathname);
    assert.equal(url.searchParams.has('client_secret'), false);
    assert.ok(['id.twitch.tv', 'api.twitch.tv'].includes(url.hostname));
    if (url.pathname === '/oauth2/device') {
      assert.equal(url.searchParams.get('scopes'), 'user:read:chat');
      return response({ device_code: 'SYNTHETIC_DEVICE_ONLY', user_code: 'TEST1234',
        verification_uri: 'https://www.twitch.tv/activate?device-code=TEST1234', expires_in: 600, interval: 5 });
    }
    if (url.pathname === '/oauth2/token') {
      if (url.searchParams.get('grant_type') === 'refresh_token') refreshes += 1;
      else {
        grants += 1;
        if (pendingPolls-- > 0) return response({ status: 400, message: 'authorization_pending' }, 400);
      }
      return response({ access_token: 'SYNTHETIC_ACCESS_ONLY', refresh_token: 'SYNTHETIC_REFRESH_ONLY',
        expires_in: 120, scope: ['user:read:chat'], token_type: 'bearer' });
    }
    if (url.pathname === '/oauth2/validate') {
      if (holdValidate) return new Promise((resolve) => { resolveValidation = () => resolve(response(identity)); });
      return response({ ...identity, ...(wrongIdentity ? { login: 'syntheticother' } : {}) });
    }
    if (url.pathname === '/helix/eventsub/subscriptions') {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.condition, subscription.condition);
      assert.equal(body.transport.session_id, 'synthetic-session');
      return new Promise((resolve) => { resolveSubscription = () => resolve(response({ data: [subscription], total: 1, total_cost: 0, max_total_cost: 10 }, 202)); });
    }
    assert.fail('Unexpected synthetic SDK route.');
  };
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-27T00:00:00Z') });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const until = async (predicate) => { for (let i = 0; i < 100; i += 1) { if (predicate()) return; await flush(); } assert.fail('Synthetic SDK composition did not settle.'); };
  const config = (abort) => ({ clientId: identity.client_id, channelLogin: identity.login, signal: abort.signal,
    onPrivatePrompt(prompt) { privatePrompts += 1; assert.equal(prompt.userCode, 'TEST1234'); assert.equal(prompt.verificationUri.startsWith('https://www.twitch.tv/activate'), true); } });
  let host;
  let wrongHost;
  try {
    const { createTwurpleLiveHost } = await import('../src/twurple-live-host.mjs');
    host = createTwurpleLiveHost(config(new AbortController()));
    const starting = host.start();
    await until(() => privatePrompts === 1); await flush(); mock.timers.tick(5000);
    await until(() => grants === 1); await flush(); mock.timers.tick(5000);
    await until(() => sockets.length === 1);
    assert.equal((await starting).ok, true);
    const socket = sockets[0]; socket.open(); socket.frame(welcome());
    await until(() => resolveSubscription !== undefined);
    host.openVote();
    assert.equal(host.getState().realTwitchConnected, false);
    socket.frame(chat('!vote a', 'synthetic-preack'));
    assert.equal(host.getState().vote.total, 0);
    resolveSubscription(); await until(() => host.getState().realTwitchConnected);
    socket.frame(chat('!vote a', 'synthetic-first')); await until(() => host.getState().vote.total === 1);
    socket.frame(chat('!vote b', 'synthetic-first')); await flush();
    assert.deepEqual(host.getState().vote.counts, { a: 1, b: 0 });
    socket.frame(chat('!vote b', 'synthetic-change')); await until(() => host.getState().vote.counts.b === 1);
    socket.frame(chat('!source', 'synthetic-source')); await until(() => host.getState().sourceCue.active);
    assert.equal(host.markSource(2, 'viewed').ok, true);
    assert.equal(host.getState().sourceReviews[1].status, 'viewed');
    assert.equal(host.getState().timestampBasis, 'host-receive-time');
    assert.doesNotMatch(JSON.stringify(host.getState()), /SYNTHETIC_ACCESS|SYNTHETIC_REFRESH|SYNTHETIC_DEVICE|TEST1234|654|synthetic-first/);
    // Near expiry must invoke the SDK refresh, then pause until validation. A
    // socket-ready callback during that await cannot re-enable admission.
    holdValidate = true; mock.timers.tick(90_000);
    await until(() => resolveValidation !== undefined);
    assert.equal(refreshes, 1); assert.equal(host.getState().authorizationVerified, false);
    socket.frame(welcome()); socket.frame(chat('!vote a', 'synthetic-during-validation'));
    assert.equal(host.getState().realTwitchConnected, false);
    assert.deepEqual(host.getState().vote.counts, { a: 0, b: 1 });
    holdValidate = false; resolveValidation(); await until(() => host.getState().realTwitchConnected);
    // Advance Date without delivering timers: synchronous expiry admission
    // checks must hold even after process sleep/resume.
    const beforeExpiry = Date.now(); mock.timers.setTime(beforeExpiry + 121_000);
    socket.frame(chat('!vote a', 'synthetic-after-expiry'));
    assert.equal(host.getState().authorizationVerified, false);
    assert.equal(host.getState().realTwitchConnected, false);
    socket.frame({ metadata: metadata('revocation'), payload: { subscription: { ...subscription, status: 'authorization_revoked' } } });
    await until(() => host.getState().phase === 'revoked');
    assert.ok(socket.closed >= 1);
    assert.equal(host.getState().sourceCue.active, false);
    // A genuine SDK validate mismatch must fail before constructing another WS.
    wrongIdentity = true; pendingPolls = 0;
    wrongHost = createTwurpleLiveHost(config(new AbortController()));
    const wrongStarting = wrongHost.start(); await until(() => privatePrompts === 2); await flush(); mock.timers.tick(5000);
    assert.equal((await wrongStarting).ok, false);
    assert.equal(sockets.length, 1);
    assert.equal(wrongHost.getState().realTwitchConnected, false);
    for (const count of Object.values(physicalAttempts)) assert.equal(count, 0);
    assert.ok(routes.includes('/oauth2/validate')); assert.ok(routes.includes('/helix/eventsub/subscriptions'));
  } finally {
    await host?.stop(); await wrongHost?.stop(); globalThis.fetch = savedFetch; mock.timers.reset(); mock.restoreAll();
  }
});
