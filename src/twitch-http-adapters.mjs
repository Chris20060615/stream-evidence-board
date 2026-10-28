/**
 * Restricted HTTP adapters for a future authorized host. No global fetch,
 * environment, filesystem, OAuth flow, WebSocket or server integration exists.
 * Both fetch and the synchronous opaque-credential resolver must be injected.
 *
 * Credentials are used only in outgoing Authorization values. Private references
 * are cleared in finally; this is not a promise of secure erasure, and injected
 * dependencies remain responsible for references they retain. Returned receipts
 * are projections, not proof that an injected service is Twitch.
 */
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';
const SUBSCRIBE_URL = 'https://api.twitch.tv/helix/eventsub/subscriptions';
const MAX_BODY_BYTES = 65_536;
const MAX_READS = MAX_BODY_BYTES + 1;
const knownErrors = new WeakSet();
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const byteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const numericId = (value) => typeof value === 'string' && /^[1-9][0-9]{0,24}$/.test(value);
const safeId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function failure(code) {
  const error = new Error(code);
  knownErrors.add(error);
  return error;
}

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

function ownData(value, required, optional = []) {
  if (!plain(value)) throw failure('invalid_request');
  const keys = Reflect.ownKeys(value);
  const allowed = new Set([...required, ...optional]);
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key)) || required.some((key) => !Object.hasOwn(value, key))) throw failure('invalid_request');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null);
  for (const key of keys) {
    if (!('value' in descriptors[key])) throw failure('invalid_request');
    result[key] = descriptors[key].value;
  }
  return result;
}

function containsToken(value, token) {
  if (typeof value === 'string') return value.includes(token);
  if (value && typeof value === 'object') return Object.values(value).some((child) => containsToken(child, token));
  return false;
}

function ignoreCleanup(value) {
  // Observe native rejection without awaiting cleanup or assimilating an
  // arbitrary thenable/getter supplied by an injected dependency.
  try { void Promise.prototype.then.call(value, () => {}, () => {}); } catch { /* No cleanup error escapes. */ }
}

function rejectAsyncResolver(value) {
  // Native rejected Promises must not become unhandled rejections. Do not read
  // an arbitrary then getter or assimilate a caller-supplied thenable.
  if (value && (typeof value === 'object' || typeof value === 'function')) {
    try { void Promise.prototype.then.call(value, () => {}, () => {}); } catch { /* Not a native Promise. */ }
  }
}

