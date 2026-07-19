// Zero-dep fixture for the STATE MODEL / per-instance opener DFS (decisions.md 2026-07-15
// "whole-site reach"). Models a CONSTANT-URL SPA the depth-1 slice could not crawl — the exact
// first-target failure classes:
//   - Constant URL (`/app`): every nav is an in-page state swap, the URL never changes.
//   - Nav = 3 buttons that are INSTANCES OF ONE TEMPLATE (`button.nav`, distinct nth-child; names
//     Alpha/Beta/Gamma). Each swaps #content client-side to reveal a DISTINCT interactive control
//     (reason 2: instance-not-template — a per-instance opener must walk Beta/Gamma, not just Alpha,
//     because the template-level frontier stops at instance[0]). The clicked nav gets aria-selected.
//   - Alpha (GET /a) and Beta (GET /b) each reveal a DISTINCT INSTANCE (data-id a/b) of ONE act
//     template — a NEW INSTANCE of an existing template getting its OWN reveal path is the exact
//     instance-not-template gap the template-level stamp missed. Gamma reveals a genuinely-NEW
//     template ("Create") that opens a MODAL (depth-2) with a field + Save, reachable only by the
//     reveal-path chain Gamma -> Create (reason 4). (POST-read openers are covered by modal-app.)
//   - A background GET /api/poll setInterval runs throughout — the causal-survival guard AT DEPTH-2.
//   - Gamma also reveals "Choose", a MUTATION opener (POST /choose) whose revealed control must stay
//     honestly `unreachable` (never replayed) — the first target's "choose your community" residual.
// Revealed markup is injected on click (never in the baseline DOM), so revealed controls are
// reachable ONLY by replaying the reveal path. `act` controls carry a data-id so Alpha's and Beta's
// are DISTINCT instances of one template (the instance-level reveal stamp), not one merged slot.

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>State fixture</title></head>
<body>
  <h1>Constant-URL state demo</h1>
  <nav>
    <button class="nav" data-k="alpha" type="button">Alpha</button>
    <button class="nav" data-k="beta" type="button">Beta</button>
    <button class="nav" data-k="gamma" type="button">Gamma</button>
  </nav>
  <div id="content"></div>
  <script>
    setInterval(function () { fetch('/api/poll').catch(function () {}); }, 200);
    var content = document.getElementById('content');
    function setActive(btn) {
      for (var b of document.querySelectorAll('.nav')) b.removeAttribute('aria-selected');
      btn.setAttribute('aria-selected', 'true');
    }
    for (var btn of document.querySelectorAll('.nav')) {
      btn.addEventListener('click', function (e) {
        var k = e.currentTarget.getAttribute('data-k');
        setActive(e.currentTarget);
        if (k === 'alpha') {
          fetch('/a').catch(function () {});
          content.innerHTML = '<button class="act" data-id="a" type="button">Alpha detail</button>';
        } else if (k === 'beta') {
          fetch('/b').catch(function () {}); // GET opener: reveals a NEW INSTANCE of the act template
          content.innerHTML = '<button class="act" data-id="b" type="button">Beta detail</button>';
        } else if (k === 'gamma') {
          fetch('/g').catch(function () {});
          content.innerHTML = '<button class="create" type="button">Create</button>'
            + '<button class="choose" type="button">Choose</button>';
          document.querySelector('.create').addEventListener('click', function () {
            content.insertAdjacentHTML('beforeend',
              '<div class="modal"><input class="field" aria-label="Title"><button class="save" type="button">Save</button></div>');
            document.querySelector('.save').addEventListener('click', function () { fetch('/save').catch(function () {}); });
          });
          document.querySelector('.choose').addEventListener('click', function () {
            fetch('/choose', { method: 'POST' }).catch(function () {}); // MUTATION
            content.insertAdjacentHTML('beforeend', '<button class="chosen" type="button">Chosen</button>');
          });
        }
      });
    }
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
    if (u.pathname === '/a') return sendJson(res, 200, { card: 'alpha' });
    if (u.pathname === '/b') return sendJson(res, 200, { card: 'beta' });
    if (u.pathname === '/g') return sendJson(res, 200, { card: 'gamma' });
    if (u.pathname === '/save') return sendJson(res, 200, { saved: true });
    if (u.pathname === '/choose' && req.method === 'POST') return sendJson(res, 200, { chosen: true });   // MUTATION
    return sendJson(res, 404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    server.pollHits = () => pollHits;
    resolve(server);
  }));
}
