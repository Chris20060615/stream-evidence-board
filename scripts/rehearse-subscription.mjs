import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createSubscriptionPreflight } from '../src/subscription-preflight.mjs';

// Only bundled synthetic receipts are loaded. No credential or network path.
const fixture = JSON.parse(await readFile(new URL('../fixtures/synthetic-subscription.json', import.meta.url), 'utf8'));
assert.equal(fixture.provenance, 'synthetic');
const start = Date.parse(fixture.clockStart);
let clock = start;
const preflight = createSubscriptionPreflight({ ...fixture.configuration, now: () => clock });
const results = [];
let originalDeadline;
let acknowledged = 0;
for (const step of fixture.steps) {
  clock = start + step.elapsedMs;
  let result;
  if (step.action === 'validation') result = preflight.acceptValidation(step.input);
  else if (step.action === 'ack') result = preflight.acceptAcknowledgement(step.input);
  else if (step.action === 'plan') {
    const { welcomeReceivedAtOffsetMs, ...input } = step.input;
    result = preflight.planSubscription({ ...input, welcomeReceivedAt: start + welcomeReceivedAtOffsetMs });
    if (result.request) {
      assert.equal(result.request.requiresSecureAuthorization, true);
      assert.equal(result.request.provenance, 'synthetic');
      assert.equal(Object.hasOwn(result.request, 'headers'), false);
      assert.equal(result.request.method, 'POST');
      assert.equal(result.request.url, 'https://api.twitch.tv/helix/eventsub/subscriptions');
    }
    if (step.elapsedMs === 1000) originalDeadline = preflight.getState().subscribeDeadline;
    if (step.elapsedMs === 2000) assert.equal(preflight.getState().subscribeDeadline, originalDeadline);
  } else throw new Error('Unknown synthetic action.');
  assert.equal(result.ok, step.expectedOk, `${step.label}: ${result.code}`);
  const state = preflight.getState();
  assert.equal(state.networkConnected, false);
  assert.equal(state.authorizationVerified, false);
  if (result.code === 'acknowledged') acknowledged += 1;
  results.push({ label: step.label, ok: result.ok, code: result.code, phase: state.phase });
}
assert.equal(acknowledged, 1);
console.log(JSON.stringify({
  provenance: 'synthetic',
  mode: 'offline-subscription-rehearsal',
  networkConnected: false,
  authorizationVerified: false,
  syntheticAcknowledgementsChecked: acknowledged,
  assertions: 'passed',
  steps: results,
  finalState: preflight.getState()
}, null, 2));
