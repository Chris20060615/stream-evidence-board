/**
 * Dependency-injected, read-only EventSub transport harness.
 * No default HTTP/WebSocket/OAuth adapter or environment access exists here.
 * Even successful injected adapters NEVER establish verified Twitch provenance:
 * emitted events remain transport-unverified and the existing board rejects them.
 *
 * The future host owns secure authorization and adapter implementation. An opaque
 * credential handle is passed only to validate/subscribe, kept out of callbacks,
 * errors and snapshots, and released by this harness on stop/failure. Adapters
 * must independently release their own references/cancel pending service work.
 * connect() must return a connection whose close() is nonblocking (normally the
 * standard WebSocket close() returning void). The host owns any asynchronous
 * shutdown; a host-supplied never-settling close promise violates this contract
 * and is not covered by the validate/connect/subscribe I/O races below.
 *
 * Lifecycle references, checked 2026-10-25:
 * https://dev.twitch.tv/docs/authentication/validate-tokens/
 * https://dev.twitch.tv/docs/eventsub/handling-websocket-events/
 * https://dev.twitch.tv/docs/api/reference/#create-eventsub-subscription
 *
 * Local restrictions: own channel by default, bounded receipt scanning, pinned
 * read scope/identity, strict local welcome/ack deadlines, no pre-ack chat queue,
 * no delivery during revalidation, and frozen intake on reconnect. A production
 * reconnect needs overlapping sockets; this module does not fake that handover
 * or claim replay of messages lost during an unexpected disconnection.
 */
import { createEventSubInbox } from './eventsub-inbox.mjs';

const numericId = (v) => typeof v === 'string' && /^[1-9][0-9]{0,24}$/.test(v);
const safeId = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(v);
const plain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
  && (Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null);
const TYPE = 'channel.chat.message';
const VERSION = '1';
const IO_TIMEOUT = Object.freeze({ kind: 'harness-timeout' });
const IO_CANCELLED = Object.freeze({ kind: 'harness-cancelled' });

function freezeCopy(value) {
  const copy = structuredClone(value);
  const freeze = (part) => {
    if (part && typeof part === 'object') {
      Object.values(part).forEach(freeze);
      Object.freeze(part);
    }
    return part;
  };
  return freeze(copy);
}

function inspectReceipt(receipt) {
  const queue = [{ value: receipt, depth: 0 }];
  const seen = new WeakSet();
  let nodes = 0;
  try {
    while (queue.length) {
      const { value, depth } = queue.pop();
      if (++nodes > 1_000 || depth > 12) return 'invalid_receipt';
      if (value === null || typeof value === 'boolean') continue;
      if (typeof value === 'number') { if (!Number.isFinite(value)) return 'invalid_receipt'; continue; }
      if (typeof value === 'string') { if (value.length > 65_536) return 'invalid_receipt'; continue; }
      if (typeof value !== 'object' || (!Array.isArray(value) && !plain(value)) || seen.has(value)) return 'invalid_receipt';
      seen.add(value);
      const keys = Reflect.ownKeys(value);
      if (keys.length > 1_000) return 'invalid_receipt';
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const key of keys) {
        if (typeof key !== 'string') return 'invalid_receipt';
        if (/token|authorization|credential|secret|password|cookie|apikey|header|privatekey/.test(key.toLowerCase().replace(/[^a-z0-9]/g, ''))) return 'credential_fields';
        if (!('value' in descriptors[key])) return 'invalid_receipt';
        queue.push({ value: descriptors[key].value, depth: depth + 1 });
      }
    }
    return plain(receipt) && plain(receipt.body) && Number.isInteger(receipt.httpStatus) ? null : 'invalid_receipt';
  } catch { return 'invalid_receipt'; }
}

