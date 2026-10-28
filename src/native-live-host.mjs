import WebSocket from '../vendor/ws/index.js';
import { createDeviceGrantHttpAdapters } from './device-grant-http.mjs';
import { createDeviceGrantHarness } from './device-grant.mjs';
import { createCredentialVault } from './credential-vault.mjs';
import { createTwitchHttpAdapters } from './twitch-http-adapters.mjs';
import { createTwitchSession } from './twitch-session.mjs';
import { createTwitchWebSocketAdapter } from './twitch-websocket-adapter.mjs';
import { createLiveTally } from './live-tally.mjs';

// Native-port own-channel composition; real service operation remains unverified until observed. Construction is inert. Calling start
// initiates real OAuth/network and is only allowed from the reviewed TTY entry.
// There is no injected fetch/socket option and no simulation delivery facade.
// It does not turn an injected protocol harness snapshot into platform evidence:
// this host separately binds the concrete native ports and private callbacks.
const fetchNative = globalThis.fetch.bind(globalThis);
const terminal = new Set(['failed', 'expired', 'revoked', 'disconnected', 'timed_out', 'reconnect_required', 'stopped']);

// Resolve the operator's own numeric ID from Twitch's authenticated validate
// response. No third-party lookup/site and no operator-supplied numeric ID.
async function identifyOwnChannel({ clientId, channelLogin, credential, vault, signal }) {
  const owned = new AbortController();
  let access;
  let response;
  let reader;
  let raw;
  try {
    access = vault.resolveAccess(credential);
    response = await fetchNative('https://id.twitch.tv/oauth2/validate', { method: 'GET',
      headers: { Authorization: `OAuth ${access}` }, redirect: 'error',
      signal: AbortSignal.any([signal, owned.signal, AbortSignal.timeout(5000)]) });
    access = null;
    if (response.status !== 200 || !response.body) throw new Error('identity_failed');
    reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let text = '';
    let bytes = 0;
    for (let reads = 0; ; reads += 1) {
      if (reads > 65_536) throw new Error('identity_failed');
      const item = await reader.read();
      if (item.done) break;
      bytes += item.value.byteLength;
      if (bytes > 65_536) throw new Error('identity_failed');
      text += decoder.decode(item.value, { stream: true });
    }
    text += decoder.decode(); raw = JSON.parse(text); text = null;
    if (signal.aborted || raw?.client_id !== clientId || raw?.login !== channelLogin
      || typeof raw.user_id !== 'string' || !/^[1-9][0-9]{0,24}$/.test(raw.user_id)
      || !Array.isArray(raw.scopes) || raw.scopes.length !== 1 || raw.scopes[0] !== 'user:read:chat'
      || !Number.isSafeInteger(raw.expires_in) || raw.expires_in < 30) throw new Error('identity_failed');
    return { channelId: raw.user_id, receipt: { httpStatus: 200, body: { client_id: clientId,
      user_id: raw.user_id, scopes: ['user:read:chat'], expires_in: raw.expires_in } } };
  } finally {
    access = null; raw = null;
    owned.abort();
    // Do not await body cancellation: it cannot extend the five-second I/O
    // budget. Physical cancellation remains the native client's responsibility.
    try { void Promise.resolve(reader ? reader.cancel() : response?.body?.cancel()).catch(() => {}); } catch { /* No raw diagnostics. */ }
    try { reader?.releaseLock(); } catch { /* Owned native body. */ }
    response = reader = null;
  }
}