export function createTwitchHttpAdapters(configuration = {}) {
  let config;
  try {
    config = ownData(configuration, ['fetch', 'resolveCredential', 'clientId', 'broadcasterId', 'readerId'], ['timeoutMs', 'setTimer', 'clearTimer']);
  } catch { throw failure('invalid_input'); }
  const {
    fetch: fetchImpl, resolveCredential, clientId, broadcasterId, readerId,
    timeoutMs = 5_000, setTimer = setTimeout, clearTimer = clearTimeout,
  } = config;
  if (typeof fetchImpl !== 'function' || typeof resolveCredential !== 'function') throw failure('invalid_input');
  if (typeof clientId !== 'string' || !/^[A-Za-z0-9]{1,128}$/.test(clientId) || !numericId(broadcasterId) || !numericId(readerId)) throw failure('invalid_input');
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000 || typeof setTimer !== 'function' || typeof clearTimer !== 'function') throw failure('invalid_input');

  function requestBody(request) {
    const data = ownData(request, ['method', 'url', 'body']);
    if (data.method !== 'POST' || data.url !== SUBSCRIBE_URL) throw failure('invalid_request');
    const body = ownData(data.body, ['type', 'version', 'condition', 'transport']);
    const condition = ownData(body.condition, ['broadcaster_user_id', 'user_id']);
    const transport = ownData(body.transport, ['method', 'session_id']);
    if (body.type !== 'channel.chat.message' || body.version !== '1'
      || condition.broadcaster_user_id !== broadcasterId || condition.user_id !== readerId
      || transport.method !== 'websocket' || !safeId(transport.session_id)) throw failure('invalid_request');
    return freezeCopy({
      type: body.type,
      version: body.version,
      condition: { broadcaster_user_id: condition.broadcaster_user_id, user_id: condition.user_id },
      transport: { method: transport.method, session_id: transport.session_id },
    });
  }

  function projectValidation(body) {
    if (!plain(body)) throw failure('invalid_response');
    if (body.client_id !== clientId || body.user_id !== readerId) throw failure('identity_mismatch');
    if (!Array.isArray(body.scopes) || body.scopes.length > 100
      || body.scopes.some((scope) => typeof scope !== 'string' || scope.length < 1 || scope.length > 200)) throw failure('invalid_response');
    if (!body.scopes.includes('user:read:chat')) throw failure('missing_scope');
    if (!Number.isSafeInteger(body.expires_in) || body.expires_in < 1 || !Number.isSafeInteger(body.expires_in * 1_000)) throw failure('invalid_expiry');
    // This deliberately reports the required read scope only, not a complete
    // inventory of every permission the service may have returned.
    return { client_id: body.client_id, user_id: body.user_id, scopes: ['user:read:chat'], expires_in: body.expires_in };
  }

  function projectSubscription(body, expected) {
    if (!plain(body) || !Array.isArray(body.data) || body.data.length !== 1 || !plain(body.data[0])) throw failure('invalid_ack');
    const item = body.data[0];
    const condition = item.condition;
    const transport = item.transport;
    if (!safeId(item.id) || item.status !== 'enabled' || item.type !== expected.type || item.version !== expected.version
      || !plain(condition) || Object.keys(condition).sort().join(',') !== 'broadcaster_user_id,user_id'
      || condition.broadcaster_user_id !== expected.condition.broadcaster_user_id || condition.user_id !== expected.condition.user_id
      || !plain(transport) || transport.method !== expected.transport.method || transport.session_id !== expected.transport.session_id) throw failure('invalid_ack');
    // Response transport may legitimately contain connected_at. Preserve actual
    // checked values and discard ordinary metadata; never repair a mismatch.
    return { data: [{
      id: item.id,
      status: item.status,
      type: item.type,
      version: item.version,
      condition: { broadcaster_user_id: condition.broadcaster_user_id, user_id: condition.user_id },
      transport: { method: transport.method, session_id: transport.session_id },
    }] };
  }

  async function run(kind, options) {
    let token = null;
    let headers = null;
    let fetchOptions = null;
    let fetchedResponse = null;
    let bodyStream = null;
    let reader = null;
    let text = null;
    let parsed = null;
    let external = null;
    let externalListener = null;
    let timer;
    let controller;
    let disposed = false;
    let bodyConsumed = false;
    let abortCode = null;
    let rejectCancellation;
    let args = null;
    const cancelledReaders = new WeakSet();
    const cancelledBodies = new WeakSet();

    function cancelReader(target) {
      if (!target || (typeof target !== 'object' && typeof target !== 'function') || cancelledReaders.has(target)) return;
      cancelledReaders.add(target);
      try { if (typeof target.cancel === 'function') ignoreCleanup(target.cancel()); } catch { /* Deliberately suppressed. */ }
    }
    function cancelResponse(response) {
      try {
        const body = response?.body;
        if (!body || (typeof body !== 'object' && typeof body !== 'function') || cancelledBodies.has(body)) return;
        cancelledBodies.add(body);
        if (typeof body.cancel === 'function') ignoreCleanup(body.cancel());
        else if (typeof body.getReader === 'function') {
          const temporary = body.getReader();
          cancelReader(temporary);
          try { ignoreCleanup(temporary.releaseLock?.()); } catch { /* Deliberately suppressed. */ }
        }
      } catch { /* Never reflect a raw body/cleanup exception. */ }
    }
    function cancelOwnedBody() {
      if (reader) {
        if (bodyStream && typeof bodyStream === 'object') cancelledBodies.add(bodyStream);
        cancelReader(reader);
      } else cancelResponse(fetchedResponse);
    }
    function abort(code) {
      if (disposed || abortCode) return;
      abortCode = code;
      try { controller?.abort(); } catch { /* Deliberately suppressed. */ }
      cancelOwnedBody();
      rejectCancellation?.(failure(code));
    }
    function ensureActive() { if (abortCode) throw failure(abortCode); }

    try {
      // Inspect all externally supplied request fields before the resolver runs.
      // The credential itself is opaque: do not traverse or read its internals.
      args = ownData(options, kind === 'subscribe' ? ['credential', 'request'] : ['credential'], ['signal']);
      options = null;
      if (!args.credential || typeof args.credential !== 'object' || Array.isArray(args.credential)) throw failure('invalid_input');
      const expected = kind === 'subscribe' ? requestBody(args.request) : null;
      external = args.signal;
      if (external !== undefined) {
        try { if (abortedGetter.call(external)) throw failure('aborted'); }
        catch (error) { if (knownErrors.has(error)) throw error; throw failure('invalid_input'); }
      }
      controller = new AbortController();
      const cancelled = new Promise((_, reject) => { rejectCancellation = reject; });
      // Prevent an early synchronous abort during credential resolution from
      // producing an unhandled rejection before the first race is attached.
      void cancelled.catch(() => {});
      if (external !== undefined) {
        externalListener = () => abort('aborted');
        EventTarget.prototype.addEventListener.call(external, 'abort', externalListener, { once: true });
        if (abortedGetter.call(external)) abort('aborted');
      }
      timer = setTimer(() => abort('timeout'), timeoutMs);
      // This operation's deadline stays referenced so a standalone caller can
      // await timeout settlement even when injected I/O owns no other handles.
      ensureActive();
      try { token = resolveCredential(args.credential); } catch { throw failure('credential_resolution_failed'); }
      args.credential = null;
      if (typeof token !== 'string' || token.length < 1 || token.length > 4_096 || !/^[\x21-\x7e]+$/.test(token)) {
        rejectAsyncResolver(token);
        throw failure('invalid_credential');
      }
      ensureActive();
      if (kind === 'subscribe' && (clientId.includes(token) || containsToken(expected, token))) throw failure('credential_echo');
      headers = kind === 'validate'
        ? { Authorization: `OAuth ${token}` }
        : { Authorization: `Bearer ${token}`, 'Client-Id': clientId, 'Content-Type': 'application/json' };
      fetchOptions = {
        method: kind === 'validate' ? 'GET' : 'POST',
        headers,
        signal: controller.signal,
        redirect: 'error',
        credentials: 'omit',
        cache: 'no-store',
        ...(expected ? { body: JSON.stringify(expected) } : {}),
      };
      const pendingFetch = Promise.resolve().then(() => {
        ensureActive();
        return fetchImpl(kind === 'validate' ? VALIDATE_URL : SUBSCRIBE_URL, fetchOptions);
      }).then((response) => {
        if (disposed || abortCode) { cancelResponse(response); return null; }
        fetchedResponse = response;
        return response;
      });
      const response = await Promise.race([pendingFetch, cancelled]);
      ensureActive();
      const status = response?.status;
      if (!Number.isInteger(status) || status < 100 || status > 599) throw failure('invalid_response');
      if (status !== (kind === 'validate' ? 200 : 202)) {
        cancelResponse(response);
        return freezeCopy({ httpStatus: status, body: {} });
      }
      bodyStream = response.body;
      if (!bodyStream || typeof bodyStream.getReader !== 'function') throw failure('invalid_response');
      reader = bodyStream.getReader();
      if (!reader || typeof reader.read !== 'function') throw failure('invalid_response');
      const decoder = new TextDecoder('utf-8', { fatal: true });
      let bytes = 0;
      text = '';
      for (let reads = 0; ; reads += 1) {
        if (reads >= MAX_READS) throw failure('body_limit');
        const chunk = await Promise.race([Promise.resolve().then(() => { ensureActive(); return reader.read(); }), cancelled]);
        ensureActive();
        let snapshot;
        try { snapshot = ownData(chunk, ['done'], ['value']); } catch { ensureActive(); throw failure('invalid_response'); }
        ensureActive();
        if (typeof snapshot.done !== 'boolean') throw failure('invalid_response');
        if (snapshot.done) break;
        // Read the descriptor snapshot once. A getter cannot switch the view
        // between the brand check, byte count and decode.
        const value = snapshot.value;
        let chunkBytes;
        // Typed arrays may shadow .byteLength; the intrinsic counts the actual
        // view and rejects proxies without consulting an own getter.
        try {
          if (!(value instanceof Uint8Array)) throw failure('invalid_response');
          chunkBytes = byteLengthGetter.call(value);
        } catch { ensureActive(); throw failure('invalid_response'); }
        ensureActive();
        bytes += chunkBytes;
        if (bytes > MAX_BODY_BYTES) throw failure('body_limit');
        let span;
        try { span = new Uint8Array(bufferGetter.call(value), byteOffsetGetter.call(value), chunkBytes); }
        catch { ensureActive(); throw failure('invalid_response'); }
        ensureActive();
        // Stream decoders may read view properties. Only a clean native span,
        // never caller getters/iterators/species, reaches the decoder.
        try { text += decoder.decode(span, { stream: true }); } catch { throw failure('invalid_utf8'); }
      }
      try { text += decoder.decode(); } catch { throw failure('invalid_utf8'); }
      ensureActive();
      try { parsed = JSON.parse(text); } catch { throw failure('invalid_json'); }
      const projected = kind === 'validate' ? projectValidation(parsed) : projectSubscription(parsed, expected);
      if (containsToken(projected, token)) throw failure('credential_echo');
      bodyConsumed = true;
      return freezeCopy({ httpStatus: status, body: projected });
    } catch (error) {
      if (knownErrors.has(error)) throw error;
      throw failure(abortCode ?? 'request_failed');
    } finally {
      disposed = true;
      if (timer !== undefined) { try { clearTimer(timer); } catch { /* No raw timer errors. */ } }
      if (external !== undefined && external !== null && externalListener) {
        try { EventTarget.prototype.removeEventListener.call(external, 'abort', externalListener); } catch { /* No raw signal errors. */ }
      }
      if (!bodyConsumed) {
        try { controller?.abort(); } catch { /* Deliberately suppressed. */ }
        cancelOwnedBody();
      }
      try { ignoreCleanup(reader?.releaseLock?.()); } catch { /* A pending/hostile reader cannot block cleanup. */ }
      token = null;
      headers = null;
      fetchOptions = null;
      fetchedResponse = null;
      bodyStream = null;
      reader = null;
      text = null;
      parsed = null;
      rejectCancellation = null;
      if (args) args.credential = null;
      args = null;
      options = null;
    }
  }

  return Object.freeze({ validate: (options) => run('validate', options), subscribe: (options) => run('subscribe', options) });
}
