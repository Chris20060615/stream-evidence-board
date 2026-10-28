import { createHostEntryGate } from '../src/host-entry-gate.mjs';

// Review-only public configuration. No activation branch, environment/file
// credential reader, network dependency, browser opener or default owner exists.
const args = process.argv.slice(2);
let output;
let exitCode = 0;
try {
  if (args.length === 1 && args[0] === '--help') {
    output = { ok: true, mode: 'review-only', activationAvailable: false,
      usage: 'node scripts/review-host-entry.mjs --client-id PUBLIC_ID --broadcaster-id NUMERIC_ID --reader-id SAME_NUMERIC_ID' };
  } else {
    const flags = new Map();
    for (let index = 0; index < args.length; index += 2) {
      const key = args[index];
      if (!['--client-id', '--broadcaster-id', '--reader-id'].includes(key) || flags.has(key)
        || typeof args[index + 1] !== 'string' || args[index + 1].startsWith('--')) throw new Error();
      flags.set(key, args[index + 1]);
    }
    if (flags.size !== 3) throw new Error();
    const gate = createHostEntryGate({ clientId: flags.get('--client-id'), broadcasterId: flags.get('--broadcaster-id'), readerId: flags.get('--reader-id'),
      review: () => null, createOwner: () => { throw new Error('activation_unavailable'); } });
    output = { ok: true, mode: 'review-only', activationAvailable: false, networkActivated: false,
      plan: gate.getPlan(), state: gate.getState() };
    gate.stop();
  }
} catch {
  output = { ok: false, code: 'public_configuration_required', mode: 'review-only', activationAvailable: false, networkActivated: false };
  exitCode = 2;
}
process.stdout.write(JSON.stringify(output, null, 2) + '\n');
process.exitCode = exitCode;
