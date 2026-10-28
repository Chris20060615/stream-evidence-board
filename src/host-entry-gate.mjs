/**
 * Local review -> injected owner lifecycle boundary. No default owner, account,
 * HTTP/socket, browser, environment, credential or production trust is supplied.
 * A private local review decision is not proof of human authorization or OAuth.
 */
const aborted = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const own = (value, key) => Object.hasOwn(value, key);
function record(value, allowed, required = allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_input');
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) throw new Error('invalid_input');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string' || !allowed.includes(key)) || required.some((key) => !own(descriptors, key))) throw new Error('invalid_input');
  const result = Object.create(null);
  for (const key of keys) {
    if (!own(descriptors[key], 'value')) throw new Error('invalid_input');
    result[key] = descriptors[key].value;
  }
  return result;
}
function observe(value, yes, no) {
  try { void Promise.prototype.then.call(value, yes, no); }
  catch { yes(value); }
}
function discard(value) { try { void Promise.prototype.then.call(value, () => {}, () => {}); } catch { /* No foreign then property. */ } }

export function createHostEntryGate(configuration = {}) {
  let config;
  try { config = record(configuration,
    ['clientId', 'broadcasterId', 'readerId', 'review', 'createOwner', 'now', 'setTimer', 'clearTimer', 'reviewTimeoutMs', 'startTimeoutMs'],
    ['clientId', 'broadcasterId', 'readerId', 'review', 'createOwner']); }
  catch { throw new Error('invalid_input'); }
  const { clientId, broadcasterId, readerId, review, createOwner, now = Date.now,
    setTimer = setTimeout, clearTimer = clearTimeout, reviewTimeoutMs = 60_000, startTimeoutMs = 5_000 } = config;
  if (typeof clientId !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(clientId)
    || typeof broadcasterId !== 'string' || !/^[0-9]{1,30}$/.test(broadcasterId) || readerId !== broadcasterId
    || [review, createOwner, now, setTimer, clearTimer].some((value) => typeof value !== 'function')
    || !Number.isSafeInteger(reviewTimeoutMs) || reviewTimeoutMs < 1 || reviewTimeoutMs > 300_000
    || !Number.isSafeInteger(startTimeoutMs) || startTimeoutMs < 1 || startTimeoutMs > 60_000) throw new Error('invalid_input');
  const plan = Object.freeze({ mode: 'local-host-entry-review', clientId, broadcasterId, readerId,
    scopes: Object.freeze(['user:read:chat']),
    actions: Object.freeze(['request_device_code', 'poll_token', 'validate_identity', 'subscribe_read_chat', 'open_eventsub']),
    sendsChat: false, persistsCredentials: false, humanAuthorizationVerified: false });
  let current = null;
  let phase = 'idle';
  let stopped = false;
  let tearingDown = 0;
  const disposed = new WeakSet();
  const isCurrent = (run) => current === run && !run.retired && !stopped;
  function snapshot() {
    return Object.freeze({ mode: 'host-entry-gate-harness', phase: stopped ? 'stopped' : phase,
      busy: tearingDown > 0 || phase === 'reviewing' || phase === 'starting', active: !stopped && phase === 'active',
      networkConnected: false, realTwitchConnected: false, authorizationVerified: false, humanAuthorizationVerified: false });
  }
  function result(ok, code) { return Object.freeze({ ok, code, state: snapshot() }); }
  function time() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid_clock');
    return value;
  }
  function clearDeadline(run) {
    if (run.timer !== null) { try { clearTimer(run.timer); } catch { /* Fixed public errors only. */ } }
    run.timer = null;
  }
  function dispose(owner, stopMethod) {
    if (!owner || disposed.has(owner)) return;
    disposed.add(owner);
    try { discard(Reflect.apply(stopMethod, owner, [])); } catch { /* Nonblocking owned cleanup. */ }
  }
  function retire(run, code, next = 'idle') {
    if (current !== run || run.retired) return;
    current = null;
    run.retired = true;
    phase = next;
    clearDeadline(run);
    if (run.external && run.listener) try { EventTarget.prototype.removeEventListener.call(run.external, 'abort', run.listener); } catch { /* Native-signal boundary. */ }
    run.external = null;
    run.listener = null;
    tearingDown += 1;
    try {
      run.controller.abort();
      dispose(run.owner, run.stopMethod);
    } finally { tearingDown -= 1; }
    run.owner = null;
    run.stopMethod = null;
    if (run.resolve) { run.resolve(result(false, code)); run.resolve = null; }
  }
  function schedule(run, ms, code) {
    clearDeadline(run);
    const deadline = time() + ms;
    if (!Number.isSafeInteger(deadline)) throw new Error('invalid_clock');
    if (!isCurrent(run)) return;
    run.deadline = deadline;
    const handle = setTimer(() => { if (isCurrent(run) && run.timer === handle) retire(run, code); }, ms);
    if (!isCurrent(run)) { try { clearTimer(handle); } catch { /* Retired timer cannot admit work. */ } return; }
    run.timer = handle;
  }
  function startBoundary(run) {
    if (!isCurrent(run)) return false;
    let checked;
    try { checked = time(); } catch { retire(run, 'invalid_clock'); return false; }
    if (!isCurrent(run)) return false;
    if (checked >= run.deadline) { retire(run, 'start_timeout'); return false; }
    return true;
  }
  function startOwner(run) {
    if (!isCurrent(run)) return;
    phase = 'starting';
    try { schedule(run, startTimeoutMs, 'start_timeout'); } catch { retire(run, 'invalid_clock'); return; }
    if (!isCurrent(run)) return;
    let owner, methods;
    try {
      owner = createOwner(plan);
      const descriptors = Object.getOwnPropertyDescriptors(owner);
      methods = { start: descriptors.start?.value, stop: descriptors.stop?.value };
      if (!owner || typeof owner !== 'object' || Array.isArray(owner) || [methods.start, methods.stop].some((value) => typeof value !== 'function')) throw new Error();
    } catch {
      if (owner && typeof methods?.stop === 'function') { tearingDown += 1; try { dispose(owner, methods.stop); } finally { tearingDown -= 1; } }
      retire(run, 'owner_unavailable'); return;
    }
    if (!isCurrent(run)) { tearingDown += 1; try { dispose(owner, methods.stop); } finally { tearingDown -= 1; } return; }
    run.owner = owner;
    run.stopMethod = methods.stop;
    // A synchronous factory can consume the entire budget before returning.
    // Timer delivery may be delayed; check the same fixed deadline before I/O.
    if (!startBoundary(run)) return;
    let pending;
    try { pending = Reflect.apply(methods.start, owner, [Object.freeze({ signal: run.controller.signal })]); }
    catch { retire(run, 'start_failed'); return; }
    observe(pending, (receipt) => {
      if (!startBoundary(run)) return;
      let ok;
      try { ok = Object.getOwnPropertyDescriptor(receipt, 'ok')?.value; } catch { /* Fixed failure below. */ }
      if (!startBoundary(run)) return;
      if (ok !== true) { retire(run, 'start_failed'); return; }
      clearDeadline(run);
      // Cleanup may cancel or consume the remaining budget. Neither permits
      // publishing active ownership after the fixed start boundary.
      if (!startBoundary(run)) return;
      phase = 'active';
      if (run.resolve) { run.resolve(result(true, 'started_unverified')); run.resolve = null; }
    }, () => { if (isCurrent(run)) retire(run, 'start_failed'); });
  }
  function start(options = {}) {
    if (stopped) return Promise.resolve(result(false, 'stopped'));
    if (current || tearingDown) return Promise.resolve(result(false, 'busy'));
    let external;
    try {
      const args = record(options, ['signal'], []);
      external = args.signal;
      if (external !== undefined && aborted.call(external)) return Promise.resolve(result(false, 'aborted'));
    } catch { return Promise.resolve(result(false, 'invalid_input')); }
    let resolve;
    const promise = new Promise((done) => { resolve = done; });
    const run = { retired: false, controller: new AbortController(), external, listener: null, owner: null, stopMethod: null,
      resolve, timer: null, deadline: null, decision: Object.freeze({}), decisionIssued: false };
    current = run;
    phase = 'reviewing';
    try {
      if (external !== undefined) {
        run.listener = () => retire(run, 'aborted');
        EventTarget.prototype.addEventListener.call(external, 'abort', run.listener, { once: true });
        if (aborted.call(external)) { retire(run, 'aborted'); return promise; }
      }
      schedule(run, reviewTimeoutMs, 'review_timeout');
      if (!isCurrent(run)) return promise;
      const accept = () => {
        if (!isCurrent(run) || phase !== 'reviewing' || run.decisionIssued) return null;
        let checked;
        try { checked = time(); } catch { retire(run, 'invalid_clock'); return null; }
        if (!isCurrent(run)) return null;
        if (checked >= run.deadline) { retire(run, 'review_timeout'); return null; }
        run.decisionIssued = true;
        return run.decision;
      };
      const pending = review(plan, Object.freeze({ signal: run.controller.signal, expiresAt: run.deadline, accept }));
      observe(pending, (decision) => {
        if (!isCurrent(run)) return;
        let checked;
        try { checked = time(); } catch { retire(run, 'invalid_clock'); return; }
        if (!isCurrent(run)) return;
        if (checked >= run.deadline) { retire(run, 'review_timeout'); return; }
        if (!run.decisionIssued || decision !== run.decision) { retire(run, 'review_denied'); return; }
        startOwner(run);
      }, () => { if (isCurrent(run)) retire(run, 'review_failed'); });
    } catch { if (isCurrent(run)) retire(run, 'review_failed'); }
    return promise;
  }
  function cancel() {
    if (stopped) return result(false, 'stopped');
    if (current) retire(current, 'cancelled');
    return result(true, 'cancelled');
  }
  function stop() {
    stopped = true;
    if (current) retire(current, 'stopped', 'stopped');
    phase = 'stopped';
    return result(true, 'stopped');
  }
  return Object.freeze({ getPlan: () => plan, getState: snapshot, start, cancel, stop });
}
