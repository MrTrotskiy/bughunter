// Zero-dep fixture for role-less "div-soup" capture (dom-snapshot.mjs). Models the modern-React
// reality the ARIA/SEL pass misses: click handlers bound via addEventListener to <div>/<span> with
// NO role/tag and NO href. The durable capture signal is computed `cursor: pointer`.
//
// Exercises every gate of the role-less pass:
//   - `.conn` — a NAMED cursor:pointer div (a connection row "Ace"), addEventListener click fires
//     GET /profile?u=Ace. MUST be captured (role-less) AND its request causally attributed.
//   - `.icon-nameless` — a cursor:pointer div with NO text/aria (a bare icon). MUST be SKIPPED
//     (unnamed → the name-based danger-floor cannot judge it → never blind-clicked; honest under-capture).
//   - `.wrap` — a cursor:pointer div WRAPPING a real <button>. The wrapper MUST be SKIPPED (it
//     contains a SEL control — the button is the handle); the <button> is captured by the SEL pass.
//   - `.card` — a cursor:pointer container whose inner `.card-icon` <span> inherits pointer. Only the
//     OUTERMOST (.card, named "Open card") is captured; the inner span is dropped (pointer ancestor).
//   - A 200ms background GET /api/poll throughout — the causal-survival guard (never attributed to
//     the div act).
// Everything is a plain in-page listener + fetch, no framework, so the fixture is the source of truth.

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Div-soup fixture</title>
<style>.p{cursor:pointer}</style></head>
<body>
  <h1>Div-soup</h1>
  <div class="conn p" data-u="Ace">Ace</div>
  <div class="icon-nameless p"></div>
  <div class="wrap p"><button type="button" class="real">Real Button</button></div>
  <div class="card p" aria-label="Open card">Card<span class="card-icon p">i</span></div>
  <script>
    setInterval(function () { fetch('/api/poll').catch(function () {}); }, 200);
    for (var c of document.querySelectorAll('.conn')) {
      c.addEventListener('click', function (e) {
        fetch('/profile?u=' + e.currentTarget.getAttribute('data-u')).catch(function () {});
      });
    }
    document.querySelector('.real').addEventListener('click', function () { fetch('/real-click').catch(function(){}); });
    document.querySelector('.card').addEventListener('click', function () { fetch('/card-open').catch(function(){}); });
  </script>
</body></html>`;

function sendJson(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

export function start(port = 0) {
  let pollHits = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/' || u.pathname === '/app') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }
    if (u.pathname === '/api/poll') { pollHits++; return sendJson(res, 200, { t: 1 }); }
    if (u.pathname === '/profile') return sendJson(res, 200, { user: u.searchParams.get('u') });
    if (u.pathname === '/real-click') return sendJson(res, 200, { ok: 1 });
    if (u.pathname === '/card-open') return sendJson(res, 200, { ok: 1 });
    return sendJson(res, 404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    server.pollHits = () => pollHits;
    resolve(server);
  }));
}
