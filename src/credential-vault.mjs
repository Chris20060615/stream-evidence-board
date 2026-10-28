/**
 * In-memory credential lifecycle HARNESS, with no OAuth, network, environment,
 * filesystem, client identity or token-validation integration. The exact chat
 * scope below is a local policy, not a claim about Twitch's required scopes.
 * resolveAccess is for a privileged private HTTP resolver, never a UI/JSON API.
 * Clearing module-owned references is not secure erasure: callers/exchange or
 * HTTP adapters may retain arguments, headers, tokens or outstanding work.
 */
const failures = new WeakMap();
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const token = (value) => typeof value === 'string' && value.length >= 1 && value.length <= 4_096 && /^[\x21-\x7e]+$/.test(value);
const own = (value, key) => Object.hasOwn(value, key);

function failure(code) {
  const error = new Error(code);
  failures.set(error, code);
  return error;
}

function dataRecord(input, allowed, required = allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw failure('invalid_input');
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) throw failure('invalid_input');
  const keys = Reflect.ownKeys(input);
  if (keys.length > allowed.length || keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) throw failure('invalid_input');
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !own(descriptor, 'value') || !descriptor.enumerable) throw failure('invalid_input');
    result[key] = descriptor.value;
  }
  if (required.some((key) => !own(result, key))) throw failure('invalid_input');
  return result;
}

function grantSnapshot(input) {
  try {
    const grant = dataRecord(input, ['accessToken', 'refreshToken', 'expiresIn', 'scopes']);
    if (!token(grant.accessToken) || !token(grant.refreshToken) || !Number.isSafeInteger(grant.expiresIn) || grant.expiresIn < 1
      || !Number.isSafeInteger(grant.expiresIn * 1_000) || !Array.isArray(grant.scopes) || Object.getPrototypeOf(grant.scopes) !== Array.prototype) throw failure('invalid_grant');
    const keys = Reflect.ownKeys(grant.scopes);
    if (keys.length !== 2 || !keys.includes('0') || !keys.includes('length')) throw failure('invalid_grant');
    const index = Object.getOwnPropertyDescriptor(grant.scopes, '0');
    const length = Object.getOwnPropertyDescriptor(grant.scopes, 'length');
    if (!index || !own(index, 'value') || !index.enumerable || index.value !== 'user:read:chat'
      || !length || !own(length, 'value') || length.value !== 1) throw failure('invalid_grant');
    return { accessToken: grant.accessToken, refreshToken: grant.refreshToken, durationMs: grant.expiresIn * 1_000 };
  } catch { throw failure('invalid_grant'); }
}

function nativeAborted(signal) {
  try { return abortedGetter.call(signal); } catch { throw failure('invalid_input'); }
}

// A rejected native Promise may have a hostile own .then getter. Observe it
// through the native intrinsic first; ordinary thenables remain bounded by the
// operation deadline. Neither their errors nor arbitrary getters are echoed.
function observe(value, success, reject) {
  try { void Promise.prototype.then.call(value, success, reject); }
  catch { void Promise.resolve(value).then(success, reject); }
}

