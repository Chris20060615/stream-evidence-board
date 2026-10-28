const $ = (id) => document.getElementById(id);
let cueTimer;
function text(id, value) { const element = $(id); if (element.textContent !== value) element.textContent = value; }
function clearCue() { clearTimeout(cueTimer); $('cue').hidden = true; text('cue', ''); }
function renderSources(data) {
  const sources = Array.isArray(data.card.sources) ? data.card.sources : [data.card.source];
  for (let index = 0; index < 2; index += 1) {
    const number = index + 1;
    const source = sources[index];
    const panel = $('source-' + number);
    panel.hidden = !source;
    if (!source) continue;
    const link = $(index === 0 ? 'source' : 'source-2-link');
    let url;
    try { url = new URL(source.url); } catch { url = null; }
    if (url?.protocol === 'https:' && !url.username && !url.password) {
      link.href = url.href;
      const label = `${source.publisher} / ${source.title} ↗`;
      if (link.textContent !== label) link.textContent = label;
    } else {
      link.removeAttribute('href');
      link.textContent = 'Source unavailable';
    }
    text('source-' + number + '-note', source.note ?? '');
    const review = data.sourceReviews?.find((item) => item.sourceNumber === number);
    const viewed = review?.status === 'viewed';
    panel.dataset.review = viewed ? 'viewed' : 'pending';
    text('source-' + number + '-review', viewed ? 'Host marked viewed' : 'Pending host review');
  }
}
async function poll() {
  try {
    const response = await fetch('/api/state', { cache: 'no-store', signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error();
    const data = await response.json();
    if (data.mode !== 'twitch-own-channel' || Date.now() - data.sampledAt > 5000) throw new Error();
    const connected = data.realTwitchConnected === true && data.authorizationVerified === true;
    text('status', connected ? `TWITCH CONNECTED · ${data.channelLogin}` : `TWITCH ${String(data.phase).toUpperCase()} · INTAKE PAUSED`);
    text('claim', data.card.claim); text('prompt', data.card.prompt);
    for (const choice of ['a', 'b']) {
      text(choice + '-label', data.card.choices[choice]);
      text(choice + '-count', String(data.vote.counts[choice]));
      $(choice + '-bar').value = data.vote.total ? 100 * data.vote.counts[choice] / data.vote.total : 0;
    }
    text('vote', `${data.vote.total} current votes · ${data.vote.phase === 'open' ? `Open ${Math.max(0, Math.ceil((data.vote.closesAt - Date.now()) / 1000))}s` : data.vote.phase}`);
    renderSources(data);
    clearTimeout(cueTimer);
    if (connected && data.sourceCue.active && data.sourceCue.expiresAt > Date.now()) {
      $('cue').hidden = false; text('cue', 'Twitch source request · choose a source to inspect');
      cueTimer = setTimeout(clearCue, data.sourceCue.expiresAt - Date.now());
    } else clearCue();
  } catch {
    clearCue();
    text('status', 'HOST CONNECTION LOST · DISPLAYED STATE MAY BE STALE');
    text('vote', 'Current state unavailable');
  }
  setTimeout(poll, 500);
}
poll();
