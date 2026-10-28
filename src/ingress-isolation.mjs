import { createBoard } from './engine.mjs';

/**
 * SYNTHETIC ingress isolation experiment. Possession of a local capability is
 * not evidence of Twitch, authentication, a socket, or a trusted host. This
 * module performs no network operations and never creates a live board.
 * The host facade is local authority, not a sandbox against code in this process.
 */
const numericId = (value) => typeof value === 'string' && /^[1-9][0-9]{0,24}$/.test(value);
const safeId = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const own = (value, key) => Object.hasOwn(value, key);

function freeze(value) {
  if (value && typeof value === 'object') {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}

// Read only own, enumerable data descriptors into a new object. Exact schemas
// reject cycles/foreign fields without traversing arbitrary input or getters.
function record(input, allowed, required = allowed) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_input');
  const prototype = Object.getPrototypeOf(input);
  if (prototype !== null && prototype !== Object.prototype) throw new Error('invalid_input');
  const keys = Reflect.ownKeys(input);
  if (keys.length > allowed.length || keys.some((key) => typeof key !== 'string' || !allowed.includes(key))) throw new Error('invalid_input');
  const result = Object.create(null);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(input, key);
    if (!descriptor || !own(descriptor, 'value') || !descriptor.enumerable) throw new Error('invalid_input');
    result[key] = descriptor.value;
  }
  if (required.some((key) => !own(result, key))) throw new Error('invalid_input');
  return result;
}

function cardSnapshot(input) {
  const card = record(input, ['id', 'claim', 'prompt', 'choices', 'source']);
  const choices = record(card.choices, ['a', 'b']);
  const source = record(card.source, ['title', 'publisher', 'url', 'note'], ['title', 'publisher', 'url']);
  if (!safeId(card.id) || [[card.claim, 500], [card.prompt, 500], [choices.a, 160], [choices.b, 160], [source.title, 200], [source.publisher, 200], [source.url, 2_048]].some(([value, maximum]) => typeof value !== 'string' || value.length > maximum)
    || (own(source, 'note') && (typeof source.note !== 'string' || source.note.length > 500))) throw new Error('invalid_input');
  return { ...card, choices: { ...choices }, source: { ...source } };
}

/**
 * Two separate board instances and caches. Only the simulation facade exposes
 * processEvent. The staged facade can tally an explicitly unverified event only
 * through a current, scoped, expiring, non-serializable local function identity.
 * All staged snapshots permanently identify the synthetic ingress harness.
 */
