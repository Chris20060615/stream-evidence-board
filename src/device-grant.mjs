/**
 * Device-grant protocol HARNESS. Explicit injected adapters/callbacks only:
 * no fetch, socket, browser, OAuth account, filesystem or environment defaults.
 * Synthetic matching receipts never establish authorization or connectivity.
 *
 * Local policies: exact single chat-read scope; refresh token required; bounded
 * one-hour device/interval durations; fixed activation allowlist; any I/O timeout ends
 * this flow without retry. RFC timeout backoff applies only if a client retries.
 * The expiry starts at the original device-request receive clock and never
 * extends. Input clocks must not move backward during an active flow.
 * Private callback arguments already delivered to host code cannot be recalled
 * or securely erased. A callback can retain strings despite later cancellation.
 */
const DEVICE_URL = 'https://id.twitch.tv/oauth2/device';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const SCOPE = 'user:read:chat';
const CANCELLED = Object.freeze({ cancelled: true });
const errors = new WeakMap();
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const own = (value, key) => Object.hasOwn(value, key);
const privateString = (value) => typeof value === 'string' && value.length >= 1 && value.length <= 4_096 && /^[\x21-\x7e]+$/.test(value);
const seconds = (value) => Number.isSafeInteger(value) && value >= 1 && value <= 3_600;
const accessSeconds = (value) => Number.isSafeInteger(value) && value >= 1 && Number.isSafeInteger(value * 1_000);

