import { createDeviceGrantHttpAdapters } from './device-grant-http.mjs';
import { createDeviceGrantHarness } from './device-grant.mjs';
import { createStagedSessionHost } from './staged-session-host.mjs';

/**
 * Private device-grant -> staged-session ownership HARNESS. Every HTTP/socket
 * port and private prompt hook is explicitly injected; this module supplies no
 * network, browser, account, environment, server or production-trust default.
 * A successful start owns an injected coordinator, which can still be awaiting
 * its welcome/subscription. Synthetic receipts never prove authorization.
 *
 * The start signal owns the entire attempt, including its later host lifetime.
 * Prompt lifetimeSignal ends at grant handoff or retirement; signal remains the
 * existing bounded prompt-operation signal. Already copied private instructions,
 * grants, headers and dependency-owned work cannot be recalled or securely erased.
 * Host failure/expiry observation is lazy at public and socket-hook boundaries.
 */
const own = (value, key) => Object.hasOwn(value, key);
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const unavailable = new Set(['idle', 'failed', 'expired', 'revoked', 'stopped']);
const grantCodes = new Set(['aborted', 'cancelled', 'stopped', 'invalid_input', 'invalid_clock', 'device_rejected',
  'invalid_device_response', 'invalid_token_response', 'poll_rejected', 'unknown_oauth_error', 'invalid_device_code',
  'authorization_denied', 'device_expired', 'grant_rejected', 'authorization_rejected', 'device_timeout', 'poll_timeout',
  'prompt_timeout', 'grant_timeout', 'device_failed', 'poll_failed', 'prompt_failed', 'grant_failed']);
const refreshCodes = new Set(['invalid_input', 'refresh_failed', 'refresh_timeout', 'aborted', 'credential_expired', 'invalid_grant']);

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
  // Native promises only. Raw synchronous results are boxed by invoke, without
  // assimilating a foreign thenable or reading a hostile own .then getter.
  try { void Promise.prototype.then.call(value, success, rejected); }
  catch { success(value); }
}
function discard(value) {
  try { void Promise.prototype.then.call(value, () => {}, () => {}); } catch { /* No arbitrary thenable protocol. */ }
}
function invoke(callback) {
  return new Promise((resolve, reject) => {
    try { observe(callback(), (value) => resolve({ value }), () => reject(new Error('dependency_failed'))); }
    catch { reject(new Error('dependency_failed')); }
  });
}
function isAborted(signal) {
  try { return abortedGetter.call(signal); } catch { throw new Error('invalid_input'); }
}
function inactive() { return Object.freeze({ ok: false, code: 'inactive' }); }

