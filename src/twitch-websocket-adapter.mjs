/**
 * Restricted WebSocket wrapper for a future host-supplied synchronous factory.
 * No WebSocket implementation, package import, network activation, credential,
 * environment, OAuth flow or application-message sender is provided here.
 *
 * The fixed options are a reviewed ws-compatible local policy. An arbitrary
 * injected factory can ignore them; this wrapper is not a sandbox. Its byte cap
 * applies to frames delivered to it, not to all TCP/dependency allocations.
 * Callback promises are bounded but are not serialized: a pending welcome-to-
 * subscription callback must not prevent incoming keepalives being delivered.
 */
const ENDPOINT = 'wss://eventsub.wss.twitch.tv/ws';
const MAX_FRAME_BYTES = 65_536;
const abortedGetter = Object.getOwnPropertyDescriptor(AbortSignal.prototype, 'aborted').get;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength').get;
const byteOffsetGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset').get;
const bufferGetter = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer').get;
const knownErrors = new WeakSet();
const sinksInstalled = new WeakSet();
const disposedSockets = new WeakSet();

// This terminal listener captures no socket, callbacks, credentials or session.
function sinkSocketError() {}

function failure(code) {
  const error = new Error(code);
  knownErrors.add(error);
  return error;
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function ownData(value, required, optional = []) {
  if (!plain(value)) throw failure('invalid_input');
  const allowed = new Set([...required, ...optional]);
  const keys = Reflect.ownKeys(value);
  if (keys.some((key) => typeof key !== 'string' || !allowed.has(key)) || required.some((key) => !Object.hasOwn(value, key))) throw failure('invalid_input');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result = Object.create(null);
  for (const key of keys) {
    if (!('value' in descriptors[key])) throw failure('invalid_input');
    result[key] = descriptors[key].value;
  }
  return result;
}

function observeNativePromise(value) {
  try { void Promise.prototype.then.call(value, () => {}, () => {}); } catch { /* No arbitrary then getter is read. */ }
}

function installSink(target) {
  if (!target || (typeof target !== 'object' && typeof target !== 'function') || sinksInstalled.has(target)) return;
  try {
    if (typeof target.on === 'function') {
      target.on('error', sinkSocketError);
      sinksInstalled.add(target);
    }
  } catch { /* A broken factory is outside the ws-compatible contract. */ }
}

function disposeSocket(target, force = true, methods) {
  if (!target || (typeof target !== 'object' && typeof target !== 'function') || disposedSockets.has(target)) return;
  disposedSockets.add(target);
  installSink(target);
  try {
    const method = methods?.[force ? 'terminate' : 'close'] ?? target[force ? 'terminate' : 'close'];
    if (typeof method === 'function') observeNativePromise(Reflect.apply(method, target, []));
    else if (typeof target.close === 'function') observeNativePromise(target.close());
  } catch {
    try { if (typeof target.close === 'function') observeNativePromise(target.close()); } catch { /* Cleanup is nonblocking and never leaks a raw error. */ }
  }
}

function textFrame(data, isBinary) {
  if (isBinary !== false) throw failure('invalid_frame');
  if (typeof data === 'string') {
    if (Buffer.byteLength(data, 'utf8') > MAX_FRAME_BYTES) throw failure('frame_limit');
    // JS strings have no wire encoding. Reject malformed UTF-16 rather than
    // silently replacing an unpaired surrogate during byte-count conversion.
    for (let index = 0; index < data.length; index += 1) {
      const code = data.charCodeAt(index);
      if (code >= 0xd800 && code <= 0xdbff) {
        const next = data.charCodeAt(++index);
        if (!(next >= 0xdc00 && next <= 0xdfff)) throw failure('invalid_frame');
      } else if (code >= 0xdc00 && code <= 0xdfff) throw failure('invalid_frame');
    }
    return data;
  }
  let bytes;
  try {
    if (!(data instanceof Uint8Array)) throw failure('invalid_frame');
    // Real views can shadow .byteLength. Count the actual view through the
    // intrinsic, without invoking that property; proxy brands fail closed.
    bytes = byteLengthGetter.call(data);
  } catch { throw failure('invalid_frame'); }
  if (bytes > MAX_FRAME_BYTES) throw failure('frame_limit');
  try {
    // Node's decoder may consult view properties. Decode a clean native view of
    // the same bounded bytes so decorated input getters cannot alter decoding.
    const view = new Uint8Array(bufferGetter.call(data), byteOffsetGetter.call(data), bytes);
    return new TextDecoder('utf-8', { fatal: true }).decode(view);
  }
  catch { throw failure('invalid_frame'); }
}

export function createTwitchWebSocketAdapter(configuration = {}) {
  let config;
  try { config = ownData(configuration, ['createSocket'], ['connectTimeoutMs', 'maxPendingFrames', 'setTimer', 'clearTimer']); }
  catch { throw failure('invalid_input'); }
  const {
    createSocket,
    connectTimeoutMs = 5_000,
    maxPendingFrames = 32,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = config;
  if (typeof createSocket !== 'function' || typeof setTimer !== 'function' || typeof clearTimer !== 'function'
    || !Number.isSafeInteger(connectTimeoutMs) || connectTimeoutMs < 1 || connectTimeoutMs > 60_000
    || !Number.isSafeInteger(maxPendingFrames) || maxPendingFrames < 1 || maxPendingFrames > 1_024) throw failure('invalid_input');
  const factoryOptions = Object.freeze({
    maxPayload: MAX_FRAME_BYTES,
    perMessageDeflate: false,
    followRedirects: false,
    autoPong: true,
    skipUTF8Validation: false,
    handshakeTimeout: connectTimeoutMs,
    maxFragments: 1_024,
    maxBufferedChunks: 1_024,
  });

  function connect(options) {
    return new Promise((resolve, reject) => {
      let socket = null;
      let methods = null;
      let hooks = null;
      let external;
      let externalListener = null;
      let timer;
      let active = true;
      let opened = false;
      let settled = false;
      let notified = false;
      let pendingFrames = 0;
      const listeners = [];

      function clearDeadline() {
        if (timer !== undefined) { try { clearTimer(timer); } catch { /* No raw timer error escapes. */ } }
        timer = undefined;
      }
      function stop(kind, code, force = true) {
        if (!active) return;
        active = false;
        clearDeadline();
        if (external !== undefined && externalListener) {
          try { EventTarget.prototype.removeEventListener.call(external, 'abort', externalListener); } catch { /* No raw signal error escapes. */ }
        }
        const target = socket;
        const targetMethods = methods;
        const notification = opened && !notified ? (kind === 'error' ? hooks?.onError : kind === 'disconnect' ? hooks?.onDisconnect : null) : null;
        if (notification) notified = true;
        if (target && targetMethods) {
          for (const [event, handler] of listeners) {
            try { Reflect.apply(targetMethods.off, target, [event, handler]); } catch { /* Active guards still suppress any unremoved callback. */ }
          }
        }
        listeners.length = 0;
        socket = null;
        methods = null;
        hooks = null;
        external = undefined;
        externalListener = null;
        pendingFrames = 0;
        disposeSocket(target, force, targetMethods);
        if (!settled) {
          settled = true;
          reject(failure(code));
        }
        if (notification) {
          try { observeNativePromise(kind === 'error' ? notification(failure(code)) : notification()); }
          catch { /* Callback errors cannot revive the connection or escape. */ }
        }
      }
      function transportError() { stop('error', 'transport_error'); }
      function remoteClose() { stop('disconnect', opened ? 'disconnected' : 'closed_before_open'); }
      function onOpen() {
        if (!active || opened) return;
        try { if (socket.readyState !== 1) { stop('error', 'invalid_socket'); return; } }
        catch { stop('error', 'invalid_socket'); return; }
        opened = true;
        settled = true;
        clearDeadline();
        resolve(Object.freeze({ close: () => { stop('host', 'closed', false); } }));
      }
      function onMessage(data, isBinary) {
        if (!active || !opened) return;
        if (pendingFrames >= maxPendingFrames) { stop('error', 'frame_overload'); return; }
        let text;
        try {
          if (socket.readyState !== 1) { stop('error', 'transport_error'); return; }
          text = textFrame(data, isBinary);
        } catch (error) { stop('error', knownErrors.has(error) ? error.message : 'invalid_frame'); return; }
        // Prototype/brand interactions can synchronously abort or reenter a
        // delivery. Recheck ownership and capacity at the callback boundary.
        if (!active || !opened) return;
        if (pendingFrames >= maxPendingFrames) { stop('error', 'frame_overload'); return; }
        pendingFrames += 1;
        let returned;
        try { returned = hooks.onFrame(text); }
        catch { stop('error', 'callback_failed'); return; }
        finally { text = null; data = null; }
        // A native rejected Promise must also be observed if an own hostile
        // then getter prevents the normal settlement path being attached.
        observeNativePromise(returned);
        let then;
        try { then = returned && (typeof returned === 'object' || typeof returned === 'function') ? returned.then : null; }
        catch { stop('error', 'callback_failed'); return; }
        if (typeof then !== 'function') { if (active) pendingFrames -= 1; return; }
        // Read the then property once. Promise settlement guarantees one counter
        // update even when a hostile thenable calls its handlers repeatedly.
        const completion = new Promise((complete, fail) => {
          try {
            const incidental = Reflect.apply(then, returned, [() => complete(), () => fail()]);
            if (incidental !== returned) observeNativePromise(incidental);
          } catch { fail(); }
        });
        void completion.then(() => { if (active) pendingFrames -= 1; }, () => { if (active) stop('error', 'callback_failed'); });
      }
      function listen(event, handler) {
        Reflect.apply(methods.on, socket, [event, handler]);
        listeners.push([event, handler]);
      }

      try {
        const args = ownData(options, ['onFrame', 'onDisconnect', 'onError'], ['signal']);
        options = null;
        if (['onFrame', 'onDisconnect', 'onError'].some((key) => typeof args[key] !== 'function')) throw failure('invalid_input');
        external = args.signal;
        if (external !== undefined) {
          try { if (abortedGetter.call(external)) throw failure('aborted'); }
          catch (error) { if (knownErrors.has(error)) throw error; throw failure('invalid_input'); }
        }
        hooks = { onFrame: args.onFrame, onDisconnect: args.onDisconnect, onError: args.onError };
        if (external !== undefined) {
          externalListener = () => stop('error', 'aborted');
          EventTarget.prototype.addEventListener.call(external, 'abort', externalListener, { once: true });
          if (abortedGetter.call(external)) { stop('error', 'aborted'); return; }
        }
        // Keep the operation deadline referenced until open/terminal settlement.
        const deadlineHandle = setTimer(() => {
          if (active && !opened && timer === deadlineHandle) stop('error', 'connect_timeout');
        }, connectTimeoutMs);
        timer = deadlineHandle;
        if (!active) return;
        let created;
        try { created = createSocket(ENDPOINT, factoryOptions); }
        catch { throw failure('factory_failed'); }
        let asynchronous = false;
        try {
          void Promise.prototype.then.call(created, (late) => { disposeSocket(late); }, () => {});
          asynchronous = true;
        } catch { /* Not a native Promise; no arbitrary then getter is read. */ }
        if (asynchronous) throw failure('invalid_socket');
        if (!active) { disposeSocket(created); return; }
        socket = created;
        if (!socket || (typeof socket !== 'object' && typeof socket !== 'function')) throw failure('invalid_socket');
        methods = { on: socket.on, off: socket.off, close: socket.close, terminate: socket.terminate };
        if (Object.values(methods).some((method) => typeof method !== 'function')) throw failure('invalid_socket');
        installSink(socket);
        listen('open', onOpen);
        listen('message', onMessage);
        listen('error', transportError);
        listen('close', remoteClose);
        const readyState = socket.readyState;
        if (!Number.isInteger(readyState) || readyState < 0 || readyState > 3) throw failure('invalid_socket');
        if (readyState === 1) onOpen();
        else if (readyState >= 2) stop('disconnect', 'closed_before_open');
      } catch (error) {
        stop('error', knownErrors.has(error) ? error.message : 'invalid_input');
      }
    });
  }
  return Object.freeze({ connect });
}
