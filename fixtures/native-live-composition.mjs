import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import tls from 'node:tls';
import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';

// Actual project module wiring, with *only* external native fetch/ws replaced
// in an isolated test process. This is synthetic composition, never TLS/Twitch
// or an actual human/account grant. Run with --experimental-test-module-mocks.
test('native host wires actual device/vault/coordinator/HTTP/wrapper through scoped post-ack tally and shutdown', async () => {
  const savedFetch = globalThis.fetch;
  const events = [];
  const physicalAttempts = {};
  for (const [name, target, key] of [['netConnect', net.Socket.prototype, 'connect'], ['tlsConnect', tls, 'connect'],
    ['dnsLookup', dns, 'lookup'], ['httpRequest', http, 'request'], ['httpsRequest', https, 'request']]) {
    physicalAttempts[name] = 0;
    mock.method(target, key, () => { physicalAttempts[name] += 1; throw new Error('Physical network is forbidden in this synthetic check.'); });
  }
  let liveSocket;
  let sequence = 0;
  let resolveSubscription;
  const pendingSubscription = new Promise((resolve) => { resolveSubscription = resolve; });
  const identity = { client_id: 'syntheticnative01', user_id: '321', login: 'syntheticowner', scopes: ['user:read:chat'], expires_in: 3600 };
  const subscription = { id: 'synthetic-subscription', type: 'channel.chat.message', version: '1', status: 'enabled',
    condition: { broadcaster_user_id: '321', user_id: '321' }, transport: { method: 'websocket', session_id: 'synthetic-session' } };
  const metadata = (type) => ({ message_id: `synthetic-delivery-${++sequence}`, message_type: type,
    message_timestamp: new Date(Date.now()).toISOString(), ...(type === 'notification' || type === 'revocation' ? { subscription_type: 'channel.chat.message', subscription_version: '1' } : {}) });
  const chat = (text, messageId = `synthetic-chat-${sequence + 1}`) => ({ metadata: metadata('notification'), payload: { subscription,
    event: { broadcaster_user_id: '321', chatter_user_id: '654', message_id: messageId, message: { text, fragments: [] } } } });
  class SyntheticSocket extends EventEmitter {
    constructor(url, options) {
      super(); this.readyState = 0; this.closed = 0; liveSocket = this;
      events.push({ kind: 'socket', url, options });
      setImmediate(() => {
        this.readyState = 1; this.emit('open');
        setImmediate(() => this.frame({ metadata: metadata('session_welcome'), payload: { session: { id: 'synthetic-session', status: 'connected', keepalive_timeout_seconds: 10, reconnect_url: null } } }));
      });
    }
    frame(frame) { this.emit('message', Buffer.from(JSON.stringify(frame)), false); }
    close() { this.closed += 1; this.readyState = 3; this.emit('close'); }
    terminate() { this.close(); }
  }
  const ws = new URL('../vendor/ws/index.js', import.meta.url);
  mock.module(ws, { defaultExport: SyntheticSocket });
  globalThis.fetch = async (url, options) => {
    events.push({ kind: 'fetch', url, method: options.method });
    if (url.endsWith('/oauth2/device')) return new Response(JSON.stringify({ device_code: 'SYNTHETIC_DEVICE_ONLY', user_code: 'TEST1234',
      verification_uri: 'https://www.twitch.tv/activate?public=true&device-code=TEST1234', expires_in: 600, interval: 5 }));
    if (url.endsWith('/oauth2/token')) return new Response(JSON.stringify({ access_token: 'SYNTHETIC_ACCESS_ONLY', refresh_token: 'SYNTHETIC_REFRESH_ONLY',
      expires_in: 3600, scope: ['user:read:chat'], token_type: 'bearer' }));
    if (url.endsWith('/oauth2/validate')) return new Response(JSON.stringify(identity));
    if (url.endsWith('/helix/eventsub/subscriptions')) {
      const body = JSON.parse(options.body);
      assert.deepEqual(body.condition, { broadcaster_user_id: '321', user_id: '321' });
      assert.equal(body.transport.session_id, 'synthetic-session');
      return pendingSubscription;
    }
    assert.fail('Unexpected external-port URL.');
  };
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.parse('2026-10-26T12:00:00Z') });
  const flush = () => new Promise((resolve) => setImmediate(resolve));
  const until = async (predicate) => { for (let i = 0; i < 100; i += 1) { if (predicate()) return; await flush(); } assert.fail('Synthetic composition did not settle.'); };
  const abort = new AbortController();
  let host;
  try {
    const { createNativeLiveHost } = await import('../src/native-live-host.mjs?synthetic-composition');
    host = createNativeLiveHost({ clientId: identity.client_id, channelLogin: identity.login, signal: abort.signal,
      onPrivatePrompt(prompt) { assert.equal(prompt.userCode, 'TEST1234'); events.push({ kind: 'private-prompt' }); } });
    const pending = host.start();
    await until(() => events.some((value) => value.kind === 'private-prompt'));
    mock.timers.tick(5000);
    await until(() => liveSocket !== undefined);
    const started = await pending;
    assert.equal(started.ok, true);
    // Flow completion/stop must not retire the retained coordinator handle.
    await until(() => events.some((value) => value.url?.endsWith('/helix/eventsub/subscriptions')));
    host.openVote();
    assert.equal(host.getState().phase, 'subscribing');
    liveSocket.frame(chat('!vote a', 'synthetic-preack'));
    for (let i = 0; i < 5; i += 1) await flush();
    assert.equal(host.getState().vote.total, 0);
    resolveSubscription(new Response(JSON.stringify({ data: [subscription] }), { status: 202 }));
    await until(() => host.getState().phase === 'receiving');
    assert.equal(host.getState().channelId, '321');
    liveSocket.frame(chat('!vote a', 'synthetic-afterack'));
    await until(() => host.getState().vote.total === 1);
    liveSocket.frame(chat('!vote b', 'synthetic-afterack'));
    for (let i = 0; i < 5; i += 1) await flush();
    assert.deepEqual(host.getState().vote.counts, { a: 1, b: 0 });
    liveSocket.frame(chat('!vote b', 'synthetic-changed'));
    await until(() => host.getState().vote.counts.b === 1);
    liveSocket.frame(chat('!source', 'synthetic-source'));
    await until(() => host.getState().sourceCue.active);
    liveSocket.frame({ metadata: metadata('revocation'), payload: { subscription: { ...subscription, status: 'authorization_revoked' } } });
    await until(() => host.getState().phase === 'revoked');
    assert.equal(host.getState().realTwitchConnected, false);
    assert.equal(host.getState().authorizationVerified, false);
    assert.equal(host.getState().sourceCue.active, false);
    assert.ok(liveSocket.closed >= 1);
    liveSocket.frame(chat('!vote a', 'synthetic-retired'));
    for (let i = 0; i < 5; i += 1) await flush();
    assert.deepEqual(host.getState().vote.counts, { a: 0, b: 1 });
    assert.doesNotMatch(JSON.stringify(host.getState()), /SYNTHETIC_(ACCESS|REFRESH|DEVICE)_ONLY|TEST1234|654|synthetic-afterack/);
    assert.equal(events.filter((value) => value.url?.endsWith('/oauth2/validate')).length, 1);
    assert.equal(events.find((value) => value.kind === 'socket').url, 'wss://eventsub.wss.twitch.tv/ws');
    assert.deepEqual(physicalAttempts, { netConnect: 0, tlsConnect: 0, dnsLookup: 0, httpRequest: 0, httpsRequest: 0 });
  } finally {
    abort.abort(); await host?.stop();
    mock.timers.reset(); mock.restoreAll(); globalThis.fetch = savedFetch;
  }
});
