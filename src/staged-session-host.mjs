import { createCredentialSessionHost } from './credential-session-host.mjs';
import { createIngressIsolation } from './ingress-isolation.mjs';

/**
 * SYNTHETIC transport-to-tally composition, without server/UI/OAuth activation.
 * The first privately delivered event binds a per-run synthetic scope identity;
 * acknowledgement alone leaves the board disconnected. Retired identities never
 * renew their lease per message, even if a later scope has identical ID strings.
 * State/failure/expiry observation is lazy at public and callback boundaries.
 * No credential, capability, raw scope or event-delivery API is exposed here.
 */
const own = (value, key) => Object.hasOwn(value, key);
const unavailablePhases = new Set(['idle', 'failed', 'expired', 'revoked', 'stopped']);

function dataRecord(input, allowed, required = allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_input');
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) throw new Error('invalid_input');
  const keys = Reflect.ownKeys(input);
  if (keys.length > allowed.length || keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) throw new Error('invalid_input');
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !own(descriptor, 'value') || !descriptor.enumerable) throw new Error('invalid_input');
    result[key] = descriptor.value;
  }
  if (required.some((key) => !own(result, key))) throw new Error('invalid_input');
  return result;
}
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function observe(value, success, rejected) {
  try { void Promise.prototype.then.call(value, success, rejected); }
  catch { void Promise.resolve(value).then(success, rejected); }
}
function discard(value) { observe(value, () => {}, () => {}); }

