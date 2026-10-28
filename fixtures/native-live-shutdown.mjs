import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';

// CLI lifecycle regression only: all host/server/readline implementations are
// stand-ins. It never uses a real terminal, app identity, OAuth or listening port.
test('closed owner input at startup await boundaries cannot publish a display or wait for another abort', async (t) => {
  const target = process.env.SEB_SHUTDOWN_CLI_PATH
    ? pathToFileURL(process.env.SEB_SHUTDOWN_CLI_PATH)
    : new URL('../scripts/start-twitch.mjs', import.meta.url);
  const observations = [];
  for (const timing of ['during_host_start', 'during_server_bind']) {
    const savedArgs = process.argv;
    const savedExit = process.exitCode;
    const inputTty = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
    const outputTty = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
    let reader;
    let output = '';
    let cancellationObserved;
    const cancelled = new Promise((resolve) => { cancellationObserved = resolve; });
    const calls = { hostStop: 0, serverCreated: 0, listen: 0, serverClose: 0, closeConnections: 0 };
    class Reader extends EventEmitter {
      closed = false;
      close() { if (!this.closed) { this.closed = true; this.emit('close'); cancellationObserved(); } }
    }
    const cancel = () => reader.close();
    const fakeReadline = () => {
      reader = new Reader();
      queueMicrotask(() => reader.emit('line', 'START syntheticowner'));
      return reader;
    };
    const fakeHost = () => ({
      start: () => new Promise((resolve) => setImmediate(() => { if (timing === 'during_host_start') cancel(); resolve({ ok: true }); })),
      stop: async () => { calls.hostStop += 1; },
      getState: () => ({ phase: 'synthetic-only', realTwitchConnected: false, vote: { counts: { a: 0, b: 0 } } }),
    });
    const fakeServer = () => {
      calls.serverCreated += 1;
      const server = new EventEmitter();
      server.listen = (port, address, ready) => {
        calls.listen += 1;
        setImmediate(() => { if (timing === 'during_server_bind') cancel(); ready(); });
        return server;
      };
      server.closeAllConnections = () => { calls.closeConnections += 1; };
      server.close = (done) => { calls.serverClose += 1; done(); };
      return server;
    };
    mock.module('node:readline', { namedExports: { createInterface: fakeReadline } });
    mock.module(new URL('../src/twurple-live-host.mjs', target), { namedExports: { createTwurpleLiveHost: fakeHost } });
    mock.module(new URL('../src/live-overlay-server.mjs', target), { namedExports: { createOverlayServer: fakeServer } });
    Object.defineProperty(process.stdin, 'isTTY', { value: true, configurable: true });
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true });
    mock.method(process.stdout, 'write', (chunk) => { output += String(chunk); return true; });
    process.argv = [process.execPath, target.pathname, '--client-id', 'syntheticshutdown01', '--channel', 'syntheticowner',
      '--app-name', 'Synthetic shutdown check', '--start'];
    let timer;
    try {
      const execution = import(new URL(target.href + '?shutdown-' + timing));
      await cancelled;
      const settled = await Promise.race([execution.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), 750); })]);
      clearTimeout(timer);
      const ownerDisplayPublished = output.includes('Owner display:');
      if (!settled) reader.emit('close'); // Release only the broken baseline, so the regression itself cannot hang.
      await execution;
      observations.push({ timing, settledAfterSoleCancellation: settled, ownerDisplayPublished, ...calls });
    } finally {
      clearTimeout(timer);
      process.argv = savedArgs; process.exitCode = savedExit;
      if (inputTty) Object.defineProperty(process.stdin, 'isTTY', inputTty); else delete process.stdin.isTTY;
      if (outputTty) Object.defineProperty(process.stdout, 'isTTY', outputTty); else delete process.stdout.isTTY;
      mock.restoreAll();
    }
  }
  t.diagnostic('shutdown-observations ' + JSON.stringify(observations));
  assert.deepEqual(observations.map((value) => ({ timing: value.timing, settled: value.settledAfterSoleCancellation,
    published: value.ownerDisplayPublished, listened: value.listen, stopped: value.hostStop })), [
    { timing: 'during_host_start', settled: true, published: false, listened: 0, stopped: 1 },
    { timing: 'during_server_bind', settled: true, published: false, listened: 1, stopped: 1 },
  ]);
});
