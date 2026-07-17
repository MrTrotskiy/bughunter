// Zero-dep fixture for the click-time DANGER-ROUTE href gate (security H1). Models the exact hole the
// name-floor cannot see: an ICON-ONLY anchor with NO accessible name pointing at a same-origin danger
// route. As a plain GET link, a click would NAVIGATE the browser to /logout and end an authed session —
// the name gate never sees the destination, only the (empty) name. The page wires:
//   - <a id="logout-link" href="/logout"> whose ONLY child is an inline SVG (no text / aria-label / title)
//     → empty accessible name, so dangerFloor({name:'',route:'/'}) is 'unknown' (NOT refused by name).
//     actStep's new routeKey(href)-based gate must refuse it (DANGER_FLOOR) BEFORE the click.
//   - a benign "Search" button so the page has a second, safe control (and non-trivial content to settle).
// The server counts GET /logout hits: a hit means the gate FAILED (the click navigated). The gate must
// keep logoutHits at 0. A load-time GET /api/init gives the probe network activity for a fast settle.

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Logout-link fixture</title></head>
<body>
  <h1>Icon-only danger link demo</h1>
  <button id="search" type="button">Search</button>
  <a id="logout-link" href="/logout"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 2h12v12H2z"/></svg></a>
  <script>
    // Load-time read so the probe registers network activity (total > 0 → fast settle).
    fetch('/api/init').catch(function () {});
    // A benign same-origin control (fires no request); present only so the page is non-trivial.
    document.getElementById('search').addEventListener('click', function () {});
  </script>
</body></html>`;

function sendJson(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

// Boot on a caller-provided port (0 → ephemeral), bound to loopback. Resolves with the listening server;
// it carries a `logoutHits()` accessor — the count of GET /logout navigations (must stay 0 if the gate works).
export function start(port = 0) {
  let initHits = 0;
  let logoutHits = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }
    if (u.pathname === '/api/init') { initHits++; return sendJson(res, 200, { ok: true }); }
    // A hit means a recon click navigated here — the danger-route gate failed. The gate must keep this 0.
    if (u.pathname === '/logout') {
      logoutHits++;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><html><body><h1>Logged out</h1></body></html>');
    }
    return sendJson(res, 404, { error: 'not found' });
  });
  server.initHits = () => initHits;
  server.logoutHits = () => logoutHits;
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
