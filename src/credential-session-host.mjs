import { createCredentialVault } from './credential-vault.mjs';
import { createTwitchHttpAdapters } from './twitch-http-adapters.mjs';
import { createTwitchSession } from './twitch-session.mjs';

/**
 * Private, dependency-injected credential/session composition HARNESS.
 * No default fetch, socket, OAuth, environment, filesystem or tally exists.
 * Injected adapters and local grants never establish real/authenticated Twitch
 * provenance. A refreshed credential starts a new validation/socket lifecycle;
 * this is not graceful handover or replay of events lost between connections.
 *
 * Expiry and coordinator failures are observed at public-operation boundaries
 * and before private event delivery. There is no extra host polling timer.
 * Already-delivered callback values, dependency-owned headers/token copies and
 * physical TCP shutdown cannot be recalled or guaranteed by this wrapper.
 */
const own = (value, key) => Object.hasOwn(value, key);
const numericId = (value) => typeof value === 'string' && /^[1-9][0-9]{0,24}$/.test(value);
const clientIdValid = (value) => typeof value === 'string' && /^[A-Za-z0-9]{1,128}$/.test(value);
const terminalPhases = new Set(['failed', 'timed_out', 'expired', 'revoked', 'reconnect_required', 'disconnected', 'stopped']);
const refreshCodes = new Set(['invalid_input', 'invalid_grant', 'refresh_failed', 'refresh_timeout', 'aborted', 'credential_expired', 'invalid_clock']);

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
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

function observe(value, success, rejected) {
  try { void Promise.prototype.then.call(value, success, rejected); }
  catch { void Promise.resolve(value).then(success, rejected); }
}
function discard(value) { observe(value, () => {}, () => {}); }
function codeOf(error, allowed, fallback) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(error, 'message');
    return descriptor && own(descriptor, 'value') && allowed.has(descriptor.value) ? descriptor.value : fallback;
  } catch { return fallback; }
}

// The coordinator may await close(). This port deliberately returns void even
// for a host's contract-violating async close; host shutdown owns that work.
function closePort(connection) {
  let target = connection;
  let close;
  try { close = target?.close; } catch { throw new Error('transport_failed'); }
  if (typeof close !== 'function') throw new Error('transport_failed');
  let closed = false;
  return Object.freeze({ close() {
    if (closed) return;
    closed = true;
    const oldTarget = target;
    const oldClose = close;
    target = null;
    close = null;
    try { discard(oldClose.call(oldTarget)); } catch { /* Never echo a raw host error. */ }
  } });
}