export function createTwitchSession({
  clientId, broadcasterId, readerId, adapters,
  onEvent = () => {}, onAction = () => {},
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
  welcomeTimeoutMs = 10_000, subscribeWindowMs = 10_000,
  validationIntervalMs = 3_600_000, minTokenRemainingMs = 30_000,
  ioTimeoutMs = 10_000,
  ownChannelOnly = true,
} = {}) {
  if (!safeId(clientId) || !numericId(broadcasterId) || !numericId(readerId)) throw new TypeError('Configured client and user identifiers are invalid.');
  if (typeof ownChannelOnly !== 'boolean' || (ownChannelOnly && broadcasterId !== readerId)) throw new TypeError('Own-channel policy requires matching reader and broadcaster.');
  if (!adapters || ['validate', 'connect', 'subscribe'].some((key) => typeof adapters[key] !== 'function')) throw new TypeError('Explicit validate, connect and subscribe adapters are required.');
  if ([onEvent, onAction, now, setTimer, clearTimer].some((fn) => typeof fn !== 'function')) throw new TypeError('Callbacks, clock and timer hooks must be functions.');
  for (const [name, value, maximum] of [
    ['welcomeTimeoutMs', welcomeTimeoutMs, 10_000], ['subscribeWindowMs', subscribeWindowMs, 10_000],
    ['validationIntervalMs', validationIntervalMs, 3_600_000], ['minTokenRemainingMs', minTokenRemainingMs, Number.MAX_SAFE_INTEGER],
    ['ioTimeoutMs', ioTimeoutMs, 60_000],
  ]) if (!Number.isSafeInteger(value) || value < 1 || value > maximum) throw new RangeError(`${name} is outside its supported integer range.`);

  let generation = 0;
  let active = false;
  let phase = 'idle';
  let credential = null;
  let runController = null;
  let socket = null;
  let closing = Promise.resolve();
  let guard = null;
  let guardClockOverride = null;
  let welcomeRaw = null;
  let welcomeReceivedAt = null;
  let latestPendingKeepalive = null;
  let sessionId = null;
  let welcomeDeadline = null;
  let subscribeDeadline = null;
  let nextValidationAt = null;
  let expiresAt = null;
  let lastCode = 'idle';
  let metrics = { frames: 0, emittedEvents: 0, droppedFrames: 0, rejectedFrames: 0 };
  const timers = new Map();
  const closedConnections = new WeakSet();

  function clock() {
    let time;
    try { time = now(); } catch { throw new RangeError('The injected clock is unavailable.'); }
    if (!Number.isSafeInteger(time) || time < 0) throw new RangeError('now() must return nonnegative safe integer milliseconds.');
    return time;
  }
  const current = (run) => active && generation === run;
  function clearScheduled(name) {
    if (timers.has(name)) clearTimer(timers.get(name));
    timers.delete(name);
  }
  function schedule(name, deadline, callback, afterBoundary = false) {
    clearScheduled(name);
    const run = generation;
    const handle = setTimer(async () => {
      if (!current(run) || timers.get(name) !== handle) return;
      timers.delete(name);
      await callback();
    }, Math.max(1, deadline - clock() + (afterBoundary ? 1 : 0)));
    handle?.unref?.();
    timers.set(name, handle);
  }
  function closeConnection(connection) {
    if (connection && (typeof connection === 'object' || typeof connection === 'function')) {
      if (closedConnections.has(connection)) return Promise.resolve();
      closedConnections.add(connection);
    }
    try { return Promise.resolve(connection?.close()).then(() => undefined, () => undefined); }
    catch { return Promise.resolve(); }
  }
  function finish(nextPhase, code) {
    active = false;
    phase = nextPhase;
    lastCode = code;
    credential = null;
    runController?.abort();
    runController = null;
    for (const name of [...timers.keys()]) clearScheduled(name);
    const oldSocket = socket;
    socket = null;
    guard?.close();
    guard = null;
    guardClockOverride = null;
    welcomeRaw = null;
    latestPendingKeepalive = null;
    sessionId = null;
    welcomeReceivedAt = null;
    welcomeDeadline = null;
    subscribeDeadline = null;
    nextValidationAt = null;
    expiresAt = null;
    closing = closeConnection(oldSocket);
  }
  function checkDeadlines() {
    if (!active) return;
    const time = clock();
    if (expiresAt !== null && time >= expiresAt) { finish('expired', 'expired'); return; }
    if (phase === 'awaiting_welcome' && time >= welcomeDeadline) { finish('timed_out', 'welcome_timeout'); return; }
    if (phase === 'subscribing' && time >= subscribeDeadline) { finish('timed_out', 'window_expired'); return; }
    if (guard?.getState().phase === 'timed_out') { finish('timed_out', 'keepalive_timeout'); return; }
    if (nextValidationAt !== null && time >= nextValidationAt && phase !== 'revalidating') {
      if (phase === 'receiving') void revalidate(generation);
      else finish('failed', 'validation_required');
    }
  }
  function getState() {
    checkDeadlines();
    return freezeCopy({
      mode: 'transport-harness', realTwitchConnected: false, authorizationVerified: false,
      phase, welcomeDeadline, subscribeDeadline,
      keepaliveDeadline: guard?.getState().keepaliveDeadline ?? null,
      nextValidationAt, expiresAt, metrics,
    });
  }
  const result = (ok, code, message) => ({ ok, code, message, state: getState() });
  const inactiveResult = (run) => result(false, generation === run ? lastCode : 'inactive', 'The original harness run is no longer active.');
  function failed(code, nextPhase = 'failed') {
    finish(nextPhase, code);
    return result(false, code, 'Transport harness stopped; no verified Twitch connection was established.');
  }
  function scheduleValidation() {
    const due = Math.min(nextValidationAt, expiresAt);
    schedule('validation', due, async () => { checkDeadlines(); });
  }
  async function callAdapter(name, args, run) {
    const signal = runController.signal;
    const timerName = `io:${name}`;
    let handle;
    let abortListener;
    const cancelled = new Promise((_, reject) => {
      abortListener = () => reject(IO_CANCELLED);
      signal.addEventListener('abort', abortListener, { once: true });
      if (signal.aborted) reject(IO_CANCELLED);
    });
    const timeout = new Promise((_, reject) => {
      handle = setTimer(() => {
        if (!current(run) || timers.get(timerName) !== handle) return;
        timers.delete(timerName);
        reject(IO_TIMEOUT);
      }, ioTimeoutMs);
      // A pending public operation must settle even if an injected adapter
      // owns no event-loop handles. Only background lifecycle timers unref.
      timers.set(timerName, handle);
    });
    try {
      const pending = Promise.resolve().then(() => {
        if (!current(run) || signal.aborted) throw IO_CANCELLED;
        return adapters[name]({ ...args, signal });
      });
      if (name === 'connect') {
        // A host adapter may ignore cancellation. Still close any socket that
        // arrives after its original run has stopped or timed out.
        void pending.then((connection) => { if (!current(run)) return closeConnection(connection); }, () => {});
      }
      return await Promise.race([pending, cancelled, timeout]);
    } finally {
      signal.removeEventListener('abort', abortListener);
      if (timers.get(timerName) === handle) {
        clearTimer(handle);
        timers.delete(timerName);
      }
    }
  }
  function scheduleWatchdog() {
    if (!active || !guard) return;
    schedule('watchdog', guard.getState().keepaliveDeadline, async () => { checkDeadlines(); }, true);
  }
  function checkValidation(receipt) {
    const inspected = inspectReceipt(receipt);
    if (inspected) return inspected;
    if (receipt.httpStatus !== 200) return 'validation_rejected';
    const body = receipt.body;
    if (body.client_id !== clientId || body.user_id !== readerId || !Array.isArray(body.scopes)
      || body.scopes.length > 100 || body.scopes.some((scope) => typeof scope !== 'string' || scope.length < 1 || scope.length > 200)
      || !body.scopes.includes('user:read:chat') || !Number.isSafeInteger(body.expires_in) || body.expires_in < 1) return 'invalid_validation';
    const time = clock();
    const lifetime = body.expires_in * 1_000;
    if (!Number.isSafeInteger(lifetime) || lifetime < minTokenRemainingMs
      || !Number.isSafeInteger(time + lifetime) || !Number.isSafeInteger(time + validationIntervalMs)) return 'invalid_validation';
    expiresAt = time + lifetime;
    nextValidationAt = time + validationIntervalMs;
    return null;
  }
  async function revalidate(run) {
    if (!current(run) || phase === 'revalidating') return;
    phase = 'revalidating';
    // Original expiry still applies while the injected validation is pending.
    try {
      schedule('validation', expiresAt, async () => { checkDeadlines(); });
      const receipt = await callAdapter('validate', { credential }, run);
      if (!current(run)) return;
      if (clock() >= expiresAt) { failed('expired', 'expired'); return; }
      const problem = checkValidation(receipt);
      if (problem) { failed(problem); return; }
      phase = 'receiving';
      scheduleValidation();
    } catch (error) { if (current(run)) failed(error === IO_TIMEOUT ? 'validation_timeout' : 'validation_rejected', error === IO_TIMEOUT ? 'timed_out' : 'failed'); }
  }
  function acknowledgement(receipt) {
    const inspected = inspectReceipt(receipt);
    if (inspected) return { problem: inspected };
    if (receipt.httpStatus !== 202) return { problem: 'subscription_rejected' };
    const data = receipt.body.data;
    if (!Array.isArray(data) || data.length !== 1 || !plain(data[0])) return { problem: 'invalid_ack' };
    const item = data[0];
    if (!safeId(item.id) || item.type !== TYPE || item.version !== VERSION || item.status !== 'enabled'
      || !plain(item.condition) || Object.keys(item.condition).sort().join(',') !== 'broadcaster_user_id,user_id'
      || item.condition.broadcaster_user_id !== broadcasterId || item.condition.user_id !== readerId
      || !plain(item.transport) || item.transport.method !== 'websocket' || item.transport.session_id !== sessionId) return { problem: 'invalid_ack' };
    return { id: item.id };
  }
  function createGuard(subscriptionId) {
    return createEventSubInbox({ broadcasterId, readerId, subscriptionId, now: () => guardClockOverride ?? clock() });
  }
  async function subscribe(run) {
    const request = freezeCopy({
      method: 'POST', url: 'https://api.twitch.tv/helix/eventsub/subscriptions',
      body: { type: TYPE, version: VERSION, condition: { broadcaster_user_id: broadcasterId, user_id: readerId }, transport: { method: 'websocket', session_id: sessionId } },
    });
    try {
      const receipt = await callAdapter('subscribe', { credential, request }, run);
      if (!current(run)) return inactiveResult(run);
      checkDeadlines();
      if (!current(run)) return result(false, lastCode, 'The subscription window or validation expired.');
      if (expiresAt - clock() < minTokenRemainingMs) return failed('invalid_validation');
      const ack = acknowledgement(receipt);
      if (ack.problem) return failed(ack.problem);
      // Bootstrapping the scoped guard uses actual recorded receive times, never
      // HTTP acknowledgement time. Preserve a pending keepalive, not raw chat.
      const scoped = createGuard(ack.id);
      guardClockOverride = welcomeReceivedAt;
      const welcome = scoped.receive(welcomeRaw);
      if (!welcome.ok) return failed('invalid_ack');
      if (latestPendingKeepalive) {
        guardClockOverride = latestPendingKeepalive.receivedAt;
        if (!scoped.receive(latestPendingKeepalive.raw).ok) return failed('invalid_ack');
      }
      guardClockOverride = null;
      guard.close();
      guard = scoped;
      welcomeRaw = null;
      latestPendingKeepalive = null;
      clearScheduled('subscription');
      phase = 'receiving';
      checkDeadlines();
      if (!current(run)) return result(false, lastCode, 'Receive-clock liveness expired before intake could start.');
      scheduleWatchdog();
      return result(true, 'subscribed', 'Injected acknowledgement checked; transport provenance remains unverified.');
    } catch (error) { return current(run) ? failed(error === IO_TIMEOUT ? 'subscription_timeout' : 'subscription_rejected', error === IO_TIMEOUT ? 'timed_out' : 'failed') : inactiveResult(run); }
  }
  async function receiveFrame(raw, run) {
    if (!current(run)) return result(false, 'inactive', 'No active harness run accepts this callback.');
    checkDeadlines();
    if (!current(run)) return result(false, lastCode, 'The harness deadline expired.');
    metrics.frames += 1;
    const receivedAt = clock();
    let decoded;
    try {
      if (phase === 'awaiting_welcome') {
        const pending = createGuard('pending-subscription');
        decoded = pending.receive(raw);
        if (decoded.code !== 'welcome' || !decoded.ok) {
          metrics.rejectedFrames += 1;
          return result(false, decoded.code, 'Frame rejected before the required welcome.');
        }
        guard = pending;
        sessionId = JSON.parse(raw).payload.session.id;
        welcomeRaw = raw;
        welcomeReceivedAt = receivedAt;
        subscribeDeadline = receivedAt + subscribeWindowMs;
        if (!Number.isSafeInteger(subscribeDeadline)) return failed('window_expired');
        welcomeDeadline = null;
        clearScheduled('welcome');
        phase = 'subscribing';
        schedule('subscription', subscribeDeadline, async () => { checkDeadlines(); });
        scheduleWatchdog();
        return await subscribe(run);
      }
      decoded = guard.receive(raw);
    } catch { metrics.rejectedFrames += 1; return result(false, 'invalid_frame', 'Malformed frame rejected without echoing its contents.'); }
    if (!decoded.ok) {
      metrics.rejectedFrames += 1;
      checkDeadlines();
      return result(false, decoded.code, 'Unverified frame rejected by the scoped protocol guard.');
    }
    if (decoded.code === 'reconnect_requested') {
      finish('reconnect_required', 'reconnect_required');
      try { await onAction(freezeCopy({ type: 'requires_graceful_handoff' })); } catch { /* No arbitrary callback error is exposed. */ }
      return result(false, 'reconnect_required', 'Intake frozen; a real host must implement graceful overlapping-socket handover.');
    }
    if (decoded.code === 'revoked') return failed('revoked', 'revoked');
    if (phase === 'subscribing' && decoded.code === 'keepalive') latestPendingKeepalive = { raw, receivedAt };
    scheduleWatchdog();
    if (decoded.event) {
      if (phase !== 'receiving') { metrics.droppedFrames += 1; return result(false, 'intake_paused', 'No chat is delivered before acknowledgement or during revalidation.'); }
      const event = freezeCopy({ ...decoded.event, origin: 'transport-unverified' });
      metrics.emittedEvents += 1;
      try { await onEvent(event); }
      catch { return current(run) ? failed('callback_failed') : result(false, 'inactive', 'The original harness run is no longer active.'); }
      if (!current(run)) return result(false, 'inactive', 'The original harness run is no longer active.');
    } else if (phase === 'subscribing') metrics.droppedFrames += 1;
    return result(true, decoded.code, 'Injected protocol activity checked; no real Twitch connection is claimed.');
  }
  async function start(handle) {
    if (active) return result(false, 'already_started', 'This harness already has an active run.');
    if (!handle || typeof handle !== 'object' || Array.isArray(handle)) return result(false, 'invalid_credential_handle', 'A private opaque credential object must be supplied by the host.');
    generation += 1;
    const run = generation;
    active = true;
    phase = 'validating';
    credential = handle;
    runController = new AbortController();
    lastCode = 'validating';
    metrics = { frames: 0, emittedEvents: 0, droppedFrames: 0, rejectedFrames: 0 };
    try {
      const receipt = await callAdapter('validate', { credential }, run);
      if (!current(run)) return inactiveResult(run);
      const problem = checkValidation(receipt);
      if (problem) return failed(problem);
      const time = clock();
      welcomeDeadline = time + welcomeTimeoutMs;
      if (!Number.isSafeInteger(welcomeDeadline)) return failed('welcome_timeout', 'timed_out');
      phase = 'awaiting_welcome';
      schedule('welcome', welcomeDeadline, async () => { checkDeadlines(); });
      scheduleValidation();
      const connection = await callAdapter('connect', {
        onFrame: (raw) => receiveFrame(raw, run),
        onDisconnect: () => { if (current(run)) finish('disconnected', 'disconnected'); },
        onError: () => { if (current(run)) finish('failed', 'transport_error'); },
      }, run);
      if (!current(run)) { await closeConnection(connection); return result(false, 'inactive', 'The original harness run is no longer active.'); }
      if (!connection || typeof connection.close !== 'function') return failed('transport_error');
      socket = connection;
      checkDeadlines();
      return active ? result(true, 'started', 'Injected adapters started; no verified Twitch connectivity is established.') : result(false, lastCode, 'The harness deadline expired.');
    } catch (error) {
      if (!current(run)) return inactiveResult(run);
      const validating = phase === 'validating';
      return failed(error === IO_TIMEOUT ? (validating ? 'validation_timeout' : 'transport_timeout') : (validating ? 'validation_rejected' : 'transport_error'), error === IO_TIMEOUT ? 'timed_out' : 'failed');
    }
  }
  async function stop(reason) {
    // Arbitrary caller reason is intentionally neither retained nor echoed.
    generation += 1;
    finish('stopped', 'stopped');
    await closing;
    return result(true, 'stopped', 'Transport harness stopped and its private credential reference cleared.');
  }
  clock();
  return Object.freeze({ start, stop, getState });
}
