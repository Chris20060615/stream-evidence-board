import { RefreshingAuthProvider, getTokenInfo } from '@twurple/auth';
import { ApiClient } from '@twurple/api';
import { EventSubWsListener } from '@twurple/eventsub-ws';
import { createLiveTally } from './live-tally.mjs';

const scope = Object.freeze(['user:read:chat']);
const silentLogger = Object.freeze({ custom: () => {} });
const mockConfigured = () => Object.hasOwn(process.env, 'TWURPLE_MOCK_API_PORT');

// Concrete installed Twurple8.2 integration. The reviewed terminal owns start;
// factory/help remain inert. No credential file, OAuth secret, chat sender or
// raw SDK error/logger output is exposed. SDK I/O itself is not AbortSignal-
// aware: cancellation retires this host and removes late-added SDK users, but
// cannot promise physical request cancellation or secure memory erasure.
export function createTwurpleLiveHost({ clientId, channelLogin, onPrivatePrompt, signal }) {
  if (mockConfigured()) throw new Error('mock_configuration_not_allowed');
  if (typeof clientId !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(clientId)
    || typeof channelLogin !== 'string' || !/^[a-z0-9_]{1,25}$/.test(channelLogin)
    || typeof onPrivatePrompt !== 'function' || !(signal instanceof AbortSignal)) throw new Error('invalid_public_configuration');
  const auth = new RefreshingAuthProvider({ clientId });
  const tally = createLiveTally();
  const owned = new AbortController();
  const hooks = [];
  let listener = null;
  let subscription = null;
  let userId = null;
  let stopped = false;
  let started = false;
  let phase = 'idle';
  let identityVerified = false;
  let socketReady = false;
  let acknowledged = false;
  let tokenExpiresAt = null;
  let validationTimer;
  const active = () => !stopped && !owned.signal.aborted && !signal.aborted && !mockConfigured();
  const authorized = () => active() && identityVerified && Date.now() < tokenExpiresAt;
  const receiving = () => authorized() && socketReady && acknowledged && phase === 'receiving';
  function clean(reason = 'stopped') {
    if (stopped) return;
    stopped = true; phase = reason; socketReady = acknowledged = identityVerified = false;
    clearTimeout(validationTimer); owned.abort();
    try { listener?.stop(); } catch { /* SDK raw diagnostics stay private. */ }
    for (const hook of hooks) try { hook.unbind(); } catch { /* Captured SDK hook only. */ }
    hooks.length = 0;
    if (userId) auth.removeUser(userId);
    listener = subscription = null;
    tally.state(false);
    signal.removeEventListener('abort', cancel);
  }
  function cancel() { clean('cancelled'); }
  signal.addEventListener('abort', cancel, { once: true });
  function ensure() { if (!active()) throw new Error('inactive'); }
  function bounded(operation, timeoutMs = 15_000, late) {
    ensure();
    return new Promise((resolve, reject) => {
      let done = false;
      const finish = (error, value) => {
        if (done) return;
        done = true; clearTimeout(timer); owned.signal.removeEventListener('abort', cancelled);
        if (error) reject(error); else resolve(value);
      };
      const cancelled = () => finish(new Error('inactive'));
      const timer = setTimeout(() => finish(new Error('operation_timeout')), timeoutMs);
      owned.signal.addEventListener('abort', cancelled, { once: true });
      Promise.resolve().then(() => { ensure(); return operation(); }).then((value) => {
        if (done || !active()) { try { late?.(value); } catch { /* Late private cleanup only. */ } if (!done) cancelled(); return; }
        finish(null, value);
      }, (error) => finish(error));
      if (!active()) cancelled();
    });
  }
  function delay(milliseconds) {
    return bounded(() => new Promise((resolve) => {
      const finish = () => { clearTimeout(timer); owned.signal.removeEventListener('abort', finish); resolve(); };
      const timer = setTimeout(finish, milliseconds);
      owned.signal.addEventListener('abort', finish, { once: true });
    }), milliseconds + 1000);
  }
  function pollStatus(error) {
    try {
      if (error?.statusCode !== 400 || typeof error.body !== 'string' || error.body.length > 65_536) return null;
      const body = JSON.parse(error.body);
      const value = body.error ?? body.message;
      return value === 'authorization_pending' || value === 'slow_down' ? value : null;
    } catch { return null; }
  }
  async function validateIdentity(forceRefresh = false) {
    identityVerified = false;
    let token;
    try {
      token = await bounded(() => forceRefresh ? auth.refreshAccessTokenForUser(userId) : auth.getAccessTokenForUser(userId, scope));
      const info = await bounded(() => getTokenInfo(token.accessToken, clientId));
      const expiresAt = info.expiryDate?.getTime();
      if (info.clientId !== clientId || info.userId !== userId || info.userName !== channelLogin
        || info.scopes.length !== 1 || info.scopes[0] !== scope[0] || !Number.isSafeInteger(expiresAt)
        || expiresAt - Date.now() < 30_000) throw new Error('identity_mismatch');
      tokenExpiresAt = expiresAt; identityVerified = true;
    } finally { token = null; }
  }
  function scheduleValidation() {
    clearTimeout(validationTimer);
    validationTimer = setTimeout(async () => {
      if (!active()) return;
      phase = 'revalidating';
      try { await validateIdentity(tokenExpiresAt - Date.now() <= 60_000); ensure(); phase = socketReady && acknowledged ? 'receiving' : 'connecting'; scheduleValidation(); }
      catch { clean('validation_failed'); }
    }, Math.min(3_600_000, Math.max(1000, tokenExpiresAt - Date.now() - 30_000)));
  }
  async function start() {
    if (!active()) return { ok: false, code: 'cancelled' };
    if (started) return { ok: false, code: 'already_started' };
    started = true; phase = 'authorizing';
    let device;
    try {
      const requestedAt = Date.now();
      device = await bounded(() => auth.startDeviceCodeFlow([...scope]));
      const uri = new URL(device.verificationUri);
      if (typeof device.deviceCode !== 'string' || device.deviceCode.length > 4096 || !device.deviceCode.length
        || typeof device.userCode !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(device.userCode)
        || uri.protocol !== 'https:' || uri.hostname !== 'www.twitch.tv' || uri.pathname !== '/activate' || uri.username || uri.password || uri.port
        || !Number.isSafeInteger(device.expiresIn) || device.expiresIn < 1 || device.expiresIn > 3600
        || (device.interval !== undefined && (!Number.isSafeInteger(device.interval) || device.interval < 1 || device.interval > 3600))) throw new Error('invalid_device_response');
      const expiresAt = requestedAt + device.expiresIn * 1000;
      let interval = Math.max(5, device.interval ?? 5) * 1000;
      await bounded(() => onPrivatePrompt(Object.freeze({ userCode: device.userCode, verificationUri: uri.href, expiresAt })));
      for (;;) {
        if (Date.now() + interval >= expiresAt) throw new Error('device_expired');
        await delay(interval); ensure();
        try {
          userId = await bounded(() => auth.addUserForDeviceCode(device.deviceCode, [...scope]),
            Math.min(15_000, expiresAt - Date.now()), (lateId) => { if (typeof lateId === 'string') auth.removeUser(lateId); });
          break;
        } catch (error) {
          const status = pollStatus(error);
          if (!status) throw error;
          if (status === 'slow_down') interval += 5000;
        }
      }
      device = null;
      if (typeof userId !== 'string' || !/^[1-9][0-9]{0,24}$/.test(userId)) throw new Error('invalid_user');
      await validateIdentity(); ensure();
      const api = new ApiClient({ authProvider: auth, logger: silentLogger, fetchOptions: { signal: owned.signal, redirect: 'error' } });
      listener = new EventSubWsListener({ apiClient: api, logger: silentLogger, url: 'wss://eventsub.wss.twitch.tv/ws' });
      hooks.push(listener.onUserSocketReady((id) => { if (active() && id === userId) { socketReady = true; phase = acknowledged ? 'receiving' : 'subscribing'; } }));
      hooks.push(listener.onUserSocketDisconnect((id) => { if (active() && id === userId) { socketReady = acknowledged = false; phase = 'connecting'; tally.state(false); } }));
      hooks.push(listener.onSubscriptionCreateSuccess((selected, data) => {
        if (!active() || selected !== subscription) return;
        if (data.status !== 'enabled' || data.type !== 'channel.chat.message' || data.transportMethod !== 'websocket'
          || data.condition.broadcaster_user_id !== userId || data.condition.user_id !== userId) { clean('subscription_mismatch'); return; }
        acknowledged = true; phase = socketReady ? 'receiving' : 'connecting';
      }));
      hooks.push(listener.onSubscriptionCreateFailure((selected) => { if (selected === subscription) clean('subscription_failed'); }));
      hooks.push(listener.onRevoke((selected) => { if (selected === subscription) clean('revoked'); }));
      hooks.push(auth.onRefreshFailure((id) => { if (id === userId) clean('refresh_failed'); }));
      subscription = listener.onChannelChatMessage(userId, userId, (event) => {
        if (!receiving() || event.broadcasterId !== userId || (event.sourceBroadcasterId && event.sourceBroadcasterId !== userId)) return;
        // The SDK's public chat event omits the envelope timestamp. The voting
        // window explicitly uses host receive time, never a fabricated Twitch timestamp.
        tally.accept({ id: event.messageId, userId: event.chatterId, text: event.messageText, timestamp: Date.now() }, true);
      });
      phase = 'connecting'; listener.start(); scheduleValidation();
      return { ok: true, code: 'session_starting', realTwitchConnected: receiving() };
    } catch { clean(signal.aborted ? 'cancelled' : 'start_failed'); return { ok: false, code: signal.aborted ? 'cancelled' : 'authorization_or_session_failed' }; }
    finally { device = null; }
  }
  function getState() {
    if (!stopped && mockConfigured()) clean('mock_configuration_not_allowed');
    const connected = receiving();
    return { mode: 'twitch-own-channel', backend: 'twurple8.2.0', phase, channelLogin, channelId: userId,
      sampledAt: Date.now(), timestampBasis: 'host-receive-time', realTwitchConnected: connected,
      authorizationVerified: authorized(), connection: { status: connected ? 'connected' : 'disconnected' },
      ...tally.state(connected), limitation: 'SDK reconnect and refresh; receive-time vote window. Delayed messages can cross a round boundary; no missed-message replay or permanent exactly-once guarantee.' };
  }
  return Object.freeze({ start, getState, stop: async () => { clean(); },
    openVote: (durationMs) => stopped ? { ok: false, code: 'stopped' } : tally.open(durationMs),
    closeVote: () => stopped ? { ok: false, code: 'stopped' } : tally.close(),
    reset: () => stopped ? { ok: false, code: 'stopped' } : tally.reset(),
    markSource: (sourceNumber, status) => stopped ? { ok: false, code: 'stopped' } : tally.markSource(sourceNumber, status) });
}
