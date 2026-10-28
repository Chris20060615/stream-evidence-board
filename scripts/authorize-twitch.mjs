import { parseOperatorLoginArgs, runOperatorLogin, OPERATOR_LOGIN_USAGE } from '../src/operator-login.mjs';

// Native fetch is activated only after --authorize, private TTY checks and a
// matching typed review. This command does not open a browser or local server.
const controller = new AbortController();
const onInterrupt = () => controller.abort();
process.once('SIGINT', onInterrupt);
try {
  const plan = parseOperatorLoginArgs(process.argv.slice(2));
  if (plan.help) {
    process.stdout.write(OPERATOR_LOGIN_USAGE + '\nDefault: public plan only. --authorize requests a private-terminal login/identity preflight; it does not start chat or the board.\n');
  } else {
    const outcome = await runOperatorLogin(plan, { input: process.stdin, output: process.stdout,
      fetchImpl: globalThis.fetch, signal: controller.signal });
    process.stdout.write(JSON.stringify(outcome) + '\n');
    process.exitCode = outcome.ok ? 0 : 2;
  }
} catch {
  process.stdout.write(JSON.stringify({ ok: false, code: 'invalid_public_configuration', networkAttempted: false }) + '\n');
  process.exitCode = 2;
} finally {
  process.removeListener('SIGINT', onInterrupt);
  process.stdin.pause();
}
