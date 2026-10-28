import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseOperatorLoginArgs, runOperatorLogin } from '../src/operator-login.mjs';

// Synthetic receipts and in-memory pretend terminal only. No actual OAuth,
// account, browser, remote service or credential is used by these checks.
const runFile = promisify(execFile);
const CLIENT = 'syntheticoperator01';
const CHANNEL = '12345';
const ACCESS = 'SYNTHETIC_OPERATOR_ACCESS_CANARY';
const REFRESH = 'SYNTHETIC_OPERATOR_REFRESH_CANARY';
const DEVICE = 'SYNTHETIC_OPERATOR_DEVICE_CANARY';
const CODE = 'TEST1234';
const args = ['--client-id', CLIENT, '--channel-id', CHANNEL, '--app-name', 'Synthetic local app'];
const flush = () => new Promise((resolve) => setImmediate(resolve));

function clock() {
  let time = Date.parse('2026-10-26T10:00:00.000Z');
  let next = 0;
  const timers = new Map();
  return { now: () => time, setTimer(fn, delay) { const id = ++next; timers.set(id, { fn, at: time + delay }); return id; },
    clearTimer(id) { timers.delete(id); }, pending: () => timers.size,
    async advance(ms) {
      const target = time + ms;
      for (let count = 0; count < 100; count += 1) {
        const due = [...timers.entries()].filter(([, item]) => item.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) { time = target; await flush(); return; }
        timers.delete(due[0]); time = due[1].at; due[1].fn();
        for (let turn = 0; turn < 10; turn += 1) await flush();
      }
      throw new Error('Synthetic timer loop exceeded bound.');
    } };
}
function fixture({ terminal = true, validationUser = CHANNEL } = {}) {
  const input = new PassThrough(); input.isTTY = terminal;
  let text = '';
  const output = new Writable({ write(chunk, encoding, done) { text += chunk.toString(); done(); } }); output.isTTY = terminal;
  const calls = [];
  const timing = clock();
  const controller = new AbortController();
  const fetchImpl = async (url, options) => {
    calls.push({ url, method: options.method, body: options.body, headers: { ...options.headers } });
    let body;
    if (url === 'https://id.twitch.tv/oauth2/device') body = { device_code: DEVICE, user_code: CODE,
      verification_uri: `https://www.twitch.tv/activate?public=true&device-code=${CODE}`, expires_in: 600, interval: 5 };
    else if (url === 'https://id.twitch.tv/oauth2/token') body = { access_token: ACCESS, refresh_token: REFRESH,
      expires_in: 3600, scope: ['user:read:chat'], token_type: 'bearer' };
    else if (url === 'https://id.twitch.tv/oauth2/validate') body = { client_id: CLIENT, user_id: validationUser,
      expires_in: 3600, scopes: ['user:read:chat'], login: 'syntheticoperator' };
    else throw new Error('Unexpected synthetic fetch URL.');
    return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  return { input, output, calls, timing, controller, text: () => text,
    ports: { input, output, fetchImpl, signal: controller.signal, ...timing } };
}
async function until(predicate) {
  for (let index = 0; index < 100; index += 1) { if (predicate()) return; await flush(); }
  assert.fail('Synthetic state did not settle.');
}
function privateResult(value) {
  assert.doesNotMatch(JSON.stringify(value), /SYNTHETIC_OPERATOR_(?:ACCESS|REFRESH|DEVICE)_CANARY|TEST1234|verificationUri|userCode/);
  assert.equal(value.chatConnected, false);
  assert.equal(value.boardStarted, false);
  assert.equal(value.credentialsPersisted, false);
}

test('operator argument parser is inert by default and rejects unknown/secret/duplicate flags', () => {
  assert.deepEqual(parseOperatorLoginArgs([]), { help: true });
  assert.deepEqual(parseOperatorLoginArgs(['--help']), { help: true });
  assert.equal(parseOperatorLoginArgs(args).authorize, false);
  assert.equal(parseOperatorLoginArgs([...args, '--authorize']).authorize, true);
  for (const bad of [[...args, '--token', ACCESS], [...args, '--authorize', '--authorize'],
    [...args, '--client-id', CLIENT], ['--authorize'], [...args.slice(0, -1), 'unsafe\x1b[2J']]) {
    assert.throws(() => parseOperatorLoginArgs(bad), { message: 'invalid_public_configuration' });
  }
});

test('public plan is usable without a terminal and never calls a network port', async () => {
  const f = fixture({ terminal: false });
  const value = await runOperatorLogin(parseOperatorLoginArgs(args), f.ports);
  assert.equal(value.code, 'review_only'); assert.equal(value.networkAttempted, false); assert.equal(f.calls.length, 0);
  const plan = JSON.parse(f.text());
  assert.equal(plan.scope, 'user:read:chat'); assert.equal(plan.connectsChat, false); assert.equal(plan.sendsChat, false);
  privateResult(value);
});

test('authorize rejects redirected input/output before prompting or fetching', async () => {
  const f = fixture({ terminal: false });
  const value = await runOperatorLogin(parseOperatorLoginArgs([...args, '--authorize']), f.ports);
  assert.equal(value.code, 'private_interactive_terminal_required'); assert.equal(f.calls.length, 0); assert.equal(f.text(), '');
  privateResult(value);
});

test('wrong typed review cancels without requesting a device code', async () => {
  const f = fixture();
  const pending = runOperatorLogin(parseOperatorLoginArgs([...args, '--authorize']), f.ports);
  f.input.write('yes\n');
  const value = await pending;
  assert.equal(value.code, 'cancelled'); assert.equal(f.calls.length, 0); assert.doesNotMatch(f.text(), /TEST1234/);
  privateResult(value);
});

test('accepted review composes actual device ports, grant flow and identity validation with synthetic HTTP', async () => {
  const f = fixture();
  const pending = runOperatorLogin(parseOperatorLoginArgs([...args, '--authorize']), f.ports);
  assert.equal(f.calls.length, 0);
  f.input.write(`AUTHORIZE ${CHANNEL}\n`);
  await until(() => f.text().includes(`Temporary user code: ${CODE}`));
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'POST');
  await f.timing.advance(5000);
  const value = await pending;
  assert.equal(value.code, 'identity_preflight_completed'); assert.equal(value.validationReceiptAccepted, true);
  assert.deepEqual(f.calls.map((call) => call.url), ['https://id.twitch.tv/oauth2/device',
    'https://id.twitch.tv/oauth2/token', 'https://id.twitch.tv/oauth2/validate']);
  assert.equal(new URLSearchParams(f.calls[0].body).get('scopes'), 'user:read:chat');
  assert.equal(f.calls[2].headers.Authorization, `OAuth ${ACCESS}`);
  assert.doesNotMatch(f.text(), /SYNTHETIC_OPERATOR_(?:ACCESS|REFRESH|DEVICE)_CANARY/);
  assert.equal(f.timing.pending(), 0); privateResult(value);
});

