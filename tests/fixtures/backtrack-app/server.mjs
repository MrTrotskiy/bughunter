// Zero-dep fixture for the STATEFUL BACKTRACKING driver (stateful-loop.mjs). Two same-origin pages
// wired so the natural greedy in-session walk MUST backtrack to finish everything:
//   /a  — cA1 (fires GET /api/a1), a nav link to /b, and cA2 (fires POST /api/a2). DOM order is
//         cA1, to-b, cA2, so the greedy driver (lowest-templateId resolvable first) acts cA1, then the
//         /b nav — LEAVING /a with cA2 still unexplored. /a also runs a 100ms background poll
//         (GET /api/poll) that MUST stay uncredited, and /api/a2 is SLOW (~400ms) so the poll
//         DETERMINISTICALLY ticks inside cA2's causal window (adversarial cleanliness AT the backtrack).
//   /b  — cB (fires GET /api/b) and NO link back to /a. So the ONLY way to finish cA2 is the driver's
//         BACKTRACK navigation to /a — NON-VACUOUS: disable backtracking and cA2 is stranded forever.
// The server records the ARRIVAL order of the caused endpoints (a1/a2/b) so the test can prove cA2
// fired AFTER cB (it required returning to /a). No danger-worded controls/routes (Action A1/A2/B, Go
// to B, /a, /b) so the danger-floor never intervenes.

import http from 'node:http';

const A = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Page A</title></head>
<body>
  <h1>Page A</h1>
  <button id="cA1" type="button">Action A1</button>
  <a id="to-b" href="/b">Go to B</a>
  <button id="cA2" type="button">Action A2</button>
  <script>
    // BACKGROUND: a 100ms poll running the whole time; must stay uncredited even when it ticks inside
    // cA2's (slow) causal window on the backtrack visit.
    setInterval(function () { fetch('/api/poll').catch(function () {}); }, 100);
    document.getElementById('cA1').addEventListener('click', function () { fetch('/api/a1').catch(function () {}); });
    // POST + SLOW server-side, so the 100ms poll deterministically ticks inside cA2's causal window.
    document.getElementById('cA2').addEventListener('click', function () { fetch('/api/a2', { method: 'POST' }).catch(function () {}); });
  </script>
</body></html>`;

const B = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Page B</title></head>
<body>
  <h1>Page B</h1>
  <button id="cB" type="button">Action B</button>
  <script>
    document.getElementById('cB').addEventListener('click', function () { fetch('/api/b').catch(function () {}); });
  </script>
</body></html>`;

function sendJson(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

export function start(port = 0) {
  let pollHits = 0;
  const order = []; // arrival order of the caused endpoints (a1/a2/b) — proves the backtrack ordering
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/a' || u.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(A); }
    if (u.pathname === '/b') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); return res.end(B); }
    if (u.pathname === '/api/a1') { order.push('a1'); return sendJson(res, 200, { ok: true }); }
    if (u.pathname === '/api/b') { order.push('b'); return sendJson(res, 200, { ok: true }); }
    // SLOW 200 so the 100ms poll ticks inside cA2's causal window (deterministic depth-at-backtrack).
    if (u.pathname === '/api/a2') { order.push('a2'); return setTimeout(() => sendJson(res, 200, { ok: true }), 400); }
    if (u.pathname === '/api/poll') { pollHits++; return sendJson(res, 200, { t: Date.now() }); }
    return sendJson(res, 404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    server.pollHits = () => pollHits;
    server.order = () => order.slice();
    resolve(server);
  }));
}
