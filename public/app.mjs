const $ = (id) => document.getElementById(id);
let state;
let lastEvent;
let pending = false;
let latestRequest = 0;
let renderedRequest = 0;
let serverAvailable = false;
let sourceCueTimer;
let sourceCueDeadline;

async function readResponse(path, options) {
  const controller = new AbortController();
  let timeout;
  const expired = new Promise((_, reject) => {
    timeout = setTimeout(() => { controller.abort(); reject(new Error('Local request timed out.')); }, 5000);
  });
  try {
    return await Promise.race([(async () => {
      const response = await fetch(path, { ...options, signal: controller.signal });
      return { response, data: await response.json() };
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
  const element = $('source-cue');
  element.hidden = !active;
  if (element.textContent !== label) element.textContent = label;
  $('source-panel').classList.toggle('source-requested', active);
}

function markUnavailable() {
  serverAvailable = false;
  $('sync').textContent = 'Local server unavailable · displayed results may be stale';
  $('connection').textContent = 'Local connection lost';
  $('connection-dot').classList.remove('connected');
  $('open').disabled = true;
  $('close').disabled = true;
  $('replay').disabled = true;
  $('timer').textContent = 'State unavailable';
  renderSourceCue(null, false);
}

function render(next) {
  state = next;
  const { card, vote, connection } = state;
  $('claim').textContent = card.claim;
  $('prompt').textContent = card.prompt;
  for (const choice of ['a', 'b']) {
    $('choice-' + choice).textContent = card.choices[choice];
    $('count-' + choice).textContent = String(vote.counts[choice]);
    $('bar-' + choice).value = vote.total ? 100 * vote.counts[choice] / vote.total : 0;
  }
  $('total').textContent = `${vote.total} simulated voter${vote.total === 1 ? '' : 's'}`;
  $('phase').textContent = vote.phase;
  $('timer').textContent = vote.phase === 'open' ? `${Math.max(0, Math.ceil((vote.closesAt - Date.now()) / 1000))}s remaining` : vote.phase === 'closed' ? 'Voting closed' : 'No active vote';
  $('source-link').textContent = `${card.source.publisher} · ${card.source.title} ↗`;
  $('source-link').href = card.source.url;
  $('source-note').textContent = card.source.note;
  const connected = connection.status === 'connected';
  renderSourceCue(state.sourceCue, connected);
  $('connection').textContent = `Simulator ${connection.status}`;
  $('connection-dot').classList.toggle('connected', connected);
  $('connect').textContent = connected ? 'Disconnect simulator' : 'Connect simulator';
  $('sync').textContent = 'Local server reachable · Twitch not connected';
  $('open').disabled = pending || !connected || vote.phase === 'open';
  $('close').disabled = pending || vote.phase !== 'open';
  $('replay').disabled = pending || !lastEvent;
}

function feedback(result) {
  const message = typeof result.reply === 'string' ? result.reply : result.message || result.code || 'State updated.';
  $('feedback').textContent = `${result.code || 'ok'} · ${message}`;
  $('feedback').classList.toggle('error', result.ok === false);
  const item = document.createElement('li');
  item.textContent = `${new Date().toLocaleTimeString()} · SIMULATED · ${result.code || 'ok'} · ${message}`;
  $('event-log').prepend(item);
  while ($('event-log').children.length > 8) $('event-log').lastElementChild.remove();
}

async function request(path, body) {
  const sequence = ++latestRequest;
  try {
  const { response, data } = await readResponse(path, body === undefined ? { cache: 'no-store' } : {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Board-Client': 'local-simulator' }, body: JSON.stringify(body)
  });
  if (!response.ok && (body === undefined || response.status >= 500)) throw new Error('Local state is unavailable.');
  if (sequence >= renderedRequest && (data.state || (response.ok && body === undefined))) {
    serverAvailable = true;
    renderedRequest = sequence;
    render(data.state || data);
  }
  if (!response.ok && !data.code) throw new Error('The local server could not handle this request.');
  return data;
  } catch (error) {
    // A failed older poll must not hide a newer confirmed state or source cue.
    if (sequence < renderedRequest) return { superseded: true };
    throw error;
  }
}

async function action(path, body = {}) {
  if (pending) return;
  pending = true;
  if (state && serverAvailable) render(state);
  try { const result = await request(path, body); if (!result.superseded) feedback(result); }
  catch { markUnavailable(); $('feedback').textContent = 'Local server unavailable. No event was confirmed. Reconnect before continuing.'; $('feedback').classList.add('error'); }
  finally { pending = false; if (state && serverAvailable) render(state); }
}

$('connect').addEventListener('click', () => action('/api/connection', { status: state?.connection.status === 'connected' ? 'disconnected' : 'connected' }));
$('open').addEventListener('click', () => action('/api/vote/open', { durationMs: 60000 }));
$('close').addEventListener('click', () => action('/api/vote/close'));
$('reset').addEventListener('click', () => { lastEvent = undefined; action('/api/reset'); });
$('command-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (pending) return;
  lastEvent = { id: crypto.randomUUID(), userId: $('viewer').value, text: $('command').value, timestamp: Date.now(), origin: 'simulated' };
  action('/api/simulate', lastEvent);
});
$('replay').addEventListener('click', () => { if (lastEvent) action('/api/simulate', lastEvent); });

async function poll() {
  try { if (!pending) await request('/api/state'); }
  catch { markUnavailable(); }
  setTimeout(poll, 500);
}
poll();
