import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createLiveTally } from '../src/live-tally.mjs';
import { createNativeLiveHost } from '../src/native-live-host.mjs';
import { createOverlayServer } from '../src/live-overlay-server.mjs';

// Synthetic aggregate events and direct HTTP-handler invocations only. No
// listening socket, OAuth request, real Twitch or browser/OBS observation.
const runFile = promisify(execFile);
const BASE = Date.parse('2026-10-26T12:00:00.000Z');
const event = (id, userId, text, timestamp = BASE) => ({ id, userId, text, timestamp });

test('live aggregate counts one current choice per viewer, retains dedupe across reset and excludes closing instant', () => {
  let time = BASE;
  const tally = createLiveTally({ now: () => time });
  tally.open(1000);
  assert.equal(tally.accept(event('one', 'viewer1', '!vote a'), true).code, 'vote_recorded');
  assert.equal(tally.accept(event('one', 'viewer1', '!vote b'), true).code, 'duplicate_event');
  assert.equal(tally.accept(event('two', 'viewer1', '!vote b'), true).code, 'vote_changed');
  assert.deepEqual(tally.state(true).vote.counts, { a: 0, b: 1 });
  time += 1000;
  assert.equal(tally.accept(event('three', 'viewer2', '!vote a', time), true).code, 'vote_closed');
  tally.reset(); tally.open(1000);
  assert.equal(tally.accept(event('one', 'viewer1', '!vote a'), true).code, 'duplicate_event');
  assert.equal(tally.state(true).vote.total, 0);
});

test('source cue has a fixed deadline and disconnect clears it without accepting chat', () => {
  let time = BASE;
  const tally = createLiveTally({ now: () => time });
  tally.open();
  assert.equal(tally.accept(event('source1', 'viewer1', '!source'), true).code, 'source');
  const expiry = tally.state(true).sourceCue.expiresAt;
  time += 1000; tally.accept(event('source2', 'viewer2', '!source', time), true);
  assert.equal(tally.state(true).sourceCue.expiresAt, expiry);
  assert.equal(tally.state(false).sourceCue.active, false);
  assert.equal(tally.accept(event('vote1', 'viewer1', '!vote a', time), false).code, 'inactive');
  assert.equal(tally.state(false).vote.total, 0);
});

test('missing identifiers, malformed input and stale source events never enter a live aggregate', () => {
  const tally = createLiveTally({ now: () => BASE });
  tally.open();
  assert.equal(tally.accept({ text: '!vote a', timestamp: BASE }, true).code, 'invalid_event');
  assert.equal(tally.accept(event('a', 'viewer1', '!vote c'), true).code, 'invalid_command');
  assert.equal(tally.accept(event('b', 'viewer1', '!source', BASE - 20_000), true).code, 'stale_event');
  assert.equal(tally.state(true).vote.total, 0); assert.equal(tally.state(true).sourceCue.active, false);
  assert.doesNotMatch(JSON.stringify(tally.state(true)), /viewer1/);
});

test('native host construction/inspection/stop are inert and expose no event or simulation facade', async () => {
  const abort = new AbortController();
  const host = createNativeLiveHost({ clientId: 'syntheticdraft01', channelLogin: 'syntheticowner', signal: abort.signal,
    onPrivatePrompt() { assert.fail('No OAuth call is permitted in this check.'); } });
  const before = host.getState();
  assert.equal(before.realTwitchConnected, false); assert.equal(before.authorizationVerified, false); assert.equal(before.phase, 'idle');
  assert.equal('processEvent' in host, false); assert.equal('simulation' in host, false); assert.equal('setConnection' in host, false);
  await host.stop(); assert.equal(host.getState().phase, 'stopped');
});

