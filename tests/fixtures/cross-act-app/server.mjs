// Zero-dep fixture whose whole point is an OVERLAPPING path: /api/shared is BOTH
// click-caused (button #a) AND background-polled (a setInterval). This is the shape the
// search-app fixture cannot model (there /api/search is only clicked, /api/ping only
// polled), and it is exactly what exposes cross-act initiator-verdict accumulation on a
// reused page: after an act clicks #a, /api/shared is "seen foreground"; a later act on a
// DIFFERENT control must not have the background /api/shared poll (ticking inside its
// window) mis-attributed to it just because #a made that path foreground earlier.
//   - #a click        → GET /api/shared   (foreground / caused)
//   - #b click        → GET /api/other    (foreground / caused; responds SLOWLY, ~600ms,
//                       so #b's causal window stays open past a 250ms poll — the shared
//                       poll DETERMINISTICALLY ticks inside it)
//   - setInterval     → GET /api/shared   (background, every 250ms)

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Cross-act fixture</title></head>
<body>
  <h1>Cross-act demo</h1>
  <button id="a" type="button">Load shared</button>
  <button id="b" type="button">Load other</button>
  <script>
    // BACKGROUND poll on the SHARED path — must never be credited to a click.
    setInterval(function () { fetch('/api/shared').catch(function () {}); }, 250);
    document.getElementById('a').addEventListener('click', function () { fetch('/api/shared').catch(function () {}); });
    document.getElementById('b').addEventListener('click', function () { fetch('/api/other').catch(function () {}); });
  </script>
</body></html>`;

function sendJson(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

export function start(port = 0) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }
    if (u.pathname === '/api/shared') return sendJson(res, 200, { ok: true });
    // #b's request responds slowly, holding its causal window open so the background
    // /api/shared poll is guaranteed to tick inside it (deterministic cross-act race).
    if (u.pathname === '/api/other') return setTimeout(() => sendJson(res, 200, { ok: true }), 600);
    return sendJson(res, 404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