test('a different validated user fails own-channel binding without exposing service diagnostics', async () => {
  const f = fixture({ validationUser: '99999' });
  const pending = runOperatorLogin(parseOperatorLoginArgs([...args, '--authorize']), f.ports);
  f.input.write(`AUTHORIZE ${CHANNEL}\n`);
  await until(() => f.text().includes(`Temporary user code: ${CODE}`));
  await f.timing.advance(5000);
  const value = await pending;
  assert.equal(value.code, 'authorization_or_identity_failed'); assert.equal(value.validationReceiptAccepted, false);
  assert.equal(f.calls.length, 3); assert.equal(f.timing.pending(), 0); privateResult(value);
});

test('aborting the concrete review settles promptly with no network request', async () => {
  const f = fixture();
  const pending = runOperatorLogin(parseOperatorLoginArgs([...args, '--authorize']), f.ports);
  f.controller.abort();
  const value = await pending;
  assert.equal(value.code, 'cancelled'); assert.equal(f.calls.length, 0); privateResult(value);
});

test('cancellation after the private prompt retires polling and never validates a token', async () => {
  const f = fixture();
  const pending = runOperatorLogin(parseOperatorLoginArgs([...args, '--authorize']), f.ports);
  f.input.write(`AUTHORIZE ${CHANNEL}\n`);
  await until(() => f.text().includes(`Temporary user code: ${CODE}`));
  f.controller.abort();
  const value = await pending;
  await f.timing.advance(5000);
  assert.equal(value.code, 'cancelled'); assert.equal(f.calls.length, 1); assert.equal(f.timing.pending(), 0); privateResult(value);
});

test('actual CLI help and redirected authorize remain inert without echoing invalid secret input', async () => {
  const help = await runFile(process.execPath, ['scripts/authorize-twitch.mjs', '--help']);
  assert.match(help.stdout, /Default: public plan only/);
  await assert.rejects(runFile(process.execPath, ['scripts/authorize-twitch.mjs', ...args, '--authorize']), (error) => {
    const value = JSON.parse(error.stdout);
    assert.equal(value.code, 'private_interactive_terminal_required'); assert.equal(value.networkAttempted, false); return true;
  });
  await assert.rejects(runFile(process.execPath, ['scripts/authorize-twitch.mjs', ...args, '--secret', ACCESS]), (error) => {
    assert.doesNotMatch(error.stdout, /SYNTHETIC_OPERATOR_ACCESS_CANARY/); assert.equal(error.code, 2); return true;
  });
});
