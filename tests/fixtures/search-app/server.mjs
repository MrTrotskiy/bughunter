// Zero-dep single-page fixture that exercises all THREE traffic classes so the
// slice can prove causal attribution:
//   - GET /api/config  fired once on page load        → LOAD-BURST (stay uncredited)
//   - GET /api/ping    fired every 400ms by a poller   → BACKGROUND (stay uncredited)
//   - GET /api/search  fired by clicking #search       → CAUSED (attributed)
// The search results render as <li data-id> rows, each with an Edit button — NEW
// instances of one template revealed by the action.

import http from 'node:http';

const CONFIG = { app: 'search-demo', version: 1, features: ['search'] };

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Search fixture</title></head>
<body>
  <h1>Search demo</h1>
  <p>Type a query and search. Background polling runs the whole time.</p>
  <form id="form" onsubmit="return false">
    <input id="q" name="q" placeholder="query" autocomplete="off" />
    <button id="search" type="button">Search</button>
  </form>
  <ul id="results"></ul>
  <script>
    // LOAD-BURST: fired from a page-load script (cause is '__idle__').
    fetch('/api/config').then(function (r) { return r.json(); }).then(function (c) { window.__config = c; });
    // BACKGROUND: a poll rooted in setInterval — the initiator classifier must
    // reject it even if it ticks inside a control's causal window.
    setInterval(function () { fetch('/api/ping').catch(function () {}); }, 400);
    // CAUSED: only a real click fires this, and it renders new rows.
    document.getElementById('search').addEventListener('click', async function () {
      var q = document.getElementById('q').value;
      var res = await fetch('/api/search?q=' + encodeURIComponent(q));
      var data = await res.json();
      var ul = document.getElementById('results');
      ul.innerHTML = '';
      data.results.forEach(function (item) {
        var li = document.createElement('li');
        li.setAttribute('data-id', String(item.id));
        var span = document.createElement('span');
        span.className = 'title';
        span.textContent = item.title;
        var edit = document.createElement('button');
        edit.className = 'edit';
        edit.type = 'button';
        edit.textContent = 'Edit';
        li.appendChild(span);
        li.appendChild(edit);
        ul.appendChild(li);
      });
    });
  </script>
</body></html>`;

function sendJson(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

function handler(req, res) {
  const u = new URL(req.url, 'http://127.0.0.1');
  if (u.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(PAGE);
  }
  if (u.pathname === '/api/config') return sendJson(res, 200, CONFIG);
  if (u.pathname === '/api/ping') return sendJson(res, 200, { t: Date.now() });
  if (u.pathname === '/api/search') {
    const q = u.searchParams.get('q') || '';
    const results = [1, 2, 3].map((n) => ({ id: n, title: `Result "${q}" #${n}` }));
    return sendJson(res, 200, { q, results });
  }
  return sendJson(res, 404, { error: 'not found' });
}

// Boot on a caller-provided port (0 → ephemeral), bound to loopback. Resolves with
// the listening server so a test can read `.address().port` and `.close()` it.
export function start(port = 0) {
  const server = http.createServer(handler);
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