export function createStagedSessionHost(configuration = {}) {
  let config;
  try {
    config = dataRecord(configuration,
      ['clientId', 'broadcasterId', 'readerId', 'fetchImpl', 'connect', 'exchange', 'now', 'setTimer', 'clearTimer', 'ioTimeoutMs', 'refreshTimeoutMs', 'leaseMs', 'card', 'boardOptions'],
      ['clientId', 'broadcasterId', 'readerId', 'fetchImpl', 'connect', 'exchange']);
  } catch { throw new Error('invalid_input'); }
  const { clientId, broadcasterId, readerId, fetchImpl, connect, exchange, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    ioTimeoutMs = 5_000, refreshTimeoutMs = 5_000, leaseMs = 60_000 } = config;
  let epoch = {};
  function guardedClock() {
    const marker = epoch;
    let time;
    try { time = now(); } catch { throw new Error('invalid_input'); }
    if (marker !== epoch) throw new Error('inactive');
    if (!Number.isSafeInteger(time) || time < 0) throw new Error('invalid_input');
    return time;
  }
  let isolation;
  try {
    isolation = createIngressIsolation({ broadcasterId, readerId, now: guardedClock, leaseMs,
      ...(own(config, 'card') ? { card: config.card } : {}), ...(own(config, 'boardOptions') ? { boardOptions: config.boardOptions } : {}) });
  } catch { throw new Error('invalid_input'); }

  const retiredScopes = new WeakSet();
  let scope = null;
  let capability = null;
  let ticket = null;
  let operation = null;
  let stopped = false;
  let bindingPhase = 'awaiting_scope';
  let synchronizing = false;
  let sessionHost;
  let cachedSession = null;
  let cachedBoard = isolation.staged.getState();

  function currentTicket(candidate) { return !stopped && ticket === candidate && !candidate.retired && candidate.epoch === epoch; }
  function currentOperation(pending) { return !stopped && operation === pending && !pending.done && pending.epoch === epoch; }
  function publicState() {
    return freeze({
      mode: 'staged-session-host-harness', networkConnected: false, realTwitchConnected: false, authorizationVerified: false,
      session: cachedSession, board: cachedBoard, binding: { phase: bindingPhase },
    });
  }
  function result(ok, code, extra = {}) {
    return freeze({ ok, code, message: 'Synthetic staged-session harness; Twitch and authorization remain unverified.', ...extra, state: publicState() });
  }
  function settle(pending, ok, code) {
    if (!pending || pending.done) return;
    pending.done = true;
    if (operation === pending) operation = null;
    pending.resolve(result(ok, code));
  }
  function begin(kind) {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const pending = { kind, epoch, resolve, promise, done: false };
    operation = pending;
    return pending;
  }
  function admissionBoard(board) {
    if (capability) return board;
    // The wrapper has retired admission even if a broken clock prevented the
    // underlying simulation from completing its private revoke. Clock recovery
    // must not resurrect a cue/connection from that unused old capability.
    return freeze({ ...board, connection: { status: 'disconnected' },
      sourceCue: { ...board.sourceCue, active: false, requestedAt: null, expiresAt: null },
      ingress: { ...board.ingress, phase: bindingPhase === 'stopped' ? 'stopped' : bindingPhase === 'expired' ? 'expired'
        : board.ingress.phase === 'inactive' ? 'inactive' : 'revoked' } });
  }
  function clearScope(nextPhase) {
    const oldScope = scope;
    const oldCapability = capability;
    scope = null;
    capability = null;
    bindingPhase = nextPhase;
    cachedBoard = admissionBoard(cachedBoard);
    if (oldScope) retiredScopes.add(oldScope);
    if (oldCapability) try { isolation.host.revoke(oldCapability); } catch { /* Private old identity only. */ }
  }
  function detachTicket() {
    if (ticket) ticket.retired = true;
    ticket = null;
  }
  function invalidate(nextPhase, code) {
    const marker = {};
    epoch = marker;
    const pending = operation;
    operation = null;
    detachTicket();
    clearScope(nextPhase);
    settle(pending, false, code);
    return marker;
  }
  function readSnapshots() {
    const marker = epoch;
    const session = sessionHost.getState();
    if (epoch !== marker) return false;
    const board = isolation.staged.getState();
    if (epoch !== marker) return false;
    cachedSession = session;
    cachedBoard = admissionBoard(board);
    return true;
  }
  function synchronize() {
    if (synchronizing || !sessionHost) return;
    synchronizing = true;
    const observingEpoch = epoch;
    try {
      if (!readSnapshots()) return;
      if (capability && cachedBoard.ingress.phase === 'expired') {
        const marker = invalidate('expired', 'capability_expired');
        // A reentrant explicit start owns a new epoch; never revoke it here.
        if (epoch === marker && !stopped) sessionHost.revoke();
        readSnapshots();
      } else if (!stopped && unavailablePhases.has(cachedSession.phase) && (scope || ticket || operation)) {
        invalidate(cachedSession.phase === 'expired' ? 'expired' : 'retired', cachedSession.phase === 'expired' ? 'credential_expired' : 'transport_failed');
        readSnapshots();
      }
    } catch {
      if (epoch !== observingEpoch) return;
      const marker = invalidate(stopped ? 'stopped' : 'retired', 'invalid_input');
      if (epoch === marker && !stopped) try { sessionHost.revoke(); } catch { /* Fixed public failure only. */ }
      try { readSnapshots(); } catch { /* Keep last aggregate snapshots. */ }
    } finally { synchronizing = false; }
  }
  function getState() { synchronize(); return publicState(); }

  function deliver(event, privateScope) {
    const admittedTicket = ticket;
    const marker = epoch;
    synchronize();
    if (!admittedTicket || !currentTicket(admittedTicket) || epoch !== marker || operation || cachedSession?.busy || cachedSession?.phase !== 'receiving'
      || retiredScopes.has(privateScope)) return;
    if (scope && scope !== privateScope) {
      const retired = invalidate('retired', 'scope_mismatch');
      if (epoch === retired) sessionHost.revoke();
      return;
    }
    if (!capability) {
      let issued;
      try { issued = isolation.host.issue(privateScope); }
      catch { return; }
      if (epoch !== marker || !currentTicket(admittedTicket) || operation || retiredScopes.has(privateScope)) {
        retiredScopes.add(privateScope);
        try { isolation.host.revoke(issued); } catch { /* Never touch a newer capability. */ }
        return;
      }
      scope = privateScope;
      capability = issued;
      bindingPhase = 'bound';
    }
    // The isolator performs another own-data/capability/clock admission check
    // before copying this explicitly unverified event into its simulation board.
    const admittedCapability = capability;
    const delivered = isolation.host.deliver(admittedCapability, {
      broadcasterId: privateScope.broadcasterId, readerId: privateScope.readerId,
      sessionId: privateScope.sessionId, subscriptionId: privateScope.subscriptionId,
      event: { id: event.id, userId: event.userId, text: event.text, timestamp: event.timestamp, origin: 'transport-unverified' },
    });
    if (epoch !== marker || !currentTicket(admittedTicket) || capability !== admittedCapability) return;
    if (delivered.code === 'capability_expired') {
      const retired = invalidate('expired', 'capability_expired');
      if (epoch === retired) sessionHost.revoke();
    }
    synchronize();
  }

  async function connectPort(args) {
    const candidate = { epoch, retired: false };
    detachTicket();
    ticket = candidate;
    const request = Object.freeze({
      signal: args.signal,
      onFrame: async (raw) => {
        if (!currentTicket(candidate)) return Object.freeze({ ok: false, code: 'inactive' });
        synchronize();
        if (!currentTicket(candidate)) return Object.freeze({ ok: false, code: 'inactive' });
        const value = await args.onFrame(raw);
        if (currentTicket(candidate)) synchronize();
        return value;
      },
      onDisconnect: () => {
        if (!currentTicket(candidate)) return;
        invalidate('retired', 'transport_failed');
        args.onDisconnect();
        synchronize();
      },
      onError: () => {
        if (!currentTicket(candidate)) return;
        invalidate('retired', 'transport_failed');
        args.onError();
        synchronize();
      },
    });
    const connection = await connect(request);
    let target = connection;
    let close = target?.close;
    if (typeof close !== 'function') throw new Error('transport_failed');
    let closed = false;
    return Object.freeze({ close() {
      if (closed) return;
      closed = true;
      if (currentTicket(candidate)) invalidate('retired', 'transport_failed');
      const oldTarget = target;
      const oldClose = close;
      target = null;
      close = null;
      try { discard(oldClose.call(oldTarget)); } catch { /* Nonblocking captured old connection only. */ }
    } });
  }

  try {
    sessionHost = createCredentialSessionHost({ clientId, broadcasterId, readerId, fetchImpl, connect: connectPort, exchange, onEvent: deliver,
      now: guardedClock, setTimer, clearTimer, ioTimeoutMs, refreshTimeoutMs });
    cachedSession = sessionHost.getState();
  } catch { throw new Error('invalid_input'); }

  function start(grant) {
    synchronize();
    if (stopped) return Promise.resolve(result(false, 'stopped'));
    if (operation || cachedSession?.busy || cachedSession?.transport) return Promise.resolve(result(false, 'busy'));
    epoch = {};
    const pending = begin('start');
    detachTicket();
    clearScope('awaiting_scope');
    if (!currentOperation(pending)) return pending.promise;
    let promise;
    try { promise = sessionHost.start(grant); } finally { grant = null; }
    observe(promise, (value) => {
      if (!currentOperation(pending)) return;
      if (!value.ok) { invalidate('retired', value.code); synchronize(); return; }
      synchronize();
      if (currentOperation(pending)) settle(pending, value.ok, value.code);
    }, () => {
      if (!currentOperation(pending)) return;
      const marker = invalidate('retired', 'invalid_grant');
      if (epoch === marker) sessionHost.revoke();
      synchronize();
    });
    return pending.promise;
  }

  function refresh(options = {}) {
    synchronize();
    if (stopped) return Promise.resolve(result(false, 'stopped'));
    if (operation || cachedSession?.busy) return Promise.resolve(result(false, 'busy'));
    if (!cachedSession?.transport) return Promise.resolve(result(false, 'not_started'));
    epoch = {};
    const pending = begin('refresh');
    detachTicket();
    clearScope('awaiting_scope');
    if (!currentOperation(pending)) return pending.promise;
    observe(sessionHost.refresh(options), (value) => {
      if (!currentOperation(pending)) return;
      if (!value.ok) { invalidate('retired', value.code); synchronize(); return; }
      synchronize();
      if (currentOperation(pending)) settle(pending, value.ok, value.code);
    }, () => {
      if (!currentOperation(pending)) return;
      const marker = invalidate('retired', 'refresh_failed');
      if (epoch === marker) sessionHost.revoke();
      synchronize();
    });
    return pending.promise;
  }

  function revoke() {
    if (stopped) return result(false, 'stopped');
    const marker = invalidate('retired', 'revoked');
    if (epoch === marker) sessionHost.revoke();
    synchronize();
    return result(true, 'revoked');
  }
  function stop() {
    stopped = true;
    invalidate('stopped', 'stopped');
    sessionHost.stop();
    try { isolation.host.stop(); } catch { /* Stopped facade cannot deliver again. */ }
    synchronize();
    return result(true, 'stopped');
  }
  function control(method, value) {
    synchronize();
    if (stopped) return result(false, 'stopped');
    const marker = epoch;
    let changed;
    try { changed = isolation.staged[method](value); }
    catch { synchronize(); return result(false, marker === epoch ? 'invalid_input' : 'inactive'); }
    if (marker !== epoch) { synchronize(); return result(false, 'inactive'); }
    synchronize();
    return freeze({ ...changed, state: publicState() });
  }
  function reset() {
    if (stopped) return result(false, 'stopped');
    const marker = invalidate('retired', 'revoked');
    if (epoch === marker) sessionHost.revoke();
    if (epoch !== marker) { synchronize(); return result(false, 'inactive'); }
    let changed;
    try { changed = isolation.staged.reset(); }
    catch { synchronize(); return result(false, epoch === marker ? 'invalid_input' : 'inactive'); }
    if (epoch !== marker) { synchronize(); return result(false, 'inactive'); }
    synchronize();
    return freeze({ ...changed, state: publicState() });
  }
  return Object.freeze({ start, refresh, revoke, stop, getState,
    openVote: (durationMs) => control('openVote', durationMs), closeVote: () => control('closeVote'), reset,
    simulation: isolation.simulation });
}
