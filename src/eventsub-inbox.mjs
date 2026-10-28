/**
 * OFFLINE, unauthenticated EventSub frame rehearsal. No socket, OAuth, API call,
 * environment lookup, HTTP route, or connection to the vote engine exists here.
 * Passing these structure checks does not prove that a frame came from Twitch.
 * Normalized events deliberately retain origin='eventsub-unverified'.
 *
 * Protocol reference (checked 2026-10-25):
 * https://dev.twitch.tv/docs/eventsub/handling-websocket-events/
 * https://dev.twitch.tv/docs/eventsub/eventsub-subscription-types/#channelchatmessage
 *
 * Local restrictions, beyond Twitch's wire format: bounded frames/chat/IDs;
 * strict configured subscription and condition; 60s default age/5s future limit;
 * bounded replay caches; no external Shared Chat source; frozen intake after
 * reconnect/revocation/timeout/close. Real reconnect requires an overlapping
 * socket handover; this rehearsal merely returns a guarded action descriptor.
 */

const CHAT_TYPE = 'channel.chat.message';
const CHAT_VERSION = '1';
const TERMINAL_PHASES = new Set(['reconnect_requested', 'revoked', 'timed_out', 'closed']);
const MAX_FUTURE_MS = 5_000;

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const safeId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const numericId = (value) => typeof value === 'string' && /^[1-9][0-9]{0,24}$/.test(value);

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

// Parse RFC3339 timestamps with 0..9 fractional digits, retaining the original
// string separately. Milliseconds truncate sub-ms digits, never round them.
// Leap seconds are conservatively rejected by this local policy.
function parseTimestamp(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const [, yyyy, mo, dd, hh, mi, ss, fraction = '', zone] = match;
  const [year, month, day, hour, minute, second] = [yyyy, mo, dd, hh, mi, ss].map(Number);
  if (month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const millis = Number(fraction.padEnd(3, '0').slice(0, 3));
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millis);
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  let offset = 0;
  if (zone !== 'Z') {
    const offsetHours = Number(zone.slice(1, 3));
    const offsetMinutes = Number(zone.slice(4, 6));
    if (offsetHours > 23 || offsetMinutes > 59) return null;
    offset = (offsetHours * 60 + offsetMinutes) * 60_000 * (zone[0] === '+' ? 1 : -1);
  }
  const time = date.getTime() - offset;
  if (!Number.isSafeInteger(time) || time < 0) return null;
  return { ms: time, ns: BigInt(time) * 1_000_000n + BigInt(fraction.padEnd(9, '0').slice(3)) };
}

