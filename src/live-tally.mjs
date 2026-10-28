import { parseCommand } from './engine.mjs';
import { evidenceCard } from './card.mjs';

// Small live tally, private to the native host. This file makes no network or
// provenance assertion. The host owns its accept callback; no HTTP route gets it.
export function createLiveTally({ now = Date.now, card = evidenceCard } = {}) {
  const publishedCard = structuredClone(card);
  // Older host-supplied cards keep their single-source display. The new
  // default evidence card has two sources; the simulator itself is unchanged.
  if (!Array.isArray(publishedCard.sources)) publishedCard.sources = [publishedCard.source];
  const sourceReviews = publishedCard.sources.map((_, index) => ({ sourceNumber: index + 1, status: 'pending' }));
  const seen = new Map();
  const voters = new Map();
  let phase = 'idle';
  let opensAt = null;
  let closesAt = null;
  let counts = { a: 0, b: 0 };
  let cue = { active: false, requestedAt: null, expiresAt: null, origin: 'twitch' };
  function expire(time) {
    if (phase === 'open' && time >= closesAt) phase = 'closed';
    if (cue.active && time >= cue.expiresAt) cue = { ...cue, active: false, requestedAt: null, expiresAt: null };
  }
  function state(connected) {
    expire(now());
    if (!connected && cue.active) cue = { ...cue, active: false, requestedAt: null, expiresAt: null };
    return structuredClone({ card: publishedCard, vote: { phase, opensAt, closesAt, counts, total: voters.size }, sourceCue: cue, sourceReviews });
  }
  function open(durationMs = 60_000) {
    if (!Number.isSafeInteger(durationMs) || durationMs < 1000 || durationMs > 600_000) return { ok: false, code: 'invalid_duration' };
    const time = now(); expire(time);
    if (phase === 'open') return { ok: false, code: 'vote_already_open' };
    phase = 'open'; opensAt = time; closesAt = time + durationMs; counts = { a: 0, b: 0 }; voters.clear();
    return { ok: true, code: 'vote_opened' };
  }
  function close() { expire(now()); if (phase !== 'open') return { ok: false, code: 'vote_not_open' }; phase = 'closed'; return { ok: true, code: 'vote_closed' }; }
  function reset() { phase = 'idle'; opensAt = closesAt = null; voters.clear(); counts = { a: 0, b: 0 }; cue = { ...cue, active: false, requestedAt: null, expiresAt: null }; sourceReviews.forEach((review) => { review.status = 'pending'; }); return { ok: true, code: 'reset' }; }
  function markSource(sourceNumber, status) {
    if (!Number.isSafeInteger(sourceNumber) || sourceNumber < 1 || sourceNumber > sourceReviews.length
      || (status !== 'pending' && status !== 'viewed')) return { ok: false, code: 'invalid_source_review' };
    sourceReviews[sourceNumber - 1].status = status;
    return { ok: true, code: 'source_marked', sourceNumber, status };
  }
  function accept(event, connected) {
    const time = now(); expire(time);
    if (!connected) return { ok: false, code: 'inactive' };
    if (!event || typeof event.id !== 'string' || typeof event.userId !== 'string'
      || !/^[A-Za-z0-9_-]{1,128}$/.test(event.id) || !/^[A-Za-z0-9_-]{1,128}$/.test(event.userId)
      || typeof event.text !== 'string' || event.text.length > 300 || !Number.isSafeInteger(event.timestamp)
      || event.timestamp < 0 || event.timestamp > time + 5000) return { ok: false, code: 'invalid_event' };
    for (const [id, at] of seen) if (time - at >= 300_000) seen.delete(id);
    if (seen.has(event.id)) return { ok: false, code: 'duplicate_event' };
    while (seen.size >= 2000) seen.delete(seen.keys().next().value);
    seen.set(event.id, time);
    const command = parseCommand(event.text);
    if (command.type === 'source') {
      if (event.timestamp < time - 15_000) return { ok: false, code: 'stale_event' };
      if (!cue.active) cue = { active: true, requestedAt: time, expiresAt: time + 15_000, origin: 'twitch' };
      return { ok: true, code: 'source' };
    }
    if (command.type === 'invalid') return { ok: false, code: 'invalid_command' };
    if (command.type !== 'vote') return { ok: true, code: command.type };
    if (phase !== 'open') return { ok: false, code: 'vote_closed' };
    if (event.timestamp < opensAt || event.timestamp >= closesAt) return { ok: false, code: 'stale_event' };
    const old = voters.get(event.userId);
    if (old === command.choice) return { ok: true, code: 'vote_unchanged' };
    if (old) counts[old] -= 1;
    voters.set(event.userId, command.choice); counts[command.choice] += 1;
    return { ok: true, code: old ? 'vote_changed' : 'vote_recorded' };
  }
  return Object.freeze({ state, open, close, reset, accept, markSource });
}