async function request(server, { method = 'GET', path = '/api/state', validHost = true } = {}) {
  return new Promise((resolve) => {
    const headers = {};
    const response = { setHeader(name, value) { headers[name] = value; },
      writeHead(status, values) { this.status = status; Object.assign(headers, values); },
      end(body) { resolve({ status: this.status, body: Buffer.isBuffer(body) ? body.toString() : body, headers }); } };
    server.emit('request', { method, url: path, headers: { host: validHost ? '127.0.0.1:4174' : 'attacker.example' }, socket: { localPort: 4174 } }, response);
  });
}
test('overlay handler is read-only, denies simulator/event routes and does not require a listening socket for checks', async () => {
  const server = createOverlayServer({ getState: () => ({ mode: 'synthetic-handler-fixture', realTwitchConnected: false }) });
  assert.equal(server.listening, false);
  assert.equal((await request(server)).status, 200);
  for (const path of ['/api/simulate', '/api/connection', '/api/vote/open']) {
    assert.equal((await request(server, { method: 'POST', path })).status, 405);
    assert.equal((await request(server, { path })).status, 404);
  }
  assert.equal((await request(server, { validHost: false })).status, 403);
  assert.match((await request(server, { path: '/overlay' })).body, /TWITCH STATUS UNVERIFIED/);
  assert.equal(server.listening, false);
});

test('actual Twitch CLI help, plan and redirected start remain inert', async () => {
  const path = fileURLToPath(new URL('../scripts/start-twitch.mjs', import.meta.url));
  const args = ['--client-id', 'syntheticdraft01', '--channel', 'syntheticowner', '--app-name', 'Draft app'];
  assert.match((await runFile(process.execPath, [path, '--help'])).stdout, /Default prints the public plan without activation/);
  const plan = JSON.parse((await runFile(process.execPath, [path, ...args])).stdout);
  assert.equal(plan.ownChannelLogin, 'syntheticowner'); assert.equal(plan.sendsChat, false);
  await assert.rejects(runFile(process.execPath, [path, ...args, '--start']), (error) => {
    assert.match(error.stdout, /private_interactive_terminal_required/); assert.match(error.stdout, /"networkAttempted":false/); return true;
  });
});


test('actual native-host modules compose through isolated synthetic external ports', async (t) => {
  const fixture = fileURLToPath(new URL('../fixtures/native-live-composition.mjs', import.meta.url));
  // A default node --test child inherits an internal runner-context marker.
  // Remove just that marker so the explicit isolated child runs its fixture
  // instead of silently skipping a recursive run and reporting an empty0 exit.
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;
  let child;
  try {
    child = await runFile(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-reporter=tap', fixture], {
      timeout: 30_000, maxBuffer: 1024 * 1024, env: childEnvironment,
    });
  } catch (error) {
    t.diagnostic('composition-child-result ' + JSON.stringify({ exitCode: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }));
    assert.fail('Isolated synthetic composition child failed; retained diagnostic has its actual output.');
  }
  // Escaped diagnostic data preserves the exact child output without creating
  // another top-level product-test count. This parent case counts exactly once.
  t.diagnostic('composition-child-result ' + JSON.stringify({ exitCode: 0, stdout: child.stdout, stderr: child.stderr }));
  assert.match(child.stdout, /^# tests 1\r?$/m);
  assert.match(child.stdout, /^# pass 1\r?$/m);
  assert.match(child.stdout, /^# fail 0\r?$/m);
});

test('owner input cancellation across CLI startup awaits settles without a second event', async (t) => {
  const fixture = fileURLToPath(new URL('../fixtures/native-live-shutdown.mjs', import.meta.url));
  const childEnvironment = { ...process.env };
  delete childEnvironment.NODE_TEST_CONTEXT;
  delete childEnvironment.SEB_SHUTDOWN_CLI_PATH;
  let child;
  try {
    child = await runFile(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-reporter=tap', fixture], {
      timeout: 30_000, maxBuffer: 1024 * 1024, env: childEnvironment,
    });
  } catch (error) {
    t.diagnostic('shutdown-child-result ' + JSON.stringify({ exitCode: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }));
    assert.fail('Isolated synthetic CLI cancellation regression failed; actual output retained in diagnostic.');
  }
  t.diagnostic('shutdown-child-result ' + JSON.stringify({ exitCode: 0, stdout: child.stdout, stderr: child.stderr }));
  assert.match(child.stdout, /^# tests 1\r?$/m);
  assert.match(child.stdout, /^# pass 1\r?$/m);
  assert.match(child.stdout, /^# fail 0\r?$/m);
});
