import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

// Actual product-facing aggregate display, not an agent preview workaround.
// No method accepts a chat event, token, simulated vote or connection override.
export function createOverlayServer(host) {
  const assets = new Map([['/', ['live-overlay.html', 'text/html; charset=utf-8']],
    ['/overlay', ['live-overlay.html', 'text/html; charset=utf-8']], ['/live-overlay.mjs', ['live-overlay.mjs', 'text/javascript; charset=utf-8']],
    ['/live-overlay.css', ['live-overlay.css', 'text/css; charset=utf-8']]]);
  return createServer(async (req, res) => {
    const reply = (status, type, body) => { res.writeHead(status, { 'Content-Type': type }); res.end(body); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'none'; frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
    if (req.headers.host !== `127.0.0.1:${req.socket.localPort}`) return reply(403, 'text/plain', 'Invalid host.');
    if (req.method !== 'GET') return reply(405, 'text/plain', 'Read-only overlay. Use the owner terminal to control rounds.');
    let path;
    try { path = new URL(req.url, `http://${req.headers.host}`).pathname; } catch { return reply(400, 'text/plain', 'Invalid request.'); }
    if (path === '/api/state') {
      try { return reply(200, 'application/json; charset=utf-8', JSON.stringify(host.getState())); }
      catch { return reply(503, 'application/json', '{"ok":false,"code":"state_unavailable"}'); }
    }
    const asset = assets.get(path);
    if (!asset) return reply(404, 'text/plain', 'Not found.');
    try { reply(200, asset[1], await readFile(new URL('../public/' + asset[0], import.meta.url))); }
    catch { reply(500, 'text/plain', 'Asset unavailable.'); }
  });
}
