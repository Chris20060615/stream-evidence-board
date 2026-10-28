import { createInterface } from 'node:readline';
import { createDeviceGrantHttpAdapters } from './device-grant-http.mjs';
import { createDeviceGrantHarness } from './device-grant.mjs';
import { createCredentialVault } from './credential-vault.mjs';
import { createTwitchHttpAdapters } from './twitch-http-adapters.mjs';

// Operator login/identity preflight only. No EventSub subscription, WebSocket,
// board, HTTP server, browser opener, credential file or environment reader.
// The executable binds these ports to a private TTY and Node's native fetch.
export const OPERATOR_LOGIN_USAGE = 'node scripts/authorize-twitch.mjs --client-id PUBLIC_CLIENT_ID --channel-id OWN_NUMERIC_USER_ID --app-name APP_LABEL [--authorize]';
const flags = new Set(['--client-id', '--channel-id', '--app-name']);
const clientIdValid = (value) => typeof value === 'string' && /^[A-Za-z0-9]{1,128}$/.test(value);
const userIdValid = (value) => typeof value === 'string' && /^[1-9][0-9]{0,24}$/.test(value);
const appLabelValid = (value) => typeof value === 'string' && value.length <= 80 && /^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(value) && value === value.trim();

export function parseOperatorLoginArgs(args) {
  if (!Array.isArray(args) || args.some((value) => typeof value !== 'string')) throw new Error('invalid_public_configuration');
  if (args.length === 0 || (args.length === 1 && args[0] === '--help')) return Object.freeze({ help: true });
  const values = new Map();
  let authorize = false;
  for (let index = 0; index < args.length; index += 1) {
    const key = args[index];
    if (key === '--authorize') {
      if (authorize) throw new Error('invalid_public_configuration');
      authorize = true;
    } else {
      if (!flags.has(key) || values.has(key) || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('invalid_public_configuration');
      values.set(key, args[++index]);
    }
  }
  const clientId = values.get('--client-id');
  const channelId = values.get('--channel-id');
  const appLabel = values.get('--app-name');
  if (values.size !== 3 || !clientIdValid(clientId) || !userIdValid(channelId) || !appLabelValid(appLabel)) throw new Error('invalid_public_configuration');
  return Object.freeze({ clientId, channelId, appLabel, authorize });
}

function result(ok, code, networkAttempted = false, validationReceiptAccepted = false) {
  return Object.freeze({ ok, code, networkAttempted, validationReceiptAccepted,
    chatConnected: false, boardStarted: false, credentialsPersisted: false });
}

function reviewLine(input, output, signal) {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    const reader = createInterface({ input, output, terminal: false });
    let done = false;
    const finish = (line) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      reader.removeListener('line', onLine);
      reader.removeListener('close', onClose);
      reader.close();
      resolve(line);
    };
    const onLine = (line) => finish(line);
    const onClose = () => finish(null);
    const onAbort = () => finish(null);
    const timer = setTimeout(onAbort, 60_000);
    reader.once('line', onLine);
    reader.once('close', onClose);
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) finish(null);
  });
}

/** Run only with explicitly supplied trusted process I/O and fetch ports.
 * Unit tests may inject synthetic ports; their receipts are not platform proof.
 * Public results contain no tokens/device instructions or raw diagnostics.
 */
export async function runOperatorLogin(plan, ports) {
  if (!plan || !clientIdValid(plan.clientId) || !userIdValid(plan.channelId) || !appLabelValid(plan.appLabel)
    || typeof plan.authorize !== 'boolean' || typeof ports?.fetchImpl !== 'function'
    || typeof ports?.output?.write !== 'function') return result(false, 'invalid_public_configuration');
  const { input, output, fetchImpl, signal = new AbortController().signal,
    now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = ports;
  if (!plan.authorize) {
    output.write(JSON.stringify({ mode: 'identity-preflight-plan', clientId: plan.clientId,
      ownChannelUserId: plan.channelId, operatorSuppliedAppLabel: plan.appLabel,
      scope: 'user:read:chat', requests: ['device_code', 'token_poll', 'validate_identity'],
      sendsChat: false, connectsChat: false, persistsCredentials: false }, null, 2) + '\n');
    return result(true, 'review_only');
  }
  if (input?.isTTY !== true || output.isTTY !== true) return result(false, 'private_interactive_terminal_required');
  if (!(signal instanceof AbortSignal) || signal.aborted) return result(false, 'cancelled');
  output.write(`Own-channel identity preflight\nOperator supplied app label: ${plan.appLabel}\nPublic client ID: ${plan.clientId}\nOwn channel/user ID: ${plan.channelId}\nScope: user:read:chat (read only)\nCheck the actual app name and scope on Twitch before granting access.\nUse a private, unrecorded terminal: temporary device instructions appear here.\nThis preflight does not connect chat or start the board.\nType AUTHORIZE ${plan.channelId} to request device login, or anything else to cancel: `);
  const answer = await reviewLine(input, output, signal);
  if (signal.aborted || answer !== `AUTHORIZE ${plan.channelId}`) return result(false, 'cancelled');
  let networkAttempted = false;
  let validationReceiptAccepted = false;
  let flow;
  const vault = createCredentialVault({ now, setTimer, clearTimer });
  const privateFetch = (url, options) => {
    networkAttempted = true;
    return fetchImpl(url, options);
  };
  try {
    const adapters = createDeviceGrantHttpAdapters({ clientId: plan.clientId, fetch: privateFetch, setTimer, clearTimer });
    const identity = createTwitchHttpAdapters({ clientId: plan.clientId, broadcasterId: plan.channelId,
      readerId: plan.channelId, fetch: privateFetch, resolveCredential: vault.resolveAccess, setTimer, clearTimer });
    flow = createDeviceGrantHarness({ clientId: plan.clientId, adapters, now, setTimer, clearTimer,
      onPrompt(prompt, meta) {
        if (signal.aborted || meta.signal.aborted) throw new Error('cancelled');
        // The existing ports allowlist this URI/code before this private hook.
        // Device codes/tokens are never returned, written to a file or logged.
        output.write(`\nOpen https://www.twitch.tv/activate in your own browser.\nTemporary user code: ${prompt.userCode}\nComplete login and review the actual app/scope there. Do not share or record this code.\nWaiting for Twitch authorization; Ctrl+C cancels.\n`);
      },
      async onGrant(grant, meta) {
        let handle;
        try {
          handle = vault.store(grant);
          grant = null;
          const receipt = await identity.validate({ credential: handle, signal: meta.signal });
          if (signal.aborted || meta.signal.aborted || receipt.httpStatus !== 200) throw new Error('cancelled');
          validationReceiptAccepted = true;
        } finally {
          grant = null;
          if (handle) vault.revoke(handle);
          handle = null;
        }
      },
    });
    const completed = await flow.start({ signal });
    if (!completed.ok || !validationReceiptAccepted || signal.aborted) return result(false,
      signal.aborted ? 'cancelled' : 'authorization_or_identity_failed', networkAttempted);
    return result(true, 'identity_preflight_completed', networkAttempted, true);
  } catch {
    return result(false, signal.aborted ? 'cancelled' : 'authorization_or_identity_failed', networkAttempted);
  } finally {
    flow?.stop();
    vault.stop();
  }
}