export function createDeviceSessionOwner(configuration = {}) {
  let config;
  try {
    config = dataRecord(configuration,
      ['clientId', 'broadcasterId', 'readerId', 'fetchImpl', 'connect', 'exchange', 'onPrompt', 'now', 'setTimer', 'clearTimer',
        'ioTimeoutMs', 'refreshTimeoutMs', 'leaseMs', 'card', 'boardOptions'],
      ['clientId', 'broadcasterId', 'readerId', 'fetchImpl', 'connect', 'exchange', 'onPrompt']);
  } catch { throw new Error('invalid_input'); }
  const { clientId, broadcasterId, readerId, fetchImpl, connect, exchange, onPrompt, now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout, ioTimeoutMs = 5_000, refreshTimeoutMs = 5_000, leaseMs = 60_000 } = config;
  if ([fetchImpl, connect, exchange, onPrompt, now, setTimer, clearTimer].some((value) => typeof value !== 'function')) throw new Error('invalid_input');

  let epoch = {};
  let active = null;
  let stopped = false;
  let tearingDown = 0;
  let observing = false;
  let phase = 'idle';
  let lastCode = 'idle';
  let cachedGrant = null;
  let cachedStaged = null;
  let staged;

  function clock() {
    const marker = epoch;
    let time;
    try { time = now(); } catch { throw new Error('invalid_input'); }
    if (marker !== epoch || !Number.isSafeInteger(time) || time < 0) throw new Error('invalid_input');
    return time;
  }
  function current(target) { return !stopped && active === target && !target.retired && target.epoch === epoch; }
  function currentRun(target, run) { return current(target) && target.run === run; }
  function currentOperation(target, pending) { return current(target) && target.pending === pending && !pending.done; }
  function stagedSnapshot() {
    if (active?.hostInvoked && !tearingDown) return cachedStaged;
    // Retirement remains visible even if a broken injected clock prevents a
    // child snapshot/revoke. Later clock recovery cannot revive an old cue.
    if (!cachedStaged) return null;
    return freeze({ ...cachedStaged,
      board: { ...cachedStaged.board, connection: { status: 'disconnected' },
        sourceCue: { ...cachedStaged.board.sourceCue, active: false, requestedAt: null, expiresAt: null } },
      binding: { phase: stopped ? 'stopped' : 'retired' } });
  }
  function publicState() {
    return freeze({ mode: 'device-session-owner-harness', networkConnected: false, authorizationVerified: false, realTwitchConnected: false,
      phase: stopped ? 'stopped' : active?.phase ?? phase, busy: tearingDown > 0 || Boolean(active?.pending), active: !stopped && active !== null,
      lastCode, grant: cachedGrant, staged: stagedSnapshot() });
  }
  function result(ok, code) {
    return freeze({ ok, code, message: 'Private device/session ownership harness; authorization and Twitch connectivity remain unverified.', state: publicState() });
  }
  function begin(target, kind) {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const pending = { kind, promise, resolve, done: false };
    target.pending = pending;
    return pending;
  }
  function settle(target, pending, ok, code) {
    if (!currentOperation(target, pending)) return;
    pending.done = true;
    target.pending = null;
    target.phase = 'active';
    lastCode = code;
    pending.resolve(result(ok, code));
    pending.resolve = null;
  }
  function removeListener(signal, listener) {
    if (signal && listener) try { EventTarget.prototype.removeEventListener.call(signal, 'abort', listener); } catch { /* Fixed local errors only. */ }
  }
  function endPrompt(target) {
    const controller = target.promptController;
    target.promptController = null;
    try { controller?.abort(); } catch { /* Previously copied instructions cannot be recalled. */ }
  }
  function retire(target, code, nextPhase = 'failed', action = 'revoke') {
    if (target && active !== target) return;
    const pending = target?.pending;
    if (pending) { pending.done = true; target.pending = null; }
    active = null;
    epoch = {};
    phase = nextPhase;
    lastCode = code;
    if (target) target.retired = true;
    tearingDown += 1;
    let changed = null;
    try {
      if (target) {
        const external = target.external;
        const externalListener = target.externalListener;
        const grantSignal = target.grantSignal;
        const grantListener = target.grantListener;
        const harness = target.harness;
        const controller = target.controller;
        target.external = null;
        target.externalListener = null;
        target.grantSignal = null;
        target.grantListener = null;
        target.harness = null;
        target.controller = null;
        target.run = null;
        removeListener(external, externalListener);
        removeListener(grantSignal, grantListener);
        endPrompt(target);
        try { controller?.abort(); } catch { /* Captured old lifetime only. */ }
        try { if (harness) { harness.stop(); cachedGrant = harness.getState(); } } catch { /* No raw private errors. */ }
      }
      try { changed = staged[action](); } catch { /* Public result remains a fixed local code. */ }
      if (stopped && action !== 'stop') try { staged.stop(); } catch { /* A reentrant stop remains terminal. */ }
      try { cachedStaged = staged.getState(); } catch { /* Keep a disconnected public projection. */ }
    } finally { tearingDown -= 1; }
    if (pending) {
      pending.resolve(result(false, stopped ? 'stopped' : code));
      pending.resolve = null;
    }
    return changed;
  }
  function synchronize() {
    if (observing || tearingDown || !staged) return;
    observing = true;
    const target = active;
    const marker = epoch;
    try {
      const snapshot = staged.getState();
      if (epoch !== marker) return;
      cachedStaged = snapshot;
      if (!target || !current(target)) return;
      if (target.harness) {
        const grant = target.harness.getState();
        if (!current(target)) return;
        cachedGrant = grant;
        if (['failed', 'expired', 'cancelled', 'stopped'].includes(grant.phase)) {
          const code = target.failureCode ?? (grantCodes.has(grant.lastCode) ? grant.lastCode : 'grant_failed');
          retire(target, code, code === 'device_expired' ? 'expired' : 'failed');
          return;
        }
      }
      if (target.hostInvoked && !target.invokingHost && unavailable.has(snapshot.session?.phase)) {
        const expired = snapshot.session?.phase === 'expired' || snapshot.binding?.phase === 'expired';
        retire(target, expired ? 'credential_expired' : 'host_failed', expired ? 'expired' : 'failed');
      }
    } catch { if (target && current(target)) retire(target, 'invalid_input'); }
    finally { observing = false; }
  }
  function getState() { synchronize(); return publicState(); }

  // This small port closes a captured late connection without awaiting a
  // dependency's mistaken asynchronous shutdown or reading a thenable getter.
  function connectionPort(value) {
    let object;
    try { object = dataRecord(value, ['close']); } catch { throw new Error('host_failed'); }
    let close = object.close;
    let target = value;
    object = null;
    if (typeof close !== 'function') throw new Error('host_failed');
    let closed = false;
    return Object.freeze({ close() {
      if (closed) return;
      closed = true;
      const oldTarget = target;
      const oldClose = close;
      target = null;
      close = null;
      try { discard(oldClose.call(oldTarget)); } catch { /* No physical shutdown guarantee. */ }
    } });
  }
  function connectPort(args) {
    const target = active;
    const run = target?.run;
    if (!target || !currentRun(target, run) || !target.hostInvoked) return Promise.reject(new Error('inactive'));
    const request = Object.freeze({ signal: args.signal,
      onFrame: (raw) => {
        if (!currentRun(target, run)) return Promise.resolve(inactive());
        synchronize();
        if (!currentRun(target, run)) return Promise.resolve(inactive());
        return invoke(() => args.onFrame(raw)).then(({ value }) => {
          if (!currentRun(target, run)) return inactive();
          synchronize();
          return currentRun(target, run) ? value : inactive();
        }, () => { if (currentRun(target, run)) retire(target, 'host_failed'); return inactive(); });
      },
      onDisconnect: () => {
        if (!currentRun(target, run)) return;
        try { args.onDisconnect(); } catch { /* Fixed child state is observed below. */ }
        if (currentRun(target, run)) synchronize();
      },
      onError: () => {
        if (!currentRun(target, run)) return;
        try { args.onError(); } catch { /* No raw error event is retained. */ }
        if (currentRun(target, run)) synchronize();
      },
    });
    return invoke(() => {
      if (!currentRun(target, run)) throw new Error('inactive');
      return connect(request);
    }).then(({ value }) => {
      const port = connectionPort(value);
      if (!currentRun(target, run)) port.close();
      return port;
    });
  }
  function exchangePort(input) {
    const target = active;
    const pending = target?.pending;
    // A close hook can request stop during the synchronous refresh entry.
    // Deferred shared-host cleanup must not permit a new exchange afterward.
    if (!target || !pending || pending.kind !== 'refresh' || !currentOperation(target, pending)
      || isAborted(input.signal)) throw new Error('inactive');
    return exchange(input);
  }

  try {
    staged = createStagedSessionHost({ clientId, broadcasterId, readerId, fetchImpl, connect: connectPort, exchange: exchangePort,
      now: clock, setTimer, clearTimer, ioTimeoutMs, refreshTimeoutMs, leaseMs,
      ...(own(config, 'card') ? { card: config.card } : {}), ...(own(config, 'boardOptions') ? { boardOptions: config.boardOptions } : {}) });
    cachedStaged = staged.getState();
  } catch { throw new Error('invalid_input'); }

  function handoff(target, grant, meta) {
    if (!current(target)) { grant = null; return Promise.reject(new Error('inactive')); }
    target.phase = 'starting_host';
    lastCode = 'starting_host';
    endPrompt(target);
    if (!current(target)) { grant = null; return Promise.reject(new Error('inactive')); }
    target.grantSignal = meta.signal;
    target.grantListener = () => {
      if (!current(target)) return;
      // Harness finish records its cause before aborting the pending hook.
      // Preserve device expiry rather than relabelling every abort a timeout.
      let code = 'grant_timeout';
      try {
        const snapshot = target.harness?.getState();
        if (grantCodes.has(snapshot?.lastCode)) code = snapshot.lastCode;
      } catch { /* Fixed fallback only. */ }
      if (current(target)) retire(target, code, code === 'device_expired' ? 'expired' : 'failed');
    };
    EventTarget.prototype.addEventListener.call(meta.signal, 'abort', target.grantListener, { once: true });
    if (isAborted(meta.signal)) { grant = null; retire(target, 'grant_timeout'); return Promise.reject(new Error('inactive')); }
    let pending;
    target.hostInvoked = true;
    target.invokingHost = true;
    try { pending = staged.start(grant); }
    finally { grant = null; target.invokingHost = false; }
    return invoke(() => pending).then(({ value }) => {
      if (!current(target)) throw new Error('inactive');
      if (!value.ok) { target.failureCode = 'host_failed'; throw new Error('host_failed'); }
      synchronize();
      if (!current(target)) throw new Error('inactive');
    });
  }

  function start(options = {}) {
    synchronize();
    if (stopped) return Promise.resolve(result(false, 'stopped'));
    if (tearingDown || active) return Promise.resolve(result(false, 'busy'));
    epoch = {};
    const target = { epoch, retired: false, pending: null, phase: 'granting', run: {}, harness: null,
      controller: new AbortController(), promptController: new AbortController(), external: null, externalListener: null,
      grantSignal: null, grantListener: null, hostInvoked: false, invokingHost: false, failureCode: null };
    active = target;
    lastCode = 'granting';
    const pending = begin(target, 'start');
    try {
      const args = dataRecord(options, ['signal'], []);
      if (!currentOperation(target, pending)) return pending.promise;
      if (args.signal !== undefined) {
        isAborted(args.signal);
        target.external = args.signal;
        target.externalListener = () => { if (current(target)) retire(target, 'aborted', 'cancelled'); };
        EventTarget.prototype.addEventListener.call(args.signal, 'abort', target.externalListener, { once: true });
        if (isAborted(args.signal)) { retire(target, 'aborted', 'cancelled'); return pending.promise; }
      }
      const http = createDeviceGrantHttpAdapters({ clientId, fetch: fetchImpl, timeoutMs: ioTimeoutMs, setTimer, clearTimer });
      const harness = createDeviceGrantHarness({ clientId, adapters: http, now: clock, setTimer, clearTimer, ioTimeoutMs,
        onPrompt: (prompt, meta) => {
          if (!current(target) || !target.promptController) throw new Error('inactive');
          const privateMeta = Object.freeze({ signal: meta.signal, lifetimeSignal: target.promptController.signal });
          return invoke(() => {
            if (!current(target)) throw new Error('inactive');
            return onPrompt(prompt, privateMeta);
          }).then(() => { if (!current(target)) throw new Error('inactive'); });
        },
        onGrant: (grant, meta) => handoff(target, grant, meta),
      });
      if (!currentOperation(target, pending)) { harness.stop(); return pending.promise; }
      target.harness = harness;
      observe(harness.start({ signal: target.controller.signal }), (value) => {
        if (!currentOperation(target, pending)) return;
        cachedGrant = harness.getState();
        if (!value.ok) {
          const code = target.failureCode ?? (grantCodes.has(value.code) ? value.code : 'grant_failed');
          retire(target, code, code === 'device_expired' ? 'expired' : 'failed');
          return;
        }
        removeListener(target.grantSignal, target.grantListener);
        target.grantSignal = null;
        target.grantListener = null;
        synchronize();
        if (currentOperation(target, pending)) settle(target, pending, true, 'started');
      }, () => { if (currentOperation(target, pending)) retire(target, 'grant_failed'); });
      synchronize();
    } catch { if (currentOperation(target, pending)) retire(target, 'invalid_input'); }
    return pending.promise;
  }

  function refresh(options = {}) {
    synchronize();
    if (stopped) return Promise.resolve(result(false, 'stopped'));
    if (tearingDown || active?.pending) return Promise.resolve(result(false, 'busy'));
    const target = active;
    if (!target?.hostInvoked) return Promise.resolve(result(false, 'not_started'));
    const pending = begin(target, 'refresh');
    target.phase = 'refreshing';
    lastCode = 'refreshing';
    let args;
    try {
      args = dataRecord(options, ['signal'], []);
      if (args.signal !== undefined) isAborted(args.signal);
    } catch { if (currentOperation(target, pending)) retire(target, 'invalid_input'); return pending.promise; }
    if (!currentOperation(target, pending)) return pending.promise;
    target.run = {};
    let task;
    let failed = false;
    // The synchronous refresh entry retires the old shared socket before it
    // calls exchange. Close/abort hooks cannot alter the round during that
    // teardown; ordinary controls can resume while async refresh is pending.
    tearingDown += 1;
    try { task = staged.refresh(args.signal !== undefined ? { signal: args.signal } : {}); }
    catch { failed = true; }
    finally { tearingDown -= 1; }
    if (stopped && active === target) { discard(task); retire(target, 'stopped', 'stopped', 'stop'); return pending.promise; }
    if (!currentOperation(target, pending)) { discard(task); return pending.promise; }
    if (failed) { retire(target, 'host_failed'); return pending.promise; }
    observe(task, (value) => {
      if (!currentOperation(target, pending)) return;
      if (!value.ok) { retire(target, refreshCodes.has(value.code) ? value.code : 'host_failed'); return; }
      synchronize();
      if (currentOperation(target, pending)) settle(target, pending, true, 'refreshed');
    }, () => { if (currentOperation(target, pending)) retire(target, 'host_failed'); });
    return pending.promise;
  }

  function cancel() {
    if (stopped) return result(false, 'stopped');
    if (tearingDown) return result(false, 'busy');
    retire(active, 'cancelled', 'cancelled');
    return result(true, 'cancelled');
  }
  function stop() {
    stopped = true;
    if (tearingDown) { epoch = {}; phase = 'stopped'; lastCode = 'stopped'; return result(true, 'stopped'); }
    retire(active, 'stopped', 'stopped', 'stop');
    return result(true, 'stopped');
  }
  function control(method, value) {
    synchronize();
    if (stopped) return result(false, 'stopped');
    if (tearingDown) return result(false, 'busy');
    const marker = epoch;
    let changed;
    try { changed = staged[method](value); }
    catch { if (active && epoch === marker) retire(active, 'invalid_input'); return result(false, 'invalid_input'); }
    if (epoch !== marker) return result(false, 'inactive');
    synchronize();
    return result(changed.ok, changed.code);
  }
  function reset() {
    if (stopped) return result(false, 'stopped');
    if (tearingDown) return result(false, 'busy');
    const changed = retire(active, 'cancelled', 'cancelled', 'reset');
    return result(Boolean(changed?.ok), changed?.ok ? 'reset' : 'invalid_input');
  }

  return Object.freeze({ start, cancel, stop, getState, refresh,
    openVote: (durationMs) => control('openVote', durationMs), closeVote: () => control('closeVote'), reset,
    simulation: staged.simulation });
}