function safeReconnectUrl(value) {
  if (typeof value !== 'string' || value.length > 4_096 || /[\s\u0000-\u001f\u007f#]/.test(value)) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'wss:' && url.hostname === 'eventsub.wss.twitch.tv'
      && !url.username && !url.password && !url.port && !url.hash
      && (url.pathname === '/' || url.pathname === '/ws');
  } catch { return false; }
}

/** Decode locally supplied, untrusted strings. This is NOT a Twitch transport. */
export function createEventSubInbox({
  broadcasterId,
  readerId,
  subscriptionId,
  now = Date.now,
  maxFrameBytes = 65_536,
  maxDeliveryIds = 2_000,
  deliveryTtlMs = 300_000,
  maxMessageAgeMs = 60_000,
} = {}) {
  if (!numericId(broadcasterId) || !numericId(readerId)) throw new TypeError('broadcasterId and readerId must be numeric ID strings.');
  if (!safeId(subscriptionId)) throw new TypeError('subscriptionId must be a bounded safe identifier.');
  if (typeof now !== 'function') throw new TypeError('now must be a function.');
  if (!Number.isSafeInteger(maxFrameBytes) || maxFrameBytes < 1 || maxFrameBytes > 1_048_576) throw new RangeError('maxFrameBytes must be an integer from 1 to 1048576.');
  if (!Number.isSafeInteger(maxDeliveryIds) || maxDeliveryIds < 1 || maxDeliveryIds > 100_000) throw new RangeError('maxDeliveryIds must be an integer from 1 to 100000.');
  for (const [name, value] of Object.entries({ deliveryTtlMs, maxMessageAgeMs })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new RangeError(`${name} must be a positive safe integer.`);
  }

  let phase = 'awaiting_welcome';
  let sessionId;
  let keepaliveTimeoutMs;
  let keepaliveDeadline = null;
  const deliveries = new Map();
  const chats = new Map();
  const metrics = { frames: 0, acceptedChats: 0, duplicateDeliveries: 0, duplicateChats: 0, rejectedFrames: 0, keepalives: 0 };

  function clock() {
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0) throw new RangeError('now() must return nonnegative safe integer milliseconds.');
    return time;
  }

  function expire(time) {
    // Twitch says "longer than" the timeout; the exact deadline remains valid.
    if (phase === 'ready' && time > keepaliveDeadline) phase = 'timed_out';
  }

  function getState() {
    expire(clock());
    return frozenCopy({ mode: 'protocol-rehearsal', networkConnected: false, phase, keepaliveDeadline, metrics });
  }

  function result(ok, code, message, extra = {}) {
    return { ok, code, message, ...extra, state: getState() };
  }

  function reject(code, message) {
    metrics.rejectedFrames += 1;
    return result(false, code, message);
  }

  function refresh(time) {
    keepaliveDeadline = time + keepaliveTimeoutMs;
  }

  function prune(cache, time) {
    for (const [id, receivedAt] of cache) {
      if (time - receivedAt >= deliveryTtlMs) cache.delete(id);
    }
  }

  function remember(cache, id, time) {
    while (cache.size >= maxDeliveryIds) cache.delete(cache.keys().next().value);
    cache.set(id, time);
  }

  function subscriptionMatches(subscription) {
    if (!isObject(subscription) || subscription.id !== subscriptionId || subscription.type !== CHAT_TYPE || subscription.version !== CHAT_VERSION) return false;
    const condition = subscription.condition;
    if (!isObject(condition) || Object.keys(condition).sort().join(',') !== 'broadcaster_user_id,user_id') return false;
    if (condition.broadcaster_user_id !== broadcasterId || condition.user_id !== readerId) return false;
    const transport = subscription.transport;
    return isObject(transport) && transport.method === 'websocket' && transport.session_id === sessionId;
  }

  function receive(rawString) {
    const time = clock();
    metrics.frames += 1;
    expire(time);
    if (TERMINAL_PHASES.has(phase)) return reject(phase, 'This offline inbox is terminal; create a new rehearsal instance to continue.');
    if (typeof rawString !== 'string' || Buffer.byteLength(rawString, 'utf8') > maxFrameBytes) return reject('invalid_frame', 'Expected a bounded UTF-8 JSON string.');
    let frame;
    try { frame = JSON.parse(rawString); } catch { return reject('invalid_frame', 'Frame is not valid JSON.'); }
    if (!isObject(frame) || !isObject(frame.metadata) || !isObject(frame.payload)) return reject('invalid_frame', 'Frame must contain metadata and payload objects.');
    const { metadata, payload } = frame;
    if (!safeId(metadata.message_id) || typeof metadata.message_type !== 'string') return reject('invalid_metadata', 'Frame metadata requires bounded message ID and message type.');
    const parsedTimestamp = parseTimestamp(metadata.message_timestamp);
    if (parsedTimestamp === null) return reject('invalid_metadata', 'Frame timestamp must be a valid bounded RFC3339 date.');
    const timestamp = parsedTimestamp.ms;
    const nowNs = BigInt(time) * 1_000_000n;
    if (parsedTimestamp.ns - nowNs > BigInt(MAX_FUTURE_MS) * 1_000_000n) return reject('future_message', 'Frame timestamp exceeds the local five-second future tolerance.');
    if (nowNs - parsedTimestamp.ns > BigInt(maxMessageAgeMs) * 1_000_000n) return reject('stale_message', 'Frame timestamp exceeds the local maximum age.');

    if (metadata.message_type === 'session_welcome') {
      if (phase !== 'awaiting_welcome') return reject('unexpected_message', 'A welcome frame is only accepted at the start of a rehearsal.');
      const session = payload.session;
      if (!isObject(session) || !safeId(session.id) || session.status !== 'connected'
        || !Number.isInteger(session.keepalive_timeout_seconds) || session.keepalive_timeout_seconds < 10 || session.keepalive_timeout_seconds > 600
        || (session.reconnect_url !== null && session.reconnect_url !== undefined)) {
        return reject('invalid_welcome', 'Welcome session fields are invalid for this local protocol rehearsal.');
      }
      const timeout = session.keepalive_timeout_seconds * 1_000;
      if (!Number.isSafeInteger(time + timeout)) return reject('invalid_welcome', 'Welcome deadline exceeds the safe clock range.');
      sessionId = session.id;
      keepaliveTimeoutMs = timeout;
      phase = 'ready';
      refresh(time);
      return result(true, 'welcome', 'Offline frame structure is ready; no network or authorization is established.');
    }

    if (phase === 'awaiting_welcome') return reject('awaiting_welcome', 'A valid welcome frame is required before other message types.');

    if (metadata.message_type === 'session_keepalive') {
      if (Object.keys(payload).length !== 0) return reject('invalid_frame', 'Keepalive payload must be empty.');
      refresh(time);
      metrics.keepalives += 1;
      return result(true, 'keepalive', 'Offline keepalive accepted; receive-clock watchdog refreshed.');
    }

    if (metadata.message_type === 'notification' || metadata.message_type === 'revocation') {
      if (metadata.subscription_type !== CHAT_TYPE || metadata.subscription_version !== CHAT_VERSION) return reject('subscription_mismatch', 'Metadata does not identify the configured chat subscription type and version.');
      if (!subscriptionMatches(payload.subscription)) return reject('subscription_mismatch', 'Subscription, reader, broadcaster or session does not match local configuration.');
      if (metadata.message_type === 'revocation') {
        const status = payload.subscription.status;
        if (typeof status !== 'string' || !/^[a-z_]{1,64}$/.test(status) || status === 'enabled') return reject('invalid_revocation', 'Revocation must include a non-enabled status.');
        phase = 'revoked';
        return result(true, 'revoked', 'Configured rehearsal subscription was revoked; intake is frozen.');
      }
      if (payload.subscription.status !== 'enabled') return reject('invalid_notification', 'Chat notification subscription must be enabled.');
      const event = payload.event;
      if (!isObject(event) || event.broadcaster_user_id !== broadcasterId || !numericId(event.chatter_user_id)
        || !safeId(event.message_id) || !isObject(event.message) || typeof event.message.text !== 'string' || event.message.text.length > 300) {
        return reject('invalid_notification', 'Chat event identifiers or bounded text are invalid.');
      }
      if (event.source_broadcaster_user_id !== undefined && event.source_broadcaster_user_id !== null && event.source_broadcaster_user_id !== broadcasterId) {
        return reject('shared_chat_source', 'Local policy excludes messages whose Shared Chat source is another broadcaster.');
      }
      prune(deliveries, time);
      prune(chats, time);
      // Duplicates of structurally valid, correctly scoped, fresh notifications
      // still prove local receive activity and refresh this rehearsal watchdog.
      refresh(time);
      if (deliveries.has(metadata.message_id)) {
        metrics.duplicateDeliveries += 1;
        return result(true, 'duplicate_delivery', 'Delivery ID already processed; no normalized event emitted.');
      }
      remember(deliveries, metadata.message_id, time);
      if (chats.has(event.message_id)) {
        metrics.duplicateChats += 1;
        return result(true, 'duplicate_chat_message', 'Chat message ID already processed; no normalized event emitted.');
      }
      remember(chats, event.message_id, time);
      metrics.acceptedChats += 1;
      return result(true, 'chat_message', 'Unverified offline chat frame normalized; it is not authorized for vote intake.', {
        event: frozenCopy({
          id: event.message_id,
          userId: event.chatter_user_id,
          text: event.message.text,
          timestamp,
          timestampRaw: metadata.message_timestamp,
          deliveryId: metadata.message_id,
          origin: 'eventsub-unverified',
        }),
      });
    }

    if (metadata.message_type === 'session_reconnect') {
      const session = payload.session;
      if (!isObject(session) || session.id !== sessionId || session.status !== 'reconnecting' || !safeReconnectUrl(session.reconnect_url)) {
        return reject('invalid_reconnect', 'Reconnect must name the current session and an allowed official secure WebSocket endpoint.');
      }
      phase = 'reconnect_requested';
      return result(true, 'reconnect_requested', 'Offline intake frozen. A real client must perform the documented overlapping socket handover.', {
        action: frozenCopy({ type: 'reconnect_required', url: session.reconnect_url }),
      });
    }

    return reject('unexpected_message', 'Unsupported EventSub message type; watchdog unchanged.');
  }

  function close(reason) {
    if (reason !== undefined && (typeof reason !== 'string' || reason.length > 160)) return result(false, 'invalid_close_reason', 'Optional close reason must be text with at most 160 characters.');
    // Caller reason is not retained or reflected in public state: it may contain
    // arbitrary local data. Closing does not authenticate or contact any service.
    phase = 'closed';
    deliveries.clear();
    chats.clear();
    sessionId = undefined;
    return result(true, 'closed', 'Offline inbox closed; intake is frozen.');
  }

  clock();
  return Object.freeze({ receive, getState, close });
}
