/**
 * OFFLINE subscription rehearsal. This module performs no network requests,
 * reads no environment variables, accepts no token/header fields, and cannot
 * validate a real credential. All receipts require provenance='synthetic'.
 *
 * Official response shapes and lifecycle guidance, checked 2026-10-25:
 * https://dev.twitch.tv/docs/authentication/validate-tokens/
 * https://dev.twitch.tv/docs/api/reference/#create-eventsub-subscription
 * https://dev.twitch.tv/docs/eventsub/handling-websocket-events/
 *
 * Project policy is deliberately stricter: pin one reader/client/channel,
 * require user:read:chat and a minimum modeled lifetime, require exactly one
 * enabled acknowledgement, and require both proposal and acknowledgement
 * before a local deadline based on injected welcomeReceivedAt. That timestamp
 * is a local receipt clock, not metadata.message_timestamp or created_at.
 * No real welcome, authorization, subscription or connection is established.
 */

const MAX_VALIDATION_INTERVAL_MS = 3_600_000;
const MAX_SUBSCRIBE_WINDOW_MS = 10_000;
const MAX_SESSION_HISTORY = 128;
const ENDPOINT = 'https://api.twitch.tv/helix/eventsub/subscriptions';
const TYPE = 'channel.chat.message';
const VERSION = '1';

const numericId = (value) => typeof value === 'string' && /^[1-9][0-9]{0,24}$/.test(value);
const safeId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);

function frozenCopy(value) {
  const copy = structuredClone(value);
  const freeze = (part) => {
    if (part && typeof part === 'object') {
      for (const child of Object.values(part)) freeze(child);
      Object.freeze(part);
    }
    return part;
  };
  return freeze(copy);
}

// Reject recognized credential-shaped fields anywhere, including fields that
// otherwise would be ignored. Never echo, stringify, retain or log their values.
// Unknown ordinary response fields are inspected then discarded. Bounds and
// accessor/cycle rejection keep an untrusted local receipt from becoming work.
function inspectData(input) {
  const pending = [{ value: input, depth: 0 }];
  const seen = new WeakSet();
  let nodes = 0;
  try {
    while (pending.length) {
      const { value, depth } = pending.pop();
      nodes += 1;
      if (nodes > 1_000 || depth > 12) return 'invalid_receipt';
      if (value === null || typeof value === 'boolean') continue;
      if (typeof value === 'number') {
        if (!Number.isFinite(value)) return 'invalid_receipt';
        continue;
      }
      if (typeof value === 'string') {
        if (value.length > 65_536) return 'invalid_receipt';
        continue;
      }
      if (typeof value !== 'object' || (!Array.isArray(value) && !plainObject(value)) || seen.has(value)) return 'invalid_receipt';
      seen.add(value);
      const keys = Reflect.ownKeys(value);
      if (keys.length > 1_000) return 'invalid_receipt';
      const descriptors = Object.getOwnPropertyDescriptors(value);
      for (const key of keys) {
        if (typeof key !== 'string') return 'invalid_receipt';
        const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (/token|authorization|credential|secret|password|cookie|apikey|header|privatekey/.test(normalized)) return 'credential_fields';
        const descriptor = descriptors[key];
        if (!('value' in descriptor)) return 'invalid_receipt';
        pending.push({ value: descriptor.value, depth: depth + 1 });
      }
    }
    return null;
  } catch { return 'invalid_receipt'; }
}

