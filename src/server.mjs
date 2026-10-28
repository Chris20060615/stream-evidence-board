import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createBoard } from './engine.mjs';
import { demoCard } from './card.mjs';

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/overlay', ['overlay.html', 'text/html; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/overlay.mjs', ['overlay.mjs', 'text/javascript; charset=utf-8']]
]);

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 4096) throw Object.assign(new Error('Request is too large.'), { status: 413 });
    chunks.push(chunk);
  }
  try {
    const data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw Object.assign(new Error('Send a JSON object.'), { status: 400 });
  }
}

export function createApp({ board = createBoard({ card: demoCard }) } = {}) {
  return createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const port = req.socket.localPort;
    const host = req.headers.host;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(host)) return json(res, 403, { ok: false, code: 'invalid_host' });
    try {
      const url = new URL(req.url, `http://${host}`);
      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, board.getState());
      if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
        // Custom header + JSON + same-origin checking blocks drive-by browser writes.
        const origin = req.headers.origin;
        if (origin && origin !== `http://${host}`) return json(res, 403, { ok: false, code: 'invalid_origin' });
        if (req.headers['x-board-client'] !== 'local-simulator') return json(res, 403, { ok: false, code: 'missing_client_header' });
        if (req.headers['content-type']?.split(';')[0].trim() !== 'application/json') return json(res, 415, { ok: false, code: 'json_required' });
        const data = await readJson(req);
        let result;
        switch (url.pathname) {
          case '/api/vote/open': result = board.openVote(data.durationMs); break;
          case '/api/vote/close': result = board.closeVote(); break;
          case '/api/connection': result = board.setConnection(data.status); break;
          case '/api/reset': result = board.reset(); break;
          case '/api/simulate':
            if (data.origin && data.origin !== 'simulated') return json(res, 400, { ok: false, code: 'unsupported_origin', message: 'The Twitch adapter is not implemented.' });
            result = board.processEvent({ id: data.id, userId: data.userId, text: data.text, timestamp: data.timestamp, origin: 'simulated' });
            break;
          default: return json(res, 404, { ok: false, code: 'not_found' });
        }
        return json(res, result?.ok === false ? 400 : 200, { ...result, state: board.getState() });
      }
      if (req.method !== 'GET') return json(res, 405, { ok: false, code: 'method_not_allowed' });
      const asset = assets.get(url.pathname);
      if (!asset) return json(res, 404, { ok: false, code: 'not_found' });
      const contents = await readFile(resolve(publicDir, asset[0]));
      res.writeHead(200, { 'Content-Type': asset[1] });
      res.end(contents);
    } catch (error) {
      json(res, error.status ?? 500, { ok: false, code: error.status ? 'bad_request' : 'internal_error', message: error.status ? error.message : 'Local server error.' });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 4173);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('PORT must be an integer between 1024 and 65535.');
  const server = createApp();
  server.on('error', (error) => { console.error(`Local server failed: ${error.code ?? error.message}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => {
    console.log(`SIMULATION ONLY — Twitch is not connected.\nController: http://127.0.0.1:${port}\nOverlay: http://127.0.0.1:${port}/overlay\nState is in memory; restart clears votes.`);
  });
}
