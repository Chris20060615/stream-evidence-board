/**
 * Stream Evidence Board: dependency-free, deterministic simulation engine.
 * This module does not connect to Twitch. Connection status is a simulated input.
 * Event IDs and voter IDs remain private; public snapshots contain only totals.
 */

const MAX_COMMAND_LENGTH = 300;
const MIN_WINDOW_MS = 1_000;
const MAX_WINDOW_MS = 600_000;
const MAX_ID_LENGTH = 128;
const CONNECTION_STATUSES = new Set(['disconnected', 'connecting', 'connected']);

export const DEFAULT_CARD = Object.freeze({
  id: 'moon-distance',
  claim: 'The Moon is slowly moving away from Earth.',
  prompt: 'Which source would you inspect first to check this claim?',
  choices: Object.freeze({ a: 'Original measurements or research', b: 'A short clip or repost' }),
  source: Object.freeze({
    title: 'Moon Facts',
    publisher: 'NASA Science',
    url: 'https://science.nasa.gov/moon/facts/',
    note: 'Open the source and inspect its context. This poll records a preference, not a knowledge score.',
  }),
});

/** Parse one complete chat command; never evaluates or renders user text. */
export function parseCommand(text) {
  if (typeof text !== 'string') return { type: 'invalid', reason: 'Command must be text.' };
  if (text.length > MAX_COMMAND_LENGTH) return { type: 'invalid', reason: 'Command exceeds 300 characters.' };
  const normalized = text.trim().toLowerCase();
  if (!normalized.startsWith('!')) return { type: 'ignore' };
  if (/^!vote\s+[ab]$/.test(normalized)) return { type: 'vote', choice: normalized.at(-1) };
  if (normalized === '!source') return { type: 'source' };
  if (normalized === '!help') return { type: 'help' };
  if (/^!vote(?:\s|$)/.test(normalized)) return { type: 'invalid', reason: 'Use !vote a or !vote b.' };
  if (/^!source(?:\s|$)/.test(normalized)) return { type: 'invalid', reason: 'Use !source without arguments.' };
  if (/^!help(?:\s|$)/.test(normalized)) return { type: 'invalid', reason: 'Use !help without arguments.' };
  return { type: 'invalid', reason: 'Supported commands: !vote a, !vote b, !source, !help.' };
}

function snapshot(value) {
  const cloned = structuredClone(value);
  const freeze = (object) => {
    if (object && typeof object === 'object') {
      for (const child of Object.values(object)) freeze(child);
      Object.freeze(object);
    }
    return object;
  };
  return freeze(cloned);
}

function validId(id) {
  return typeof id === 'string' && id.length <= MAX_ID_LENGTH && /^[A-Za-z0-9_-]+$/.test(id);
}

function boundedText(text, limit, label) {
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > limit) {
    throw new TypeError(`${label} must be nonempty text with at most ${limit} characters.`);
  }
  return text.trim();
}

