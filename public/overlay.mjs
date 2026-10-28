const $ = (id) => document.getElementById(id);
let sourceCueTimer;
let sourceCueDeadline;
async function readResponse() {
  const controller = new AbortController();
  let timeout;
  const expired = new Promise((_, reject) => {
    timeout = setTimeout(() => { controller.abort(); reject(new Error('Local request timed out.')); }, 5000);
  });
  try {
    return await Promise.race([(async () => {
      const response = await fetch('/api/state', { cache: 'no-store', signal: controller.signal });
      if (!response.ok) throw new Error('state unavailable');
      return response.json();
    })(), expired]);
  } finally { clearTimeout(timeout); }
}
function renderSourceCue(cue, connected) {
  const active = connected && cue?.active === true && cue.origin === 'simulated'
    && Number.isSafeInteger(cue.expiresAt) && cue.expiresAt > Date.now();
  if (!active || sourceCueDeadline !== cue.expiresAt) {
    clearTimeout(sourceCueTimer);
    sourceCueDeadline = active ? cue.expiresAt : undefined;
    if (active) sourceCueTimer = setTimeout(() => renderSourceCue(null, false), Math.max(1, cue.expiresAt - Date.now()));
  }
  const label = active ? 'Simulated source request · source shown locally' : '';
  const element = $('overlay-source-cue');
  element.hidden = !active;
  if (element.textContent !== label) element.textContent = label;
  $('overlay-source-panel').classList.toggle('source-requested', active);
}
async function poll() {
  try {
    const { card, vote, connection, sourceCue } = await readResponse();
    $('overlay-claim').textContent = card.claim;
    $('overlay-prompt').textContent = card.prompt;
    for (const choice of ['a', 'b']) {
      $('overlay-' + choice).textContent = card.choices[choice];
      $('overlay-count-' + choice).textContent = String(vote.counts[choice]);
      $('overlay-bar-' + choice).value = vote.total ? 100 * vote.counts[choice] / vote.total : 0;
    }
    $('overlay-total').textContent = `${vote.total} simulated voter${vote.total === 1 ? '' : 's'}`;
    $('overlay-phase').textContent = vote.phase === 'open' ? `Open · ${Math.max(0, Math.ceil((vote.closesAt - Date.now()) / 1000))}s` : vote.phase === 'closed' ? 'Voting closed' : 'Voting not started';
    $('overlay-connection').textContent = connection.status === 'connected' ? 'Local simulator connected · real Twitch pending' : `Simulator ${connection.status} · vote intake paused`;
    $('overlay-source').textContent = `${card.source.publisher} / ${card.source.title} ↗`;
    $('overlay-source').href = card.source.url;
    renderSourceCue(sourceCue, connection.status === 'connected');
  } catch {
    renderSourceCue(null, false);
    $('overlay-connection').textContent = 'LOCAL CONNECTION LOST · displayed results may be stale';
    $('overlay-phase').textContent = 'State unavailable';
  }
  setTimeout(poll, 500);
}
poll();