export function createIngressIsolation(options = {}) {
  let configuration;
  let boardConfiguration;
  let broadcasterId;
  let readerId;
  let now;
  let leaseMs;
  try {
    configuration = record(options, ['broadcasterId', 'readerId', 'now', 'card', 'boardOptions', 'leaseMs'], ['broadcasterId', 'readerId']);
    ({ broadcasterId, readerId } = configuration);
    now = configuration.now === undefined ? Date.now : configuration.now;
    leaseMs = configuration.leaseMs === undefined ? 60_000 : configuration.leaseMs;
    if (!numericId(broadcasterId) || !numericId(readerId) || broadcasterId !== readerId || typeof now !== 'function'
      || !Number.isSafeInteger(leaseMs) || leaseMs < 1 || leaseMs > 3_600_000) throw new Error('invalid_input');
    boardConfiguration = configuration.boardOptions === undefined ? {} : { ...record(configuration.boardOptions, ['voteWindowMs', 'eventTtlMs', 'maxEventIds', 'sourceCueMs'], []) };
    for (const value of Object.values(boardConfiguration)) if (!Number.isSafeInteger(value)) throw new Error('invalid_input');
    if (own(configuration, 'card')) boardConfiguration.card = cardSnapshot(configuration.card);
  } catch {
    throw new TypeError('invalid_configuration');
  }

  function clock() {
    let time;
    try { time = now(); } catch { throw new Error('invalid_clock'); }
    if (!Number.isSafeInteger(time) || time < 0) throw new Error('invalid_clock');
    return time;
  }

  let operationTime;
  let simulation;
  let stagedBoard;
  try {
    simulation = createBoard({ ...boardConfiguration, now: clock });
    stagedBoard = createBoard({ ...boardConfiguration, now: () => operationTime ?? clock() });
  } catch {
    throw new TypeError('invalid_configuration');
  }
  const capabilities = new WeakMap();
  let currentCapability = null;
  let currentRecord = null;
  let phase = 'inactive';
  let generation = 0;
  let issuedAt = null;
  let expiresAt = null;
  let stopped = false;

  function deactivate(reason) {
    if (currentRecord) currentRecord.status = reason;
    currentCapability = null;
    currentRecord = null;
    phase = reason;
    stagedBoard.setConnection('disconnected');
  }

  function expire(time) {
    if (currentRecord && time >= currentRecord.expiresAt) deactivate('expired');
  }

  function atBoundary(action) {
    const time = clock();
    const previous = operationTime;
    operationTime = time;
    try {
      expire(time);
      return action(time);
    } finally {
      operationTime = previous;
    }
  }

  function state() {
    const board = stagedBoard.getState();
    return freeze({
      ...board,
      mode: 'staged-ingress-harness',
      networkConnected: false,
      realTwitchConnected: false,
      authorizationVerified: false,
      sourceCue: { ...board.sourceCue, origin: 'ingress-harness' },
      ingress: { phase, generation, issuedAt, expiresAt },
    });
  }

  function result(ok, code, message) { return freeze({ ok, code, message, state: state() }); }
  function boardResult(value) { return freeze({ ...value, state: state() }); }
  function capProblem(capability) {
    const found = typeof capability === 'function' ? capabilities.get(capability) : undefined;
    if (!found) return 'invalid_capability';
    if (found.status === 'expired') return 'capability_expired';
    if (found.status !== 'active' || capability !== currentCapability) return 'capability_revoked';
    return null;
  }

  function issue(input) {
    return atBoundary((time) => {
      if (stopped) throw new Error('stopped');
      // Failed replacement must never leave an earlier capability usable.
      deactivate('revoked');
      let scope;
      try {
        scope = record(input, ['broadcasterId', 'readerId', 'sessionId', 'subscriptionId']);
        if (!numericId(scope.broadcasterId) || !numericId(scope.readerId) || !safeId(scope.sessionId) || !safeId(scope.subscriptionId)) throw new Error('invalid_input');
      } catch {
        if (!stopped) deactivate('revoked');
        throw new Error('invalid_input');
      }
      if (stopped) throw new Error('stopped');
      // A Proxy descriptor trap can synchronously reenter this local facade.
      // Retire any capability issued during inspection before replacing it.
      deactivate('revoked');
      if (scope.broadcasterId !== broadcasterId || scope.readerId !== readerId) throw new Error('scope_mismatch');
      const issueTime = clock();
      operationTime = issueTime;
      if (!Number.isSafeInteger(issueTime + leaseMs) || !Number.isSafeInteger(generation + 1)) throw new Error('unsafe_deadline');
      generation += 1;
      issuedAt = issueTime;
      expiresAt = issueTime + leaseMs;
      // A function has no JSON representation and structuredClone rejects it.
      // Calling it conveys no authority and does not deliver an event.
      const capability = Object.freeze(() => undefined);
      currentRecord = { sessionId: scope.sessionId, subscriptionId: scope.subscriptionId, expiresAt, status: 'active', generation };
      capabilities.set(capability, currentRecord);
      currentCapability = capability;
      phase = 'issued';
      stagedBoard.setConnection('connected');
      return capability;
    });
  }

  function deliver(capability, input) {
    return atBoundary((time) => {
      if (stopped) return result(false, 'stopped', 'Synthetic ingress harness is stopped.');
      const problem = capProblem(capability);
      if (problem) return result(false, problem, 'Synthetic ingress capability is not current and usable.');
      const admittedRecord = currentRecord;
      const admittedGeneration = generation;
      let packet;
      let event;
      try {
        packet = record(input, ['broadcasterId', 'readerId', 'sessionId', 'subscriptionId', 'event']);
        if (!numericId(packet.broadcasterId) || !numericId(packet.readerId) || !safeId(packet.sessionId) || !safeId(packet.subscriptionId)) throw new Error('invalid_input');
        event = record(packet.event, ['id', 'userId', 'text', 'timestamp', 'origin']);
        if (!safeId(event.id) || !numericId(event.userId) || typeof event.text !== 'string' || event.text.length > 300 || event.origin !== 'transport-unverified'
          || !Number.isSafeInteger(event.timestamp) || event.timestamp < 0 || event.timestamp - time > 5_000) throw new Error('invalid_input');
      } catch { return result(false, 'invalid_input', 'Synthetic ingress packet must match the bounded, unverified event schema.'); }
      if (packet.broadcasterId !== broadcasterId || packet.readerId !== readerId || packet.sessionId !== admittedRecord.sessionId || packet.subscriptionId !== admittedRecord.subscriptionId) {
        return result(false, 'scope_mismatch', 'Synthetic ingress packet does not match the current local scope.');
      }
      // Descriptor inspection is not a host-code sandbox. Still, a synchronous
      // revoke/stop/reissue during a Proxy trap must not reach the tally/cache.
      // Resample the receive clock at admission; the engine uses this same value.
      const admissionTime = clock();
      operationTime = admissionTime;
      expire(admissionTime);
      if (stopped) return result(false, 'stopped', 'Synthetic ingress harness is stopped.');
      const admissionProblem = capProblem(capability);
      if (admissionProblem || currentRecord !== admittedRecord || generation !== admittedGeneration) {
        return result(false, admissionProblem ?? 'capability_revoked', 'Synthetic ingress capability changed before admission.');
      }
      // This copy is solely for the second simulation engine. It is not a
      // transport-authentication upgrade and never reaches the public server.
      const simulatedEvent = { id: event.id, userId: event.userId, text: event.text, timestamp: event.timestamp, origin: 'simulated' };
      return boardResult(stagedBoard.processEvent(simulatedEvent));
    });
  }

  function revoke(capability) {
    return atBoundary(() => {
      if (stopped) return result(false, 'stopped', 'Synthetic ingress harness is stopped.');
      const problem = capProblem(capability);
      if (problem) return result(false, problem, 'Synthetic ingress capability is not current and usable.');
      deactivate('revoked');
      return result(true, 'capability_revoked', 'Synthetic ingress capability revoked.');
    });
  }

  function stop() {
    return atBoundary(() => {
      stopped = true;
      deactivate('stopped');
      return result(true, 'stopped', 'Synthetic ingress harness stopped.');
    });
  }

  const staged = Object.freeze({
    getState: () => atBoundary(() => state()),
    openVote: (durationMs) => atBoundary(() => boardResult(stagedBoard.openVote(durationMs))),
    closeVote: () => atBoundary(() => boardResult(stagedBoard.closeVote())),
    reset: () => atBoundary(() => {
      if (!stopped) deactivate('revoked');
      return boardResult(stagedBoard.reset());
    }),
  });
  const host = Object.freeze({ issue, deliver, revoke, stop });
  return Object.freeze({ simulation, staged, host });
}
