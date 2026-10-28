import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { createTwurpleLiveHost } from '../src/twurple-live-host.mjs';

test('Twurple host factory stays inert, rejects SDK mock routing and offers no event injection', async () => {
  const savedFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = () => { requests += 1; throw new Error('Network is forbidden.'); };
  const config = { clientId: 'syntheticsdk01', channelLogin: 'syntheticowner', signal: new AbortController().signal,
    onPrivatePrompt() { assert.fail('Factory must not prompt.'); } };
  const previousMock = process.env.TWURPLE_MOCK_API_PORT;
  const hadMock = Object.hasOwn(process.env, 'TWURPLE_MOCK_API_PORT');
  try {
    delete process.env.TWURPLE_MOCK_API_PORT;
    const host = createTwurpleLiveHost(config);
    assert.equal(host.getState().phase, 'idle');
    assert.equal(host.getState().realTwitchConnected, false);
    assert.equal(host.getState().authorizationVerified, false);
    assert.equal('processEvent' in host, false);
    assert.equal('setConnection' in host, false);
    process.env.TWURPLE_MOCK_API_PORT = '';
    assert.throws(() => createTwurpleLiveHost(config), /mock_configuration_not_allowed/);
    assert.equal(host.getState().phase, 'mock_configuration_not_allowed');
    assert.equal((await host.start()).ok, false);
    assert.equal(requests, 0);
    await host.stop();
  } finally {
    globalThis.fetch = savedFetch;
    if (hadMock) process.env.TWURPLE_MOCK_API_PORT = previousMock; else delete process.env.TWURPLE_MOCK_API_PORT;
  }
});

test('installed Twurple auth, API and EventSub compose through isolated synthetic fetch/socket ports', async (t) => {
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.TWURPLE_MOCK_API_PORT;
  const fixture = fileURLToPath(new URL('../fixtures/twurple-live-composition.mjs', import.meta.url));
  let child;
  try {
    child = await promisify(execFile)(process.execPath, ['--experimental-test-module-mocks', '--test', '--test-reporter=tap', fixture],
      { env, timeout: 30_000, maxBuffer: 1024 * 1024 });
  } catch (error) {
    t.diagnostic('twurple-child-result ' + JSON.stringify({ exitCode: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }));
    assert.fail('Isolated synthetic SDK composition failed; actual output retained in diagnostic.');
  }
  t.diagnostic('twurple-child-result ' + JSON.stringify({ exitCode: 0, stdout: child.stdout, stderr: child.stderr }));
  assert.match(child.stdout, /^# tests 1\r?$/m);
  assert.match(child.stdout, /^# pass 1\r?$/m);
  assert.match(child.stdout, /^# fail 0\r?$/m);
});