export function createCredentialVault(configuration = {}) {
  let config;
  try { config = dataRecord(configuration, ['now', 'refreshTimeoutMs', 'setTimer', 'clearTimer'], []); }
  catch { throw failure('invalid_input'); }
  const { now = Date.now, refreshTimeoutMs = 5_000, setTimer = setTimeout, clearTimer = clearTimeout } = config;
  if (typeof now !== 'function' || typeof setTimer !== 'function' || typeof clearTimer !== 'function'
    || !Number.isSafeInteger(refreshTimeoutMs) || refreshTimeoutMs < 1 || refreshTimeoutMs > 60_000) throw failure('invalid_input');

  const handles = new WeakMap();
  let currentHandle = null;
  let currentRecord = null;
  let pending = null;
  let epoch = {};
  let phase = 'empty';
  let stopped = false;

  function clock() {
    let time;
    try { time = now(); } catch { throw failure('invalid_clock'); }
    if (!Number.isSafeInteger(time) || time < 0) throw failure('invalid_clock');
    return time;
  }

  function snapshot() {
    return Object.freeze({
      mode: 'credential-memory-harness',
      authorizationVerified: false,
      networkConnected: false,
      realTwitchConnected: false,
      phase,
      expiresAt: currentRecord?.expiresAt ?? null,
      refreshPending: pending !== null,
    });
  }

  function scrub(record, status) {
    if (!record) return;
    record.accessToken = null;
    record.refreshToken = null;
    record.status = status;
  }

  function cleanup(operation, abort = true) {
    const timer = operation.timer;
    operation.timer = null;
    if (timer !== null) try { clearTimer(timer); } catch { /* Nonblocking best effort. */ }
    if (operation.externalSignal && operation.onAbort) {
      try { EventTarget.prototype.removeEventListener.call(operation.externalSignal, 'abort', operation.onAbort); } catch { /* No raw host error escapes. */ }
    }
    operation.externalSignal = null;
    operation.onAbort = null;
    if (abort) try { operation.controller.abort(); } catch { /* Host callbacks cannot prevent retirement. */ }
  }

  function retire(status, nextPhase, cancellationCode) {
    const transition = {};
    epoch = transition;
    const operation = pending;
    pending = null;
    const record = currentRecord;
    currentRecord = null;
    currentHandle = null;
    scrub(record, status);
    phase = nextPhase;
    // Mark and clear ownership before aborting; synchronous host callbacks may
    // replace the grant, and this old operation must never clear that new grant.
    if (operation) {
      operation.done = true;
      cleanup(operation);
      operation.reject(failure(cancellationCode));
    }
    return transition;
  }

  function boundary() {
    if (stopped) return null;
    let time;
    try { time = clock(); }
    catch {
      retire('failed', 'failed', 'invalid_clock');
      throw failure('invalid_clock');
    }
    if (currentRecord && time >= currentRecord.expiresAt) retire('expired', 'expired', 'credential_expired');
    return time;
  }

  function handleProblem(handle) {
    // Identity lookup does not traverse even a foreign/revoked Proxy handle.
    const record = handle && typeof handle === 'object' ? handles.get(handle) : undefined;
    if (!record) return 'invalid_handle';
    if (record.status === 'expired') return 'credential_expired';
    if (record !== currentRecord || handle !== currentHandle) return 'credential_revoked';
    return null;
  }

  function install(grant, time) {
    if (!Number.isSafeInteger(time + grant.durationMs)) throw failure('invalid_grant');
    const handle = Object.freeze({
      opaque: Object.freeze(() => undefined),
      toJSON: Object.freeze(() => { throw failure('handle_not_serializable'); }),
    });
    currentRecord = { accessToken: grant.accessToken, refreshToken: grant.refreshToken, expiresAt: time + grant.durationMs, status: 'ready' };
    currentHandle = handle;
    handles.set(handle, currentRecord);
    phase = 'ready';
    return handle;
  }

  function store(input) {
    if (stopped) throw failure('stopped');
    const attempt = retire('replaced', 'failed', 'credential_replaced');
    if (stopped) throw failure('stopped');
    if (epoch !== attempt) throw failure('credential_replaced');
    let grant;
    try { grant = grantSnapshot(input); }
    catch {
      if (stopped) throw failure('stopped');
      if (epoch !== attempt) throw failure('credential_replaced');
      throw failure('invalid_grant');
    }
    if (stopped) throw failure('stopped');
    if (epoch !== attempt) throw failure('credential_replaced');
    let time;
    try { time = clock(); }
    catch { throw failure('invalid_clock'); }
    if (stopped) throw failure('stopped');
    if (epoch !== attempt) throw failure('credential_replaced');
    return install(grant, time);
  }

  function resolveAccess(handle) {
    boundary();
    if (stopped) throw failure('stopped');
    const problem = handleProblem(handle);
    if (problem) throw failure(problem);
    if (pending) throw failure('refresh_in_progress');
    return currentRecord.accessToken;
  }

  function current(operation) {
    return !operation.done && pending === operation && currentRecord === operation.record && currentHandle === operation.handle && epoch === operation.epoch && !stopped;
  }

  function failOperation(operation, code) {
    if (!current(operation)) return;
    const status = code === 'credential_expired' ? 'expired' : 'failed';
    retire(status, status, code);
  }

  function accept(operation, input) {
    if (!current(operation)) return;
    let grant;
    let time;
    try {
      grant = grantSnapshot(input);
      if (!current(operation)) return;
      time = boundary();
      if (!current(operation)) return;
      if (!Number.isSafeInteger(time + grant.durationMs)) throw failure('invalid_grant');
    } catch (error) {
      failOperation(operation, failures.get(error) === 'invalid_clock' ? 'invalid_clock' : 'invalid_grant');
      return;
    }
    // Snapshot and clock calls can reenter via injected host code/Proxy traps.
    // Only the still-current operation may install a replacement handle.
    if (!current(operation)) return;
    pending = null;
    operation.done = true;
    scrub(operation.record, 'replaced');
    currentRecord = null;
    currentHandle = null;
    epoch = {};
    const handle = install(grant, time);
    cleanup(operation, false);
    operation.resolve(handle);
  }

  function refresh(handle, options) {
    try {
      boundary();
      if (stopped) throw failure('stopped');
      const problem = handleProblem(handle);
      if (problem) throw failure(problem);
      if (pending) throw failure('refresh_in_progress');
      const originalRecord = currentRecord;
      const originalEpoch = epoch;
      const args = dataRecord(options, ['exchange', 'signal'], ['exchange']);
      if (typeof args.exchange !== 'function') throw failure('invalid_input');
      if (args.signal !== undefined) nativeAborted(args.signal);
      const admissionTime = boundary();
      if (stopped) throw failure('stopped');
      const admissionProblem = handleProblem(handle);
      if (admissionProblem) throw failure(admissionProblem);
      if (currentRecord !== originalRecord || epoch !== originalEpoch) throw failure('credential_replaced');
      // Options/clock inspection can synchronously start a valid inner refresh.
      // Do not replace its operation or leave its caller's promise unsettled.
      if (pending) throw failure('refresh_in_progress');
      if (args.signal !== undefined && nativeAborted(args.signal)) {
        retire('failed', 'failed', 'aborted');
        throw failure('aborted');
      }

      let resolve;
      let reject;
      const output = new Promise((done, failed) => { resolve = done; reject = failed; });
      const operation = { record: originalRecord, handle, epoch, resolve, reject, controller: new AbortController(), timer: null, externalSignal: args.signal ?? null, onAbort: null, done: false };
      pending = operation;
      currentRecord.status = 'refreshing';
      phase = 'refreshing';
      try {
        if (operation.externalSignal) {
          operation.onAbort = () => failOperation(operation, 'aborted');
          EventTarget.prototype.addEventListener.call(operation.externalSignal, 'abort', operation.onAbort, { once: true });
          if (nativeAborted(operation.externalSignal)) failOperation(operation, 'aborted');
        }
        if (!current(operation)) return output;
        const remaining = originalRecord.expiresAt - admissionTime;
        const deadlineCode = remaining <= refreshTimeoutMs ? 'credential_expired' : 'refresh_timeout';
        // An outstanding operation keeps its real deadline referenced, including
        // in a standalone CLI with an injected exchange that never settles.
        const timer = setTimer(() => failOperation(operation, deadlineCode), Math.min(remaining, refreshTimeoutMs));
        if (current(operation)) operation.timer = timer;
        else try { clearTimer(timer); } catch { /* No timer cleanup error escapes. */ }
        if (!current(operation)) return output;
        let refreshToken = originalRecord.refreshToken;
        let value;
        try { value = args.exchange({ refreshToken, signal: operation.controller.signal }); }
        finally { refreshToken = null; }
        observe(value, (grant) => accept(operation, grant), () => failOperation(operation, 'refresh_failed'));
      } catch { failOperation(operation, 'refresh_failed'); }
      return output;
    } catch (error) {
      return Promise.reject(failure(failures.get(error) ?? 'invalid_input'));
    }
  }

  function revoke(handle) {
    boundary();
    if (stopped) return Object.freeze({ ok: false, code: 'stopped', state: snapshot() });
    const problem = handleProblem(handle);
    if (problem) return Object.freeze({ ok: false, code: problem, state: snapshot() });
    retire('revoked', 'revoked', 'credential_revoked');
    return Object.freeze({ ok: true, code: 'revoked', state: snapshot() });
  }

  function stop() {
    stopped = true;
    retire('stopped', 'stopped', 'stopped');
    return Object.freeze({ ok: true, code: 'stopped', state: snapshot() });
  }

  function getState() { boundary(); return snapshot(); }
  clock();
  return Object.freeze({ store, resolveAccess, refresh, revoke, stop, getState });
}