/** Pure model for inspecting synthetic validation and subscription receipts. */
export function createSubscriptionPreflight({
  clientId,
  broadcasterId,
  readerId,
  now = Date.now,
  validationIntervalMs = MAX_VALIDATION_INTERVAL_MS,
  subscribeWindowMs = MAX_SUBSCRIBE_WINDOW_MS,
  minTokenRemainingMs = 30_000,
  ownChannelOnly = true,
} = {}) {
  if (!safeId(clientId)) throw new TypeError('clientId must be a bounded safe identifier.');
  if (!numericId(broadcasterId) || !numericId(readerId)) throw new TypeError('broadcasterId and readerId must be numeric ID strings.');
  if (typeof ownChannelOnly !== 'boolean') throw new TypeError('ownChannelOnly must be boolean.');
  if (ownChannelOnly && broadcasterId !== readerId) throw new TypeError('Own-channel policy requires the reader to be the broadcaster.');
  if (typeof now !== 'function') throw new TypeError('now must be a function.');
  if (!Number.isSafeInteger(validationIntervalMs) || validationIntervalMs < 1 || validationIntervalMs > MAX_VALIDATION_INTERVAL_MS) throw new RangeError('validationIntervalMs must be an integer from 1 to 3600000.');
  if (!Number.isSafeInteger(subscribeWindowMs) || subscribeWindowMs < 1 || subscribeWindowMs > MAX_SUBSCRIBE_WINDOW_MS) throw new RangeError('subscribeWindowMs must be an integer from 1 to 10000.');
  if (!Number.isSafeInteger(minTokenRemainingMs) || minTokenRemainingMs < 1) throw new RangeError('minTokenRemainingMs must be a positive safe integer.');

  let phase = 'awaiting_validation';
  let validation = null;
  let plan = null;
  let lastFailureCode = 'validation_required';
  // Retain only first local receipt timing per session. Revalidation or explicit
  // invalidation cannot extend the same session's original window. At capacity,
  // fail closed rather than evicting history and permitting a replay reset.
  const sessionHistory = new Map();

  function clock() {
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0) throw new RangeError('now() must return nonnegative safe integer milliseconds.');
    return time;
  }

  function clearEligibility(code, nextPhase = 'failed') {
    validation = null;
    plan = null;
    lastFailureCode = code;
    phase = nextPhase;
  }

  function expire(time) {
    if (!validation) return;
    if (time >= validation.expiresAt) clearEligibility('expired', 'expired');
    else if (time >= validation.nextValidationAt) clearEligibility('validation_required', 'validation_required');
    else if (phase === 'subscription_planned' && time >= plan.deadline) clearEligibility('window_expired', 'expired');
  }

  function getState() {
    expire(clock());
    return frozenCopy({
      mode: 'offline-subscription-rehearsal',
      networkConnected: false,
      authorizationVerified: false,
      phase,
      validatedAt: validation?.validatedAt ?? null,
      nextValidationAt: validation?.nextValidationAt ?? null,
      expiresAt: validation?.expiresAt ?? null,
      subscribeDeadline: plan?.deadline ?? null,
    });
  }

  function result(ok, code, message, extra = {}) {
    return { ok, code, message, ...extra, state: getState() };
  }

  function fail(code, message, nextPhase = 'failed') {
    clearEligibility(code, nextPhase);
    return result(false, code, message);
  }

  function inspectReceipt(receipt) {
    const inspection = inspectData(receipt);
    if (inspection) return inspection;
    if (!plainObject(receipt) || !plainObject(receipt.body) || !Number.isInteger(receipt.httpStatus)) return 'invalid_receipt';
    if (receipt.provenance !== 'synthetic') return 'unsupported_provenance';
    return null;
  }

  function validationProblem(time) {
    expire(time);
    if (!validation) return lastFailureCode;
    if (validation.expiresAt - time < minTokenRemainingMs) {
      clearEligibility('insufficient_lifetime', 'expired');
      return 'insufficient_lifetime';
    }
    return null;
  }

  function acceptValidation(receipt) {
    const time = clock();
    // Any attempted replacement invalidates prior modeled validation/plan/ack,
    // including malformed or HTTP401 receipts. No previous ready state survives.
    clearEligibility('validation_required', 'awaiting_validation');
    const problem = inspectReceipt(receipt);
    if (problem) return fail(problem, 'Synthetic validation receipt was rejected without retaining its data.');
    if (receipt.httpStatus !== 200) return fail('validation_rejected', 'Synthetic validation HTTP status is not 200.');
    const body = receipt.body;
    if (body.client_id !== clientId || body.user_id !== readerId) return fail('identity_mismatch', 'Synthetic validation identity does not match the configured client and reader.');
    if (!Array.isArray(body.scopes) || body.scopes.length > 100 || body.scopes.some((scope) => typeof scope !== 'string' || scope.length < 1 || scope.length > 200)) return fail('invalid_receipt', 'Synthetic scopes must be a bounded list of strings.');
    if (!body.scopes.includes('user:read:chat')) return fail('missing_scope', 'The required modeled chat-read scope is absent.');
    if (!Number.isSafeInteger(body.expires_in) || body.expires_in < 1) return fail('invalid_receipt', 'Synthetic expiry must be a positive integer duration in seconds.');
    const remainingMs = body.expires_in * 1_000;
    const expiresAt = time + remainingMs;
    const nextValidationAt = time + validationIntervalMs;
    if (!Number.isSafeInteger(remainingMs) || !Number.isSafeInteger(expiresAt) || !Number.isSafeInteger(nextValidationAt)) return fail('invalid_receipt', 'Synthetic expiry or validation deadline exceeds the safe clock range.');
    if (remainingMs < minTokenRemainingMs) return fail('insufficient_lifetime', 'Synthetic remaining lifetime is below local policy.');
    validation = { validatedAt: time, nextValidationAt, expiresAt };
    phase = 'validation_checked';
    lastFailureCode = 'validation_required';
    return result(true, 'validation_checked', 'Synthetic credential claims checked locally; no real authorization has been verified.');
  }

  function planSubscription(parameters) {
    const time = clock();
    const eligibilityProblem = validationProblem(time);
    if (eligibilityProblem) return result(false, eligibilityProblem, 'Fresh eligible synthetic validation is required before a proposal.');
    const inspection = inspectData(parameters);
    if (inspection === 'credential_fields') return fail(inspection, 'Credential-shaped fields are forbidden in offline proposal parameters.');
    if (inspection || !plainObject(parameters) || !safeId(parameters.sessionId)
      || !Number.isSafeInteger(parameters.welcomeReceivedAt) || parameters.welcomeReceivedAt < 0 || parameters.welcomeReceivedAt > time) {
      return result(false, 'invalid_welcome', 'Provide a bounded session identifier and a valid local welcome receipt time.');
    }
    const { sessionId, welcomeReceivedAt } = parameters;
    if (plan && plan.sessionId !== sessionId) return result(false, 'session_mismatch', 'A different active session requires a fresh synthetic validation receipt.');
    const existing = sessionHistory.get(sessionId);
    if (existing && existing.welcomeReceivedAt !== welcomeReceivedAt) return result(false, 'invalid_welcome', 'The first local welcome receipt time for this session is already pinned.');
    if (phase === 'acknowledged') return result(false, 'already_acknowledged', 'This synthetic plan has already been acknowledged.');
    const deadline = existing?.deadline ?? welcomeReceivedAt + subscribeWindowMs;
    if (!Number.isSafeInteger(deadline)) return result(false, 'invalid_welcome', 'Local welcome deadline exceeds the safe clock range.');
    if (time >= deadline) return fail('window_expired', 'The local welcome-to-subscription window has expired.', 'expired');
    if (plan) return result(true, 'subscription_planned', 'Existing offline proposal returned without extending its deadline.', { request: plan.request });
    if (!existing && sessionHistory.size >= MAX_SESSION_HISTORY) return fail('session_history_full', 'Offline session history is full; no prior session timing will be evicted.');
    if (!existing) sessionHistory.set(sessionId, { welcomeReceivedAt, deadline });
    const request = frozenCopy({
      method: 'POST',
      url: ENDPOINT,
      body: {
        type: TYPE,
        version: VERSION,
        condition: { broadcaster_user_id: broadcasterId, user_id: readerId },
        transport: { method: 'websocket', session_id: sessionId },
      },
      requiresSecureAuthorization: true,
      provenance: 'synthetic',
    });
    plan = { sessionId, deadline, request };
    phase = 'subscription_planned';
    return result(true, 'subscription_planned', 'Offline request proposed; nothing was sent and authorization remains unverified.', { request });
  }

  function acceptAcknowledgement(receipt) {
    const time = clock();
    const problem = inspectReceipt(receipt);
    if (problem) return fail(problem, 'Synthetic acknowledgement was rejected without retaining its data.');
    const eligibilityProblem = validationProblem(time);
    if (eligibilityProblem) {
      if (phase === 'awaiting_validation') return result(false, 'ack_before_plan', 'An outstanding eligible offline proposal is required before acknowledgement.');
      return result(false, eligibilityProblem, 'Synthetic validation or local window is no longer eligible.');
    }
    if (!plan || phase !== 'subscription_planned') return fail('ack_before_plan', 'An outstanding eligible offline proposal is required before acknowledgement.');
    if (receipt.httpStatus !== 202) return fail('ack_rejected', 'Synthetic subscription acknowledgement HTTP status is not 202.');
    const data = receipt.body.data;
    if (!Array.isArray(data) || data.length !== 1 || !plainObject(data[0])) return fail('subscription_mismatch', 'Synthetic acknowledgement must contain exactly one matching subscription.');
    const subscription = data[0];
    const condition = subscription.condition;
    const transport = subscription.transport;
    if (!safeId(subscription.id) || subscription.status !== 'enabled' || subscription.type !== TYPE || subscription.version !== VERSION
      || !plainObject(condition) || Object.keys(condition).sort().join(',') !== 'broadcaster_user_id,user_id'
      || condition.broadcaster_user_id !== broadcasterId || condition.user_id !== readerId
      || !plainObject(transport) || transport.method !== 'websocket' || transport.session_id !== plan.sessionId) {
      return fail('subscription_mismatch', 'Synthetic acknowledgement does not match the proposed enabled subscription.');
    }
    phase = 'acknowledged';
    return result(true, 'acknowledged', 'Matching synthetic acknowledgement checked; no live subscription, authorization or connection is established.');
  }

  function invalidate(reason) {
    // Deliberately discard arbitrary caller reasons without retaining/echoing.
    clearEligibility('validation_required', 'validation_required');
    return result(true, 'invalidated', 'Offline modeled eligibility and proposal cleared; fresh synthetic validation is required.');
  }

  clock();
  return Object.freeze({ acceptValidation, planSubscription, acceptAcknowledgement, invalidate, getState });
}