export function createCredentialSessionHost(configuration = {}) {
  let config;
  try {
    config = dataRecord(configuration,
      ['clientId', 'broadcasterId', 'readerId', 'fetchImpl', 'connect', 'exchange', 'onEvent', 'now', 'setTimer', 'clearTimer', 'ioTimeoutMs', 'refreshTimeoutMs'],
      ['clientId', 'broadcasterId', 'readerId', 'fetchImpl', 'connect', 'exchange']);
  } catch { throw new Error('invalid_input'); }
  const {
    clientId, broadcasterId, readerId, fetchImpl, connect, exchange,
    onEvent = () => {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
    ioTimeoutMs = 5_000, refreshTimeoutMs = 5_000,
  } = config;
  if (!clientIdValid(clientId) || !numericId(broadcasterId) || !numericId(readerId) || broadcasterId !== readerId
    || [fetchImpl, connect, exchange, onEvent, now, setTimer, clearTimer].some((value) => typeof value !== 'function')
    || [ioTimeoutMs, refreshTimeoutMs].some((value) => !Number.isSafeInteger(value) || value < 1 || value > 60_000)) throw new Error('invalid_input');

  let binding = null;
  let operation = null;
  let stopped = false;
  let phase = 'idle';
  let observing = false;
  let lastCredential = { phase: 'empty', expiresAt: null, refreshPending: false };

  function clock() {
    let time;
    try { time = now(); } catch { throw new Error('invalid_clock'); }
    if (!Number.isSafeInteger(time) || time < 0) throw new Error('invalid_clock');
    return time;
  }
  function current(target) { return !stopped && binding === target && !target.retired; }
  function currentRun(target, run) { return current(target) && target.run === run && !run.retired; }
  function currentOperation(target, pending) { return current(target) && operation === pending && !pending.done; }

  function publicState() {
    return freeze({
      mode: 'credential-session-host-harness',
      networkConnected: false,
      realTwitchConnected: false,
      authorizationVerified: false,
      phase: binding ? (operation ? (operation.kind === 'refresh' ? 'refreshing' : 'starting') : binding.transportState?.phase ?? 'starting') : phase,
      busy: operation !== null,
      credential: { ...(binding?.credentialState ?? lastCredential) },
      transport: binding?.transportState ?? null,
    });
  }
  function result(ok, code) { return freeze({ ok, code, message: 'Private credential/session harness; connectivity and authorization remain unverified.', state: publicState() }); }
  function settle(pending, ok, code) {
    if (!pending || pending.done) return;
    pending.done = true;
    if (operation === pending) operation = null;
    pending.resolve(result(ok, code));
  }
  function begin(target, kind) {
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const pending = { kind, resolve, promise, done: false, target };
    operation = pending;
    return pending;
  }

  function retireSlot(run) {
    if (!run) return;
    run.retired = true;
    run.scope = null;
    const coordinator = run.coordinator;
    run.coordinator = null;
    // stop() invalidates callbacks and aborts adapter I/O synchronously, before
    // its returned Promise. Its eventual result is never used to mutate state.
    try { if (coordinator) discard(coordinator.stop()); } catch { /* Captured old run only. */ }
  }

  function retireRun(target) {
    const run = target.run;
    target.run = null;
    target.transportState = null;
    retireSlot(run);
  }

  function retire(target, code, nextPhase = 'failed') {
    if (binding !== target) return;
    const pending = operation;
    binding = null;
    operation = null;
    target.retired = true;
    target.handle = null;
    phase = nextPhase;
    lastCredential = { phase: nextPhase, expiresAt: null, refreshPending: false };
    // Detach all host ownership before stop/abort/close hooks can reenter start.
    settle(pending, false, code);
    retireRun(target);
    const vault = target.vault;
    target.vault = null;
    try { vault?.stop(); } catch { /* An old vault cannot clear a newer binding. */ }
  }

  function observeBoundary() {
    if (observing || !binding || stopped) return;
    observing = true;
    const target = binding;
    try {
      if (!target.vault) return;
      const credential = target.vault.getState();
      if (!current(target)) return;
      target.credentialState = { phase: credential.phase, expiresAt: credential.expiresAt, refreshPending: credential.refreshPending };
      if (target.handle && !['ready', 'refreshing'].includes(credential.phase)) {
        retire(target, credential.phase === 'expired' ? 'credential_expired' : 'refresh_failed', credential.phase === 'expired' ? 'expired' : 'failed');
        return;
      }
      const run = target.run;
      if (!run?.coordinator) return;
      const transport = run.coordinator.getState();
      if (!currentRun(target, run)) return;
      target.transportState = transport;
      if (terminalPhases.has(transport.phase)) retire(target, transport.phase === 'expired' ? 'credential_expired' : 'transport_failed', transport.phase === 'expired' ? 'expired' : 'failed');
    } catch {
      if (current(target)) retire(target, 'invalid_input');
    } finally { observing = false; }
  }

  function getState() { observeBoundary(); return publicState(); }

  async function emit(target, run, event) {
    observeBoundary();
    if (!currentRun(target, run) || operation || target.transportState?.phase !== 'receiving' || !run.scope) return;
    // Private callback projection only. No raw delivery metadata or scoped
    // session IDs enter public state; this remains rejected by the live-less board.
    const projected = Object.freeze({ id: event.id, userId: event.userId, text: event.text, timestamp: event.timestamp, origin: 'transport-unverified' });
    // Scope is a private, per-run identity from a pinned projected acknowledgement.
    // It is not an authentication receipt and never enters public snapshots.
    const scope = run.scope;
    try { await onEvent(projected, scope); }
    catch {
      if (currentRun(target, run)) retire(target, 'callback_failed');
      throw new Error('callback_failed');
    }
    if (currentRun(target, run)) observeBoundary();
  }

  async function connectPort(target, run, args) {
    // A delayed validation receipt may model a longer expiry than the private
    // grant. Observe the vault again before opening any injected connection.
    observeBoundary();
    if (!currentRun(target, run)) throw new Error('inactive');
    const request = Object.freeze({
      signal: args.signal,
      onFrame: async (raw) => {
        observeBoundary();
        if (!currentRun(target, run)) return Object.freeze({ ok: false, code: 'inactive' });
        try {
          const value = await args.onFrame(raw);
          if (currentRun(target, run)) observeBoundary();
          return value;
        } catch {
          if (currentRun(target, run)) retire(target, 'transport_failed');
          return Object.freeze({ ok: false, code: 'transport_failed' });
        }
      },
      onDisconnect: () => {
        if (!currentRun(target, run)) return;
        try { args.onDisconnect(); } catch { /* Only sanitized state is observed. */ }
        if (currentRun(target, run)) observeBoundary();
      },
      onError: () => {
        if (!currentRun(target, run)) return;
        try { args.onError(); } catch { /* No raw transport error enters state. */ }
        if (currentRun(target, run)) observeBoundary();
      },
    });
    const connection = await connect(request);
    const port = closePort(connection);
    if (!currentRun(target, run)) port.close();
    return port;
  }

  function launch(target, pending) {
    if (!currentOperation(target, pending)) return;
    const run = { retired: false, coordinator: null, scope: null };
    target.run = run;
    const vault = target.vault;
    try {
      const http = createTwitchHttpAdapters({ fetch: fetchImpl, clientId, broadcasterId, readerId,
        resolveCredential: (handle) => {
          if (!currentRun(target, run) || handle !== target.handle) throw new Error('inactive');
          return vault.resolveAccess(handle);
        }, timeoutMs: ioTimeoutMs, setTimer, clearTimer });
      const coordinator = createTwitchSession({ clientId, broadcasterId, readerId, now: clock, setTimer, clearTimer, ioTimeoutMs,
        adapters: { validate: http.validate, subscribe: async (args) => {
          const receipt = await http.subscribe(args);
          if (currentRun(target, run) && receipt.httpStatus === 202) {
            const item = receipt.body.data[0];
            // The HTTP projection already checked exact request/identity pins.
            run.scope = Object.freeze({ broadcasterId, readerId, sessionId: item.transport.session_id, subscriptionId: item.id });
          }
          return receipt;
        }, connect: (args) => connectPort(target, run, args) },
        onEvent: (event) => emit(target, run, event) });
      run.coordinator = coordinator;
      if (!currentOperation(target, pending) || !currentRun(target, run)) { retireSlot(run); return; }
      observe(coordinator.start(target.handle), (value) => {
        if (!currentOperation(target, pending) || !currentRun(target, run)) return;
        if (!value?.ok) {
          retire(target, String(value?.code).includes('validation') ? 'validation_failed' : 'transport_failed');
          return;
        }
        observeBoundary();
        if (currentOperation(target, pending) && currentRun(target, run)) settle(pending, true, pending.kind === 'refresh' ? 'refreshed' : 'started');
      }, () => { if (currentOperation(target, pending)) retire(target, 'transport_failed'); });
    } catch { if (currentOperation(target, pending)) retire(target, 'transport_failed'); }
  }

  function start(grant) {
    observeBoundary();
    if (stopped) return Promise.resolve(result(false, 'stopped'));
    if (operation || binding) return Promise.resolve(result(false, 'busy'));
    const target = { retired: false, vault: null, handle: null, run: null, credentialState: { phase: 'empty', expiresAt: null, refreshPending: false }, transportState: null };
    binding = target;
    const pending = begin(target, 'start');
    try {
      const vault = createCredentialVault({ now: clock, refreshTimeoutMs, setTimer, clearTimer });
      target.vault = vault;
      if (!currentOperation(target, pending)) { vault.stop(); return pending.promise; }
      let handle;
      try { handle = vault.store(grant); }
      finally { grant = null; }
      if (!currentOperation(target, pending)) { vault.stop(); return pending.promise; }
      target.handle = handle;
      observeBoundary();
      if (currentOperation(target, pending)) launch(target, pending);
    } catch { if (currentOperation(target, pending)) retire(target, 'invalid_grant'); }
    return pending.promise;
  }

  function refresh(options = {}) {
    observeBoundary();
    if (stopped) return Promise.resolve(result(false, 'stopped'));
    if (operation) return Promise.resolve(result(false, 'busy'));
    const target = binding;
    if (!target?.handle) return Promise.resolve(result(false, 'not_started'));
    const pending = begin(target, 'refresh');
    const vault = target.vault;
    let args;
    try {
      args = dataRecord(options, ['signal'], []);
      if (args.signal !== undefined) Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get.call(args.signal);
    } catch {
      if (currentOperation(target, pending)) retire(target, 'invalid_input');
      return pending.promise;
    }
    // Synchronous generation retirement and I/O abort happen before the vault
    // is allowed to invoke exchange, even if the old close promise never settles.
    retireRun(target);
    if (!currentOperation(target, pending)) return pending.promise;
    observe(vault.refresh(target.handle, { exchange: (input) => {
      if (!currentOperation(target, pending)) throw new Error('inactive');
      return exchange(input);
    }, ...(args.signal !== undefined ? { signal: args.signal } : {}) }), (handle) => {
      if (!currentOperation(target, pending)) return;
      target.handle = handle;
      observeBoundary();
      if (currentOperation(target, pending)) launch(target, pending);
    }, (error) => {
      if (!currentOperation(target, pending)) return;
      const code = codeOf(error, refreshCodes, 'refresh_failed');
      retire(target, code === 'invalid_clock' ? 'invalid_input' : code, code === 'credential_expired' ? 'expired' : 'failed');
    });
    return pending.promise;
  }

  function revoke() {
    if (stopped) return result(false, 'stopped');
    const target = binding;
    if (target) retire(target, 'revoked', 'revoked');
    else { phase = 'revoked'; lastCredential = { phase: 'revoked', expiresAt: null, refreshPending: false }; }
    return result(true, 'revoked');
  }

  function stop() {
    stopped = true;
    const target = binding;
    if (target) retire(target, 'stopped', 'stopped');
    else { phase = 'stopped'; lastCredential = { phase: 'stopped', expiresAt: null, refreshPending: false }; }
    return result(true, 'stopped');
  }

  try { clock(); } catch { throw new Error('invalid_input'); }
  return Object.freeze({ start, refresh, revoke, stop, getState });
}