function validateCard(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('card must be an object.');
  if (!validId(input.id)) throw new TypeError('card.id must be a safe identifier.');
  if (!input.choices || Object.keys(input.choices).sort().join(',') !== 'a,b') {
    throw new TypeError('card.choices must contain exactly a and b.');
  }
  if (!input.source || typeof input.source !== 'object') throw new TypeError('card.source is required.');
  const urlText = boundedText(input.source.url, 2_048, 'source.url');
  let url;
  try { url = new URL(urlText); } catch { throw new TypeError('source.url must be a valid HTTPS URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password) throw new TypeError('source.url must use HTTPS without credentials.');
  return {
    id: input.id,
    claim: boundedText(input.claim, 500, 'card.claim'),
    prompt: boundedText(input.prompt, 500, 'card.prompt'),
    choices: {
      a: boundedText(input.choices.a, 160, 'choices.a'),
      b: boundedText(input.choices.b, 160, 'choices.b'),
    },
    source: {
      title: boundedText(input.source.title, 200, 'source.title'),
      publisher: boundedText(input.source.publisher, 200, 'source.publisher'),
      url: url.href,
      note: boundedText(input.source.note ?? 'Inspect the original source and its context.', 500, 'source.note'),
    },
  };
}

function validDuration(value) {
  return Number.isSafeInteger(value) && value >= MIN_WINDOW_MS && value <= MAX_WINDOW_MS;
}

/**
 * A round starts explicitly and runs on the injected server clock. Changing
 * connection status never pauses the deadline. At most one vote per viewer is
 * counted; voting again changes that viewer's choice. Dedupe memory survives
 * round resets but is bounded by both time and capacity. After eviction, an ID
 * may be processed again; caller-provided timestamps additionally reject events
 * from earlier rounds. No real Twitch origin is supported in this prototype.
 * Source requests use a separate fixed overlay-cue window. Fresh unique source
 * events can add to a cumulative request count but cannot extend an active cue.
 * This count is neither an audience total nor a unique-viewer measurement.
 */
export function createBoard({
  card = DEFAULT_CARD,
  now = Date.now,
  voteWindowMs = 60_000,
  eventTtlMs = 300_000,
  maxEventIds = 2_000,
  sourceCueMs = 15_000,
} = {}) {
  const safeCard = validateCard(card);
  if (typeof now !== 'function') throw new TypeError('now must be a function.');
  if (!validDuration(voteWindowMs)) throw new RangeError('voteWindowMs must be an integer from 1000 to 600000.');
  if (!Number.isSafeInteger(eventTtlMs) || eventTtlMs < 1) throw new RangeError('eventTtlMs must be a positive safe integer.');
  if (!Number.isSafeInteger(maxEventIds) || maxEventIds < 1 || maxEventIds > 100_000) throw new RangeError('maxEventIds must be an integer from 1 to 100000.');
  if (!Number.isSafeInteger(sourceCueMs) || sourceCueMs < 1_000 || sourceCueMs > 60_000) throw new RangeError('sourceCueMs must be an integer from 1000 to 60000.');

  let connectionStatus = 'disconnected';
  let phase = 'idle';
  let opensAt = null;
  let closesAt = null;
  const votes = new Map();
  const seenEvents = new Map();
  const counts = { a: 0, b: 0 };
  const metrics = { acceptedVotes: 0, duplicates: 0, invalidEvents: 0 };
  const sourceCue = { active: false, requestedAt: null, expiresAt: null, requestCount: 0, origin: 'simulated' };

  function clock() {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) throw new RangeError('now() must return a nonnegative safe integer in milliseconds.');
    return value;
  }

  function expire(time) {
    if (phase === 'open' && time >= closesAt) phase = 'closed';
    if (sourceCue.active && time >= sourceCue.expiresAt) clearSourceCue();
  }

  function clearSourceCue(clearCount = false) {
    sourceCue.active = false;
    sourceCue.requestedAt = null;
    sourceCue.expiresAt = null;
    if (clearCount) sourceCue.requestCount = 0;
  }

  function pruneEvents(time) {
    for (const [id, receivedAt] of seenEvents) {
      if (time - receivedAt >= eventTtlMs) seenEvents.delete(id);
    }
  }

  function getState() {
    expire(clock());
    return snapshot({
      mode: 'simulated',
      realTwitchConnected: false,
      card: safeCard,
      connection: { status: connectionStatus },
      sourceCue,
      vote: {
        phase,
        opensAt,
        closesAt,
        counts,
        total: votes.size,
        uniqueVoters: votes.size,
      },
      metrics,
    });
  }

  function result(ok, code, message, extra = {}) {
    return { ok, code, message, ...extra, state: getState() };
  }

  function openVote(durationMs = voteWindowMs) {
    if (!validDuration(durationMs)) return result(false, 'invalid_duration', 'Vote window must be an integer from 1000 to 600000 milliseconds.');
    const time = clock();
    expire(time);
    if (phase === 'open') return result(false, 'vote_already_open', 'Close the current round before starting another.');
    if (!Number.isSafeInteger(time + durationMs)) return result(false, 'invalid_duration', 'Vote deadline exceeds the safe clock range.');
    votes.clear();
    counts.a = 0;
    counts.b = 0;
    phase = 'open';
    opensAt = time;
    closesAt = time + durationMs;
    return result(true, 'vote_opened', 'Simulation vote window opened.');
  }

  function closeVote() {
    expire(clock());
    if (phase !== 'open') return result(false, 'vote_not_open', 'There is no open vote window.');
    phase = 'closed';
    return result(true, 'vote_closed', 'Simulation vote window closed.');
  }

  function setConnection(status) {
    if (!CONNECTION_STATUSES.has(status)) return result(false, 'invalid_connection', 'Connection must be disconnected, connecting, or connected.');
    connectionStatus = status;
    if (status !== 'connected') clearSourceCue();
    return result(true, 'connection_changed', `Simulation transport is ${status}.`);
  }

  function processEvent(event) {
    const time = clock();
    expire(time);
    if (!event || typeof event !== 'object' || Array.isArray(event)) {
      metrics.invalidEvents += 1;
      return result(false, 'invalid_event', 'An event object is required.');
    }
    if (event.origin !== 'simulated') {
      metrics.invalidEvents += 1;
      return result(false, 'unsupported_origin', 'This build accepts simulated events only; Twitch is not connected.');
    }
    if (!validId(event.id) || !validId(event.userId) || typeof event.text !== 'string' || event.text.length > MAX_COMMAND_LENGTH) {
      metrics.invalidEvents += 1;
      return result(false, 'invalid_event', 'Provide bounded event ID, viewer ID, and at most 300 characters of text.');
    }
    if (event.timestamp !== undefined && (!Number.isSafeInteger(event.timestamp) || event.timestamp < 0 || event.timestamp > time + 5_000)) {
      metrics.invalidEvents += 1;
      return result(false, 'invalid_event', 'Event timestamp must be a valid server-comparable millisecond value.');
    }

    pruneEvents(time);
    if (seenEvents.has(event.id)) {
      metrics.duplicates += 1;
      return result(false, 'duplicate_event', 'Event already processed; totals unchanged.');
    }
    // Cache even rejected commands/disconnected votes: replay must not turn a
    // rejected event into an accepted vote after reconnect or a new round.
    while (seenEvents.size >= maxEventIds) seenEvents.delete(seenEvents.keys().next().value);
    seenEvents.set(event.id, time);

    const command = parseCommand(event.text);
    if (command.type === 'ignore') return result(true, 'ignored', 'Ordinary simulated chat ignored.');
    if (command.type === 'invalid') {
      metrics.invalidEvents += 1;
      return result(false, 'invalid_command', command.reason);
    }
    if (command.type === 'source') {
      const reply = `${safeCard.source.title} — ${safeCard.source.publisher}: ${safeCard.source.url}`;
      let sourceCueReason;
      let sourceCuePublished = false;
      if (connectionStatus !== 'connected') sourceCueReason = 'disconnected';
      else if (event.timestamp !== undefined && event.timestamp < time - sourceCueMs) sourceCueReason = 'stale_event';
      else if (!Number.isSafeInteger(sourceCue.requestCount + 1)) sourceCueReason = 'counter_limit';
      else if (!sourceCue.active && !Number.isSafeInteger(time + sourceCueMs)) sourceCueReason = 'unsafe_deadline';
      else {
        sourceCue.requestCount += 1;
        sourceCuePublished = true;
        sourceCueReason = sourceCue.active ? 'already_active' : 'opened';
        if (!sourceCue.active) {
          sourceCue.active = true;
          sourceCue.requestedAt = time;
          sourceCue.expiresAt = time + sourceCueMs;
        }
      }
      const message = sourceCueReason === 'opened'
        ? 'Source requested. Simulated overlay cue opened.'
        : sourceCueReason === 'already_active'
          ? 'Source requested. Simulated request counted without extending the active cue.'
          : 'Source reply available locally; simulated overlay cue was not published.';
      return result(true, 'source', message, { reply, sourceCuePublished, sourceCueReason });
    }
    if (command.type === 'help') return result(true, 'help', 'Command help requested.', { reply: 'Simulation commands: !vote a, !vote b, !source, !help. One vote per viewer; another vote changes your choice.' });
    if (phase !== 'open') return result(false, 'vote_closed', 'The vote window is not open.');
    if (connectionStatus !== 'connected') return result(false, 'disconnected', 'Simulation transport is not connected; this vote was not counted.');
    if (event.timestamp !== undefined && (event.timestamp < opensAt || event.timestamp >= closesAt)) {
      return result(false, 'stale_event', 'Event belongs outside the current vote window.');
    }

    const previous = votes.get(event.userId);
    if (previous === command.choice) return result(true, 'vote_unchanged', 'This simulated viewer already chose that option.');
    if (previous) counts[previous] -= 1;
    votes.set(event.userId, command.choice);
    counts[command.choice] += 1;
    metrics.acceptedVotes += 1;
    return result(true, previous ? 'vote_changed' : 'vote_recorded', previous ? 'Simulated viewer choice changed.' : 'Simulated vote recorded.');
  }

  function reset() {
    phase = 'idle';
    opensAt = null;
    closesAt = null;
    votes.clear();
    counts.a = 0;
    counts.b = 0;
    clearSourceCue(true);
    return result(true, 'reset', 'Simulation round reset. Event replay protection is retained.');
  }

  // Fail early for a broken injected clock, before handing an instance out.
  clock();
  return Object.freeze({ getState, openVote, closeVote, setConnection, processEvent, reset });
}