function failure(code) { const error = new Error(code); errors.set(error, code); return error; }
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
function freeze(value) {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
  return value;
}
function observe(value, success, rejected) {
  // Native promises, including ones with a hostile own .then getter, are
  // observed through the intrinsic. Non-native values are synchronous results;
  // arbitrary thenables are not an additional executable adapter protocol.
  try { void Promise.prototype.then.call(value, success, rejected); }
  catch { success(value); }
}
function isAborted(signal) {
  try { return abortedGetter.call(signal); } catch { throw failure('invalid_input'); }
}
function receipt(input) {
  const value = dataRecord(input, ['httpStatus', 'body']);
  if (!Number.isInteger(value.httpStatus) || value.httpStatus < 100 || value.httpStatus > 599) throw failure('invalid_input');
  return value;
}
function activationUri(input, userCode) {
  if (typeof input !== 'string' || input.length < 1 || input.length > 2_048 || input !== input.trim() || input.includes('#')) throw failure('invalid_device_response');
  const authority = /^https:\/\/([^/?#]+)/i.exec(input)?.[1];
  if (!authority || authority.toLowerCase() !== 'www.twitch.tv') throw failure('invalid_device_response');
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.hostname !== 'www.twitch.tv' || url.port || url.username || url.password || url.pathname !== '/activate') throw failure('invalid_device_response');
  const seen = new Set();
  for (const [key, value] of url.searchParams) {
    if (seen.has(key) || (key !== 'public' && key !== 'device-code') || (key === 'public' && value !== 'true') || (key === 'device-code' && value !== userCode)) throw failure('invalid_device_response');
    seen.add(key);
  }
  return url.href;
}
function deviceResponse(input) {
  try {
    const response = receipt(input);
    if (response.httpStatus !== 200) throw failure('device_rejected');
    const body = dataRecord(response.body, ['device_code', 'user_code', 'verification_uri', 'expires_in', 'interval'], ['device_code', 'user_code', 'verification_uri', 'expires_in']);
    if (!privateString(body.device_code) || typeof body.user_code !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(body.user_code)
      || !seconds(body.expires_in) || (own(body, 'interval') && !seconds(body.interval))) throw failure('invalid_device_response');
    return { deviceCode: body.device_code, userCode: body.user_code, verificationUri: activationUri(body.verification_uri, body.user_code),
      lifetimeMs: body.expires_in * 1_000, intervalMs: (body.interval ?? 5) * 1_000 };
  } catch (error) { throw failure(errors.get(error) === 'device_rejected' ? 'device_rejected' : 'invalid_device_response'); }
}
function scopeValid(input) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return false;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 2 || !keys.includes('0') || !keys.includes('length')) return false;
  const first = Object.getOwnPropertyDescriptor(input, '0');
  const length = Object.getOwnPropertyDescriptor(input, 'length');
  return Boolean(first && own(first, 'value') && first.enumerable && first.value === SCOPE && length && own(length, 'value') && length.value === 1);
}
function pollResponse(input) {
  let response;
  try { response = receipt(input); } catch { throw failure('invalid_token_response'); }
  if (response.httpStatus === 200) {
    try {
      const body = dataRecord(response.body, ['access_token', 'refresh_token', 'expires_in', 'scope', 'token_type']);
      if (!privateString(body.access_token) || !privateString(body.refresh_token) || !accessSeconds(body.expires_in) || !scopeValid(body.scope)
        || typeof body.token_type !== 'string' || body.token_type.length > 20 || body.token_type.toLowerCase() !== 'bearer') throw failure('invalid_token_response');
      return { grant: freeze({ accessToken: body.access_token, refreshToken: body.refresh_token, expiresIn: body.expires_in, scopes: [SCOPE] }) };
    } catch { throw failure('invalid_token_response'); }
  }
  if (response.httpStatus !== 400) throw failure('poll_rejected');
  let code;
  try {
    const keys = Reflect.ownKeys(response.body);
    if (keys.includes('error')) {
      const body = dataRecord(response.body, ['error', 'error_description', 'error_uri'], ['error']);
      if (typeof body.error !== 'string' || body.error.length > 80 || (own(body, 'error_description') && (typeof body.error_description !== 'string' || body.error_description.length > 300))
        || (own(body, 'error_uri') && (typeof body.error_uri !== 'string' || body.error_uri.length > 2_048))) throw failure('unknown_oauth_error');
      code = body.error;
    } else {
      const body = dataRecord(response.body, ['status', 'message']);
      if (body.status !== 400 || typeof body.message !== 'string' || body.message.length > 200) throw failure('unknown_oauth_error');
      if (body.message === 'authorization_pending') code = 'authorization_pending';
      else if (body.message === 'invalid device code') throw failure('invalid_device_code');
      else throw failure('unknown_oauth_error');
    }
  } catch (error) { throw failure(errors.get(error) === 'invalid_device_code' ? 'invalid_device_code' : 'unknown_oauth_error'); }
  if (code === 'authorization_pending' || code === 'slow_down') return { wait: code };
  if (code === 'access_denied') throw failure('authorization_denied');
  if (code === 'expired_token') throw failure('device_expired');
  if (code === 'invalid_grant') throw failure('grant_rejected');
  if (['invalid_request', 'invalid_client', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope'].includes(code)) throw failure('authorization_rejected');
  throw failure('unknown_oauth_error');
}

export function createDeviceGrantHarness(configuration = {}) {
  let config;
  let adapters;
  try {
    config = dataRecord(configuration, ['clientId', 'adapters', 'onPrompt', 'onGrant', 'now', 'setTimer', 'clearTimer', 'ioTimeoutMs'], ['clientId', 'adapters', 'onPrompt', 'onGrant']);
    adapters = dataRecord(config.adapters, ['device', 'poll']);
  } catch { throw failure('invalid_input'); }
  const { clientId, onPrompt, onGrant, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, ioTimeoutMs = 5_000 } = config;
  if (typeof clientId !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(clientId) || [adapters.device, adapters.poll, onPrompt, onGrant, now, setTimer, clearTimer].some((value) => typeof value !== 'function')
    || !Number.isSafeInteger(ioTimeoutMs) || ioTimeoutMs < 1 || ioTimeoutMs > 60_000) throw failure('invalid_input');
  let active = null;
  let stopped = false;
  let last = { phase: 'idle', expiresAt: null, nextPollAt: null, pollIntervalMs: null, pollAttempts: 0, lastCode: 'idle' };

  function current(flow) { return active === flow && !flow.done && !stopped; }
  function clock(flow) {
    let time;
    try { time = now(); } catch { throw failure('invalid_clock'); }
    if (!Number.isSafeInteger(time) || time < 0 || (flow && time < flow.lastClock)) throw failure('invalid_clock');
    if (flow) flow.lastClock = time;
    return time;
  }
  function snapshot() {
    const flow = active ?? last;
    return Object.freeze({ mode: 'device-grant-harness', networkConnected: false, authorizationVerified: false, realTwitchConnected: false,
      phase: flow.phase, busy: active !== null, expiresAt: flow.expiresAt, nextPollAt: flow.nextPollAt,
      pollIntervalMs: flow.pollIntervalMs, pollAttempts: flow.pollAttempts, lastCode: flow.lastCode });
  }
  function result(ok, code) { return Object.freeze({ ok, code, message: 'Device-grant harness only; authorization and connectivity remain unverified.', state: snapshot() }); }
  function clearEntry(flow, entry) {
    if (!entry.active) return;
    entry.active = false;
    flow.timers.delete(entry);
    if (entry.handle !== null) try { clearTimer(entry.handle); } catch { /* No raw cleanup error escapes. */ }
    entry.handle = null;
  }
  function finish(flow, ok, code, phase = 'failed') {
    if (active !== flow || flow.done) return;
    flow.done = true;
    active = null;
    flow.deviceCode = null;
    flow.nextPollAt = null;
    last = { phase, expiresAt: flow.expiresAt, nextPollAt: null, pollIntervalMs: flow.pollIntervalMs, pollAttempts: flow.pollAttempts, lastCode: code };
    const resolve = flow.resolve;
    flow.resolve = null;
    resolve(result(ok, code));
    const cancelled = flow.cancelResolve;
    flow.cancelResolve = null;
    cancelled(CANCELLED);
    const external = flow.external;
    const listener = flow.abortListener;
    flow.external = null;
    flow.abortListener = null;
    if (external && listener) try { EventTarget.prototype.removeEventListener.call(external, 'abort', listener); } catch { /* Native brand already checked. */ }
    const timers = [...flow.timers];
    const controllers = [...flow.controllers];
    flow.controllers.clear();
    // Ownership is detached before timer/abort hooks can synchronously start a
    // new flow. Every cleanup item belongs only to this captured old flow.
    for (const entry of timers) clearEntry(flow, entry);
    for (const controller of controllers) try { controller.abort(); } catch { /* Private callback work cannot be recalled. */ }
  }
  function observeExpiry(flow) {
    if (!current(flow)) return false;
    const time = clock(flow);
    if (!current(flow)) return false;
    if (flow.expiresAt !== null && time >= flow.expiresAt) { finish(flow, false, 'device_expired', 'expired'); return false; }
    return true;
  }
  function ownedTimer(flow, delay, callback) {
    const entry = { active: true, handle: null };
    flow.timers.add(entry);
    try {
      const handle = setTimer(() => {
        if (!current(flow) || !entry.active || !flow.timers.has(entry)) return;
        entry.active = false;
        flow.timers.delete(entry);
        entry.handle = null;
        callback();
      }, Math.max(1, delay));
      if (entry.active && current(flow)) entry.handle = handle;
      else try { clearTimer(handle); } catch { /* Old handle only. */ }
      // Keep operation deadlines referenced, including standalone CLI waits.
      return entry;
    } catch {
      entry.active = false;
      flow.timers.delete(entry);
      throw failure('invalid_input');
    }
  }
  function call(flow, kind, callback, build) {
    if (!observeExpiry(flow)) return Promise.reject(failure('inactive'));
    const controller = new AbortController();
    flow.controllers.add(controller);
    let timer;
    let pending;
    try {
      timer = ownedTimer(flow, ioTimeoutMs, () => finish(flow, false, `${kind}_timeout`));
      if (!current(flow)) return Promise.reject(failure('inactive'));
      pending = new Promise((resolve, reject) => {
        let input;
        try {
          input = build(controller.signal);
          if (!current(flow)) { reject(failure('inactive')); return; }
          const value = callback(input);
          // Box raw synchronous receipts so Promise resolution does not read a
          // foreign .then getter before strict own-data receipt inspection.
          observe(value, (completed) => resolve({ value: completed }), () => reject(failure(`${kind}_failed`)));
        } catch { reject(failure(`${kind}_failed`)); }
        finally { input = null; callback = null; build = null; }
      });
    } catch (error) { pending = Promise.reject(failure(errors.get(error) ?? `${kind}_failed`)); }
    return Promise.race([pending, flow.cancelPromise]).then((value) => {
      if (value === CANCELLED || !observeExpiry(flow)) throw failure('inactive');
      return value;
    }).finally(() => {
      if (timer) clearEntry(flow, timer);
      flow.controllers.delete(controller);
      pending = null;
      callback = null;
      build = null;
    });
  }
  async function wait(flow, deadline) {
    for (let wakes = 0; wakes < 1_000; wakes += 1) {
      if (!observeExpiry(flow)) return false;
      const time = clock(flow);
      if (!current(flow)) return false;
      if (time >= deadline) return true;
      flow.phase = 'waiting';
      flow.nextPollAt = deadline;
      const waiting = new Promise((resolve) => { ownedTimer(flow, deadline - time, () => resolve(true)); });
      const value = await Promise.race([waiting, flow.cancelPromise]);
      if (value === CANCELLED) return false;
      // An early host timer wake cannot authorize an early poll. Recheck the
      // same absolute deadline and reschedule only its remaining duration.
    }
    throw failure('invalid_input');
  }
  async function drive(flow) {
    let response = null;
    let device = null;
    let prompt = null;
    let grant = null;
    let outcome = null;
    let hookTask = null;
    try {
      outcome = await call(flow, 'device', adapters.device, (signal) => Object.freeze({ request: freeze({ method: 'POST', url: DEVICE_URL,
        body: { client_id: clientId, scopes: SCOPE } }), signal }));
      response = outcome.value;
      outcome = null;
      if (!current(flow)) return;
      device = deviceResponse(response);
      response = null;
      if (!current(flow)) return;
      flow.deviceCode = device.deviceCode;
      flow.expiresAt = flow.requestStartedAt + device.lifetimeMs;
      flow.pollIntervalMs = device.intervalMs;
      if (!Number.isSafeInteger(flow.expiresAt)) throw failure('invalid_device_response');
      if (!observeExpiry(flow)) return;
      const expiryClock = clock(flow);
      if (!current(flow)) return;
      ownedTimer(flow, flow.expiresAt - expiryClock, () => finish(flow, false, 'device_expired', 'expired'));
      if (!current(flow)) return;
      flow.phase = 'prompting';
      prompt = Object.freeze({ userCode: device.userCode, verificationUri: device.verificationUri, expiresAt: flow.expiresAt });
      device = null;
      hookTask = call(flow, 'prompt', ({ value, meta }) => onPrompt(value, meta), (signal) => ({ value: prompt, meta: Object.freeze({ signal }) }));
      prompt = null;
      await hookTask;
      hookTask = null;
      if (!observeExpiry(flow)) return;
      for (;;) {
        const next = clock(flow) + flow.pollIntervalMs;
        if (!Number.isSafeInteger(next)) throw failure('invalid_clock');
        if (!await wait(flow, next)) return;
        if (!current(flow)) return;
        flow.phase = 'polling';
        flow.nextPollAt = null;
        flow.pollAttempts += 1;
        outcome = await call(flow, 'poll', adapters.poll, (signal) => Object.freeze({ request: freeze({ method: 'POST', url: TOKEN_URL,
          body: { client_id: clientId, scopes: SCOPE, device_code: flow.deviceCode, grant_type: 'urn:ietf:params:oauth:grant-type:device_code' } }), signal }));
        response = outcome.value;
        outcome = null;
        if (!current(flow)) return;
        let decoded = pollResponse(response);
        response = null;
        if (!current(flow) || !observeExpiry(flow)) return;
        if (decoded.wait) {
          if (decoded.wait === 'slow_down') {
            if (!Number.isSafeInteger(flow.pollIntervalMs + 5_000) || flow.pollIntervalMs + 5_000 > 3_600_000) throw failure('invalid_device_response');
            flow.pollIntervalMs += 5_000;
          }
          continue;
        }
        grant = decoded.grant;
        decoded = null;
        if (!Number.isSafeInteger(clock(flow) + grant.expiresIn * 1_000)) throw failure('invalid_token_response');
        if (!current(flow)) return;
        flow.phase = 'delivering_grant';
        hookTask = call(flow, 'grant', ({ value, meta }) => onGrant(value, meta), (signal) => ({ value: grant, meta: Object.freeze({ signal }) }));
        grant = null;
        await hookTask;
        hookTask = null;
        if (observeExpiry(flow)) finish(flow, true, 'grant_delivered', 'completed');
        return;
      }
    } catch (error) {
      if (current(flow)) {
        const code = errors.get(error) ?? 'invalid_input';
        finish(flow, false, code === 'inactive' ? 'invalid_input' : code, code === 'device_expired' ? 'expired' : 'failed');
      }
    } finally { response = null; device = null; prompt = null; grant = null; outcome = null; hookTask = null; }
  }

  function start(options = {}) {
    if (stopped) return Promise.resolve(result(false, 'stopped'));
    if (active) return Promise.resolve(result(false, 'busy'));
    let resolve;
    let cancelResolve;
    const promise = new Promise((done) => { resolve = done; });
    const cancelPromise = new Promise((done) => { cancelResolve = done; });
    const flow = { done: false, resolve, cancelResolve, cancelPromise, timers: new Set(), controllers: new Set(), deviceCode: null,
      external: null, abortListener: null, phase: 'requesting_device', expiresAt: null, nextPollAt: null, pollIntervalMs: null,
      pollAttempts: 0, lastCode: 'requesting_device', requestStartedAt: null, lastClock: -1 };
    active = flow;
    try {
      const args = dataRecord(options, ['signal'], []);
      if (!current(flow)) return promise;
      if (args.signal !== undefined) {
        isAborted(args.signal);
        flow.external = args.signal;
        flow.abortListener = () => finish(flow, false, 'aborted', 'cancelled');
        EventTarget.prototype.addEventListener.call(args.signal, 'abort', flow.abortListener, { once: true });
        if (isAborted(args.signal)) { finish(flow, false, 'aborted', 'cancelled'); return promise; }
      }
      flow.requestStartedAt = clock(flow);
      if (current(flow)) void drive(flow);
    } catch (error) { if (current(flow)) finish(flow, false, errors.get(error) ?? 'invalid_input'); }
    return promise;
  }
  function cancel() {
    if (stopped) return result(false, 'stopped');
    if (active) finish(active, false, 'cancelled', 'cancelled');
    else last = { ...last, phase: 'cancelled', nextPollAt: null, lastCode: 'cancelled' };
    return result(true, 'cancelled');
  }
  function stop() {
    stopped = true;
    if (active) finish(active, false, 'stopped', 'stopped');
    else last = { ...last, phase: 'stopped', nextPollAt: null, lastCode: 'stopped' };
    return result(true, 'stopped');
  }
  function getState() {
    const flow = active;
    if (flow) try { observeExpiry(flow); } catch { if (current(flow)) finish(flow, false, 'invalid_clock'); }
    return snapshot();
  }
  try { clock(); } catch { throw failure('invalid_input'); }
  return Object.freeze({ start, cancel, stop, getState });
}