export function createNativeLiveHost({ clientId, channelLogin, onPrivatePrompt, signal }) {
  if (typeof clientId !== 'string' || typeof channelLogin !== 'string'
    || !/^[A-Za-z0-9]{1,128}$/.test(clientId) || !/^[a-z0-9_]{1,25}$/.test(channelLogin)
    || typeof onPrivatePrompt !== 'function' || !(signal instanceof AbortSignal)) throw new Error('invalid_public_configuration');
  const tally = createLiveTally();
  const vault = createCredentialVault();
  const socket = createTwitchWebSocketAdapter({ createSocket: (url, options) => new WebSocket(url, options) });
  let channelId = null;
  let stopped = false;
  let starting = false;
  let current = null;
  let grantFlow = null;
  let phase = 'idle';
  let stopping = null;
  let retiring = Promise.resolve();
  function receiving(run = current) {
    return !stopped && current === run && run?.identityValidated === true && run.coordinator.getState().phase === 'receiving';
  }
  function state() {
    const session = current?.coordinator.getState();
    if (current && terminal.has(session?.phase)) {
      const run = current;
      current = null; phase = session.phase; run.identityValidated = false;
      if (run.handle) vault.revoke(run.handle);
      run.handle = null;
      // A terminal phase retires the coordinator/socket too, not just its vault
      // handle. Preserve the original terminal reason in the aggregate display.
      retiring = Promise.resolve(run.coordinator.stop()).catch(() => {});
    }
    const connected = receiving();
    const valid = Boolean(current?.identityValidated && !terminal.has(session?.phase));
    return { mode: 'twitch-own-channel', realTwitchConnected: connected, authorizationVerified: valid,
      phase: stopped ? 'stopped' : session?.phase ?? phase, connection: { status: connected ? 'connected' : 'disconnected' },
      channelLogin, channelId, sampledAt: Date.now(), ...tally.state(connected),
      limitation: 'Read-only chat. Disconnect/reconnect freezes intake; restart requires a new reviewed login. Missed events are not replayed.' };
  }
  function stop() {
    if (stopping) return stopping;
    stopped = true; phase = 'stopped';
    const run = current; current = null;
    grantFlow?.stop(); grantFlow = null;
    signal.removeEventListener('abort', abort);
    stopping = (async () => {
      try { await run?.coordinator.stop(); await retiring; } finally { vault.stop(); tally.state(false); }
    })();
    return stopping;
  }
  function abort() { void stop(); }
  signal.addEventListener('abort', abort, { once: true });
  async function start() {
    if (stopped || signal.aborted) return { ok: false, code: 'cancelled' };
    if (starting || current) return { ok: false, code: 'busy' };
    starting = true; phase = 'authorizing';
    let accepted = false;
    try {
      grantFlow = createDeviceGrantHarness({ clientId, ioTimeoutMs: 15_000, adapters: createDeviceGrantHttpAdapters({ clientId, fetch: fetchNative }),
        onPrompt(prompt, meta) {
          if (signal.aborted || stopped || meta.signal.aborted) throw new Error('cancelled');
          return onPrivatePrompt(prompt);
        },
        async onGrant(grant, meta) {
          let handle;
          try {
            handle = vault.store(grant); grant = null;
            const own = await identifyOwnChannel({ clientId, channelLogin, credential: handle, vault, signal: meta.signal });
            if (signal.aborted || stopped || meta.signal.aborted) throw new Error('cancelled');
            channelId = own.channelId;
            const http = createTwitchHttpAdapters({ clientId, broadcasterId: channelId, readerId: channelId,
              fetch: fetchNative, resolveCredential: vault.resolveAccess });
            let initialValidation = own.receipt;
            const run = { handle, identityValidated: true, coordinator: null };
            current = run;
            run.coordinator = createTwitchSession({ clientId, broadcasterId: channelId, readerId: channelId,
              adapters: {
                validate: async (options) => {
                  const receipt = initialValidation ?? await http.validate(options);
                  initialValidation = null;
                  if (current !== run || stopped) throw new Error('inactive');
                  run.identityValidated = true;
                  return receipt;
                },
                subscribe: http.subscribe,
                connect: socket.connect,
              },
              onEvent(event) {
                // Only the current native-port coordinator owns this callback.
                // Its guard already checks channel, subscription, session, age,
                // delivery/chat IDs and acknowledgement before delivery.
                if (receiving(run)) tally.accept(event, true);
              },
            });
            const value = await run.coordinator.start(handle);
            if (signal.aborted || meta.signal.aborted || current !== run || !value.ok) throw new Error('start_failed');
            accepted = true; phase = 'awaiting_welcome';
          } finally { grant = null; }
        },
      });
      const outcome = await grantFlow.start({ signal });
      if (!outcome.ok || !accepted || stopped || signal.aborted) {
        await stop();
        return { ok: false, code: signal.aborted ? 'cancelled' : 'authorization_or_session_failed' };
      }
      return { ok: true, code: 'session_starting', realTwitchConnected: state().realTwitchConnected };
    } catch {
      await stop();
      return { ok: false, code: signal.aborted ? 'cancelled' : 'authorization_or_session_failed' };
    } finally {
      starting = false;
      grantFlow?.stop(); grantFlow = null;
    }
  }
  return Object.freeze({ start, stop, getState: state,
    openVote: (durationMs) => stopped ? { ok: false, code: 'stopped' } : tally.open(durationMs),
    closeVote: () => stopped ? { ok: false, code: 'stopped' } : tally.close(),
    reset: () => stopped ? { ok: false, code: 'stopped' } : tally.reset() });
}
