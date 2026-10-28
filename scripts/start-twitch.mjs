import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import { createTwurpleLiveHost } from '../src/twurple-live-host.mjs';
import { createOverlayServer } from '../src/live-overlay-server.mjs';
import { confirmOwnChannel } from '../src/operator-confirmation.mjs';

const usage = 'node scripts/start-twitch.mjs --client-id PUBLIC_ID --channel OWN_PUBLIC_LOGIN --app-name APP_LABEL [--start]';
const args = process.argv.slice(2);
const abort = new AbortController();
let reader;
let host;
let server;
const interrupt = () => abort.abort();
const cancelled = () => abort.signal.aborted || reader?.closed === true;
process.once('SIGINT', interrupt);
process.once('SIGTERM', interrupt);
try {
  if (!args.length || (args.length === 1 && args[0] === '--help')) {
    process.stdout.write(usage + '\nOwn-channel runtime. Default prints the public plan without activation. --start requires a reviewed private TTY login.\n');
  } else {
    const values = new Map(); let start = false;
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '--start') { if (start) throw new Error(); start = true; }
      else {
        const key = args[i];
        if (!['--client-id', '--channel', '--app-name'].includes(key) || values.has(key) || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error();
        values.set(key, args[++i]);
      }
    }
    const clientId = values.get('--client-id'); const channelLogin = values.get('--channel')?.toLowerCase(); const appLabel = values.get('--app-name');
    if (values.size !== 3 || !/^[A-Za-z0-9]{1,128}$/.test(clientId ?? '') || !/^[a-z0-9_]{1,25}$/.test(channelLogin ?? '')
      || typeof appLabel !== 'string' || appLabel.length > 80 || !/^[A-Za-z0-9][A-Za-z0-9 ._-]*$/.test(appLabel) || appLabel !== appLabel.trim()) throw new Error();
    const plan = { clientId, ownChannelLogin: channelLogin, operatorSuppliedAppLabel: appLabel,
      scopes: ['user:read:chat'], sendsChat: false, persistsCredentials: false,
      identity: 'actual Twitch validate login match -> derive same broadcaster/reader numeric user_id',
      overlay: 'read-only aggregate display; no simulate/event/connection routes',
      transport: 'Twurple8.2 EventSub WebSocket; same broadcaster and reader',
      reconnect: 'pause disconnected intake; SDK manages reconnection; no missed-event replay' };
    process.stdout.write(JSON.stringify(plan, null, 2) + '\n');
    if (start) {
      if (process.stdin.isTTY !== true || process.stdout.isTTY !== true) {
        process.stdout.write('{"ok":false,"code":"private_interactive_terminal_required","networkAttempted":false}\n'); process.exitCode = 2;
      } else {
        process.stdout.write(`Check the app label, public client ID and own channel above. Check the actual app/read-chat scope on Twitch before granting.\nTemporary device instructions appear only here: use an unrecorded private terminal.\nType START ${channelLogin} and press Enter within 5 minutes. Type CANCEL to stop: `);
        reader = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
        const review = await confirmOwnChannel({ reader, signal: abort.signal, channelLogin,
          onInvalid() { process.stdout.write(`Confirmation did not match. Type START ${channelLogin} and press Enter, or CANCEL: `); } });
        if (!review.ok || cancelled()) {
          const code = review.ok ? (reader.closed ? 'confirmation_input_closed' : 'confirmation_cancelled') : review.code;
          process.stdout.write('\n' + JSON.stringify({ ok: false, code, networkAttempted: false }) + '\n'); process.exitCode = 2;
        }
        else {
          reader.once('close', interrupt);
          process.stdout.write('\nReview confirmed. Requesting a temporary Twitch device code...\n');
          host = createTwurpleLiveHost({ clientId, channelLogin, signal: abort.signal,
            onPrivatePrompt(prompt) { process.stdout.write(`\nOpen https://www.twitch.tv/activate in your own browser.\nTemporary user code: ${prompt.userCode}\nComplete login and review the actual app/read-chat scope there. Do not record this code.\n`); } });
          const started = await host.start();
          if (cancelled()) throw new Error('cancelled');
          if (!started.ok) { process.stdout.write(JSON.stringify(started) + '\n'); process.exitCode = 2; }
          else {
            server = createOverlayServer(host);
            await new Promise((resolve, reject) => { server.once('error', reject); server.listen(4174, '127.0.0.1', resolve); });
            if (cancelled()) throw new Error('cancelled');
            process.stdout.write('Owner display: http://127.0.0.1:4174/overlay\nTerminal commands: open [seconds1..600], close, reset, source 1|2 pending|viewed, status, quit.\nThe display is aggregate-only. Intake pauses during connection loss; missed chat is not replayed.\n');
            await new Promise((resolve) => {
              let settled = false;
              const finish = () => {
                if (settled) return;
                settled = true;
                reader.removeListener('line', command);
                reader.removeListener('close', finish);
                abort.signal.removeEventListener('abort', finish);
                resolve();
              };
              const command = (line) => {
                if (cancelled()) { finish(); return; }
                const words = line.trim().split(/\s+/);
                if (line === 'quit') { abort.abort(); finish(); }
                else if (words[0] === 'open' && words.length <= 2) process.stdout.write(JSON.stringify(host.openVote(words[1] ? Number(words[1]) * 1000 : 60_000)) + '\n');
                else if (line === 'close') process.stdout.write(JSON.stringify(host.closeVote()) + '\n');
                else if (line === 'reset') process.stdout.write(JSON.stringify(host.reset()) + '\n');
                else if (words[0] === 'source' && words.length === 3) process.stdout.write(JSON.stringify(host.markSource(Number(words[1]), words[2])) + '\n');
                else if (line === 'status') { const value = host.getState(); process.stdout.write(JSON.stringify({ phase: value.phase, realTwitchConnected: value.realTwitchConnected, counts: value.vote.counts }) + '\n'); }
                else process.stdout.write('Use open [seconds], close, reset, source 1|2 pending|viewed, status or quit.\n');
              };
              reader.on('line', command);
              reader.once('close', finish); abort.signal.addEventListener('abort', finish, { once: true });
              // The sole close/abort may already have fired before listeners
              // were installed; no second event is required for shutdown.
              if (cancelled()) finish();
            });
          }
        }
      }
    }
  }
} catch { process.stdout.write(JSON.stringify({ ok: false, code: cancelled() ? 'cancelled' : 'configuration_or_start_failed' }) + '\n'); process.exitCode = 2; }
finally {
  abort.abort(); reader?.close();
  if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  await host?.stop();
  process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); process.stdin.pause();
  // Twurple retains delivery-deduplication timers after listener.stop(). This
  // standalone owner process has finished all owned cleanup; end it rather
  // than retaining credentials while waiting for SDK timers/in-flight calls.
  // Imported lifecycle fixtures do not terminate their test process.
  if (host && process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exit(process.exitCode ?? 0);
}
