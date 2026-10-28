/**
 * Private HTTP ports for the device-grant harness. Explicit fetch injection only;
 * no account, credential storage, environment, filesystem or network default.
 * Success receipts intentionally contain PRIVATE instructions/credentials and
 * must never be exposed as public state, logs or HTTP responses.
 *
 * Stream limits apply to bytes accepted/decoded here, not allocations already
 * made by a host fetch implementation. Abort/cancel cleanup is nonblocking and
 * cannot guarantee physical cancellation or erasure of dependency-owned copies.
 */
const DEVICE_URL = 'https://id.twitch.tv/oauth2/device';
const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const SCOPE = 'user:read:chat';
const GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';
const MAX_BYTES = 65_536;
const MAX_READS = MAX_BYTES + 1;
const CANCELLED = Object.freeze({ cancelled: true });
const errors = new WeakMap();
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const byteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const own = (value, key) => Object.hasOwn(value, key);
const ascii = (value) => typeof value === 'string' && value.length >= 1 && value.length <= 4_096 && /^[\x21-\x7e]+$/.test(value);
const seconds = (value) => Number.isSafeInteger(value) && value >= 1 && value <= 3_600;
const accessSeconds = (value) => Number.isSafeInteger(value) && value >= 1 && Number.isSafeInteger(value * 1_000);
const oauthErrors = new Set(['authorization_pending', 'slow_down', 'access_denied', 'expired_token', 'invalid_grant',
  'invalid_request', 'invalid_client', 'unauthorized_client', 'unsupported_grant_type', 'invalid_scope']);

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
function aborted(signal) {
  try { return abortedGetter.call(signal); } catch { throw failure('invalid_input'); }
}
function observeNative(value, fulfilled, rejected) {
  // Do not execute arbitrary .then getters/thenables. A native Promise can be
  // observed even if a dependency installed a hostile own .then property.
  try { void Promise.prototype.then.call(value, fulfilled, rejected); }
  catch { fulfilled(value); }
}
function discard(value) {
  try { void Promise.prototype.then.call(value, () => {}, () => {}); }
  catch { /* Synchronous cleanup result or unsupported arbitrary thenable. */ }
}
function invoke(callback) {
  return new Promise((resolve, reject) => {
    try { observeNative(callback(), (value) => resolve({ value }), reject); }
    catch { reject(failure('request_failed')); }
  });
}
function activationUri(input, code) {
  if (typeof input !== 'string' || input.length < 1 || input.length > 2_048 || input !== input.trim() || input.includes('#')) throw failure('invalid_device_response');
  const authority = /^https:\/\/([^/?#]+)/i.exec(input)?.[1];
  if (!authority || authority.toLowerCase() !== 'www.twitch.tv') throw failure('invalid_device_response');
  const url = new URL(input);
  if (url.protocol !== 'https:' || url.hostname !== 'www.twitch.tv' || url.port || url.username || url.password || url.pathname !== '/activate') throw failure('invalid_device_response');
  const seen = new Set();
  for (const [key, value] of url.searchParams) {
    if (seen.has(key) || (key !== 'public' && key !== 'device-code') || (key === 'public' && value !== 'true') || (key === 'device-code' && value !== code)) throw failure('invalid_device_response');
    seen.add(key);
  }
  return url.href;
}
function validScope(input) {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype) return false;
  const keys = Reflect.ownKeys(input);
  if (keys.length !== 2 || !keys.includes('0') || !keys.includes('length')) return false;
  const first = Object.getOwnPropertyDescriptor(input, '0');
  const length = Object.getOwnPropertyDescriptor(input, 'length');
  return Boolean(first && own(first, 'value') && first.enumerable && first.value === SCOPE && length && own(length, 'value') && length.value === 1);
}
function projectDevice(input) {
  try {
    const body = dataRecord(input, ['device_code', 'user_code', 'verification_uri', 'expires_in', 'interval'], ['device_code', 'user_code', 'verification_uri', 'expires_in']);
    if (!ascii(body.device_code) || typeof body.user_code !== 'string' || !/^[A-Za-z0-9-]{1,128}$/.test(body.user_code)
      || !seconds(body.expires_in) || (own(body, 'interval') && !seconds(body.interval))) throw failure('invalid_device_response');
    return { device_code: body.device_code, user_code: body.user_code, verification_uri: activationUri(body.verification_uri, body.user_code), expires_in: body.expires_in,
      ...(own(body, 'interval') ? { interval: body.interval } : {}) };
  } catch { throw failure('invalid_device_response'); }
}
function projectGrant(input) {
  try {
    const body = dataRecord(input, ['access_token', 'refresh_token', 'expires_in', 'scope', 'token_type']);
    if (!ascii(body.access_token) || !ascii(body.refresh_token) || !accessSeconds(body.expires_in) || !validScope(body.scope)
      || typeof body.token_type !== 'string' || body.token_type.length > 20 || body.token_type.toLowerCase() !== 'bearer') throw failure('invalid_token_response');
    return { access_token: body.access_token, refresh_token: body.refresh_token, expires_in: body.expires_in, scope: [SCOPE], token_type: 'bearer' };
  } catch { throw failure('invalid_token_response'); }
}
function projectError(input) {
  try {
    const keys = Reflect.ownKeys(input);
    if (keys.includes('error')) {
      const body = dataRecord(input, ['error', 'error_description', 'error_uri'], ['error']);
      if (typeof body.error !== 'string' || !oauthErrors.has(body.error)
        || (own(body, 'error_description') && (typeof body.error_description !== 'string' || body.error_description.length > 300))
        || (own(body, 'error_uri') && (typeof body.error_uri !== 'string' || body.error_uri.length > 2_048))) return {};
      return { error: body.error };
    }
    const body = dataRecord(input, ['status', 'message']);
    if (body.status !== 400 || !['authorization_pending', 'invalid device code'].includes(body.message)) return {};
    return { status: 400, message: body.message };
  } catch { return {}; }
}

export function createDeviceGrantHttpAdapters(configuration = {}) {
  let config;
  try { config = dataRecord(configuration, ['clientId', 'fetch', 'timeoutMs', 'setTimer', 'clearTimer'], ['clientId', 'fetch']); }
  catch { throw failure('invalid_input'); }
  const { clientId, fetch: fetchImpl, timeoutMs = 5_000, setTimer = setTimeout, clearTimer = clearTimeout } = config;
  if (typeof clientId !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(clientId) || [fetchImpl, setTimer, clearTimer].some((value) => typeof value !== 'function')
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw failure('invalid_input');

  function encodeRequest(kind, input) {
    try {
      const request = dataRecord(input, ['method', 'url', 'body']);
      if (request.method !== 'POST' || request.url !== (kind === 'device' ? DEVICE_URL : TOKEN_URL)) throw failure('invalid_request');
      const body = dataRecord(request.body, kind === 'device' ? ['client_id', 'scopes'] : ['client_id', 'scopes', 'device_code', 'grant_type']);
      if (body.client_id !== clientId || body.scopes !== SCOPE || (kind === 'poll' && (!ascii(body.device_code) || body.grant_type !== GRANT_TYPE))) throw failure('invalid_request');
      // Only copied primitives reach this single serialization. No later read of
      // the caller's object can change pins or form bytes through a Proxy trap.
      const form = new URLSearchParams();
      form.append('client_id', clientId);
      form.append('scopes', SCOPE);
      if (kind === 'poll') { form.append('device_code', body.device_code); form.append('grant_type', GRANT_TYPE); }
      return form.toString();
    } catch { throw failure('invalid_request'); }
  }

  async function run(kind, input) {
    let args = null;
    let encoded = null;
    let fetchOptions = null;
    let response = null;
    let body = null;
    let reader = null;
    let text = null;
    let parsed = null;
    let external = null;
    let listener = null;
    let controller = null;
    let timer = null;
    let disposed = false;
    let abortCode = null;
    let consumed = false;
    let cancelResolve = null;
    const cancelledBodies = new WeakSet();
    const cancelledReaders = new WeakSet();

    function cancelReader(target) {
      if (!target || (typeof target !== 'object' && typeof target !== 'function') || cancelledReaders.has(target)) return;
      cancelledReaders.add(target);
      try { if (typeof target.cancel === 'function') discard(target.cancel()); } catch { /* No await or raw cleanup error. */ }
    }
    function cancelResponse(target) {
      try {
        const stream = target?.body;
        if (!stream || (typeof stream !== 'object' && typeof stream !== 'function') || cancelledBodies.has(stream)) return;
        cancelledBodies.add(stream);
        if (typeof stream.cancel === 'function') discard(stream.cancel());
        else if (typeof stream.getReader === 'function') {
          const temporary = stream.getReader();
          cancelReader(temporary);
          try { discard(temporary.releaseLock?.()); } catch { /* Nonblocking cleanup. */ }
        }
      } catch { /* An uncooperative dependency cannot inject an error message. */ }
    }
    function cancelOwned() {
      if (reader) {
        if (body && (typeof body === 'object' || typeof body === 'function')) cancelledBodies.add(body);
        cancelReader(reader);
      } else cancelResponse(response);
    }
    function abort(code) {
      if (disposed || abortCode) return;
      abortCode = code;
      try { controller?.abort(); } catch { /* Native signal, host callbacks may fail. */ }
      cancelOwned();
      cancelResolve?.(CANCELLED);
    }
    function ensureActive() { if (abortCode) throw failure(abortCode); }

    try {
      args = dataRecord(input, ['request', 'signal'], ['request']);
      input = null;
      encoded = encodeRequest(kind, args.request);
      args.request = null;
      external = args.signal;
      if (external !== undefined && aborted(external)) throw failure('aborted');
      controller = new AbortController();
      const cancelled = new Promise((resolve) => { cancelResolve = resolve; });
      if (external !== undefined) {
        listener = () => abort('aborted');
        EventTarget.prototype.addEventListener.call(external, 'abort', listener, { once: true });
        if (aborted(external)) abort('aborted');
      }
      timer = setTimer(() => abort('timeout'), timeoutMs);
      // Keep this per-operation deadline referenced even when injected I/O owns
      // no event-loop handles. It covers both fetch and the complete body read.
      ensureActive();
      fetchOptions = Object.freeze({ method: 'POST', headers: Object.freeze({ 'Content-Type': 'application/x-www-form-urlencoded' }), body: encoded,
        signal: controller.signal, redirect: 'error', credentials: 'omit', cache: 'no-store' });
      const pending = invoke(() => { ensureActive(); return fetchImpl(kind === 'device' ? DEVICE_URL : TOKEN_URL, fetchOptions); });
      // Observe a late response even when the injected fetch ignored abort.
      void pending.then((completed) => { if (disposed || abortCode) cancelResponse(completed.value); }, () => {});
      const completed = await Promise.race([pending, cancelled]);
      ensureActive();
      if (completed === CANCELLED) throw failure('aborted');
      response = completed.value;
      const status = response?.status;
      ensureActive();
      if (!Number.isInteger(status) || status < 100 || status > 599) throw failure('invalid_response');
      if (status !== 200 && !(kind === 'poll' && status === 400)) return freeze({ httpStatus: status, body: {} });
      body = response.body;
      ensureActive();
      if (!body || typeof body.getReader !== 'function') throw failure('invalid_response');
      reader = body.getReader();
      ensureActive();
      if (!reader || typeof reader.read !== 'function') throw failure('invalid_response');
      const decoder = new TextDecoder('utf-8', { fatal: true });
      text = '';
      let bytes = 0;
      for (let reads = 0; ; reads += 1) {
        if (reads >= MAX_READS) throw failure('body_limit');
        const completedRead = await Promise.race([invoke(() => { ensureActive(); return reader.read(); }), cancelled]);
        ensureActive();
        if (completedRead === CANCELLED) throw failure('aborted');
        let chunk;
        try { chunk = dataRecord(completedRead.value, ['done', 'value'], ['done']); } catch { ensureActive(); throw failure('invalid_response'); }
        ensureActive();
        if (typeof chunk.done !== 'boolean') throw failure('invalid_response');
        if (chunk.done) break;
        const value = chunk.value;
        // A decorated real typed array can shadow .byteLength. Count its native
        // view length without invoking an own getter; proxies fail the brand.
        let chunkBytes;
        try {
          if (!(value instanceof Uint8Array)) throw failure('invalid_response');
          chunkBytes = byteLengthGetter.call(value);
        } catch { ensureActive(); throw failure('invalid_response'); }
        ensureActive();
        bytes += chunkBytes;
        if (bytes > MAX_BYTES) throw failure('body_limit');
        let span;
        try { span = new Uint8Array(bufferGetter.call(value), byteOffsetGetter.call(value), chunkBytes); }
        catch { ensureActive(); throw failure('invalid_response'); }
        ensureActive();
        // Decode only the snapshotted native span. Caller view properties,
        // iterators and species cannot substitute bytes during stream decode.
        try { text += decoder.decode(span, { stream: true }); } catch { throw failure('invalid_utf8'); }
      }
      try { text += decoder.decode(); } catch { throw failure('invalid_utf8'); }
      ensureActive();
      try { parsed = JSON.parse(text); } catch { throw failure('invalid_json'); }
      const projected = status === 400 ? projectError(parsed) : kind === 'device' ? projectDevice(parsed) : projectGrant(parsed);
      consumed = true;
      return freeze({ httpStatus: status, body: projected });
    } catch (error) { throw failure(abortCode ?? errors.get(error) ?? 'request_failed'); }
    finally {
      disposed = true;
      if (timer !== null) try { clearTimer(timer); } catch { /* Fixed local errors only. */ }
      if (external !== undefined && external !== null && listener) try { EventTarget.prototype.removeEventListener.call(external, 'abort', listener); } catch { /* Native brand already checked. */ }
      if (!consumed) {
        try { controller?.abort(); } catch { /* No physical cancellation guarantee. */ }
        cancelOwned();
      }
      try { discard(reader?.releaseLock?.()); } catch { /* A pending reader cannot block settlement. */ }
      if (args) args.request = null;
      args = null;
      input = null;
      encoded = null;
      fetchOptions = null;
      response = null;
      body = null;
      reader = null;
      parsed = null;
      text = null;
      external = null;
      listener = null;
      controller = null;
      cancelResolve = null;
    }
  }

  return Object.freeze({ device: (input) => run('device', input), poll: (input) => run('poll', input) });
}
