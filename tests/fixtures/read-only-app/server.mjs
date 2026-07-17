// Zero-dep fixture for the SESSION-WIDE read-only WRITE-FIREWALL (lib/recon/read-only-firewall.mjs).
// Models the class the firewall must catch WITHOUT breaking reads-over-POST — the live rawcaster failure:
// a control fires a POST mutation on a real authed account, while the app's own content loads over POST too.
// Three click-caused request classes on one page, each with a server-side hit counter (the FAIL-ON-REVERT
// levers — the firewall keeps the mutation counters at 0, the read counter above 0):
//   W  #w-toggle   name "Toggle" (a benign / icon-style name the danger-floor name-gate MISSES) fires
//                  POST /api/followandunfollow — an OBVIOUS mutation by ENDPOINT PATH. The network firewall
//                  must ABORT it (writeHits stays 0) YET the causal control→endpoint edge must still record.
//   R  #r-load     "Load list" fires POST /api/listthings — a READ over POST (the rawcaster listnuggets
//                  class). The firewall must ALLOW it (readHits++) or content never loads.
//   F  #f-follow   "Follow" (a mutation-NAMED control) fires POST /api/x123 — a BENIGN-named endpoint the
//                  URL-path gate CANNOT see. Under ABORT-BY-DEFAULT the network gate now ABORTS it too (the
//                  residual is CLOSED by default, xHits stays 0); the operator override (--allow-benign-post)
//                  restores the continue (xHits++). The NAME gate (mutationFloor, opt-in refuseMutations)
//                  refuses it at CLICK time regardless.
//   D  #d-dostuff  "Process" (a benign name the name-gate MISSES) fires POST /api/dostuff — a benign-named
//                  non-GET with NO write verb in its path. It proves the INVERSION: with an EMPTY allowlist
//                  the network gate ABORTS it by DEFAULT (dostuffHits stays 0) YET the causal edge records;
//                  once the AGENT allowlists POST /api/dostuff as a read, the SAME act CONTINUES (dostuffHits++,
//                  returns content). This is the endpoint that reaches a live server ONLY under the OLD default.
// A load-time GET /api/init makes the probe's `total` > 0 so waitSettled settles fast (no 3s stall).

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Read-only firewall fixture</title></head>
<body>
  <h1>Read-only firewall demo</h1>
  <button id="w-toggle" type="button">Toggle</button>
  <button id="r-load" type="button">Load list</button>
  <button id="f-follow" type="button">Follow</button>
  <button id="d-dostuff" type="button">Process</button>
  <div id="list-root"></div>
  <script>
    // Load-time read so the probe registers network activity (total > 0 → fast settle).
    fetch('/api/init').catch(function () {});
    // W: a benign-NAMED control firing an OBVIOUS mutation ENDPOINT — the icon/name-floor-miss incident.
    document.getElementById('w-toggle').addEventListener('click', function () {
      fetch('/api/followandunfollow', { method: 'POST' }).catch(function () {}); // network firewall must ABORT
    });
    // R: a READ over POST — the app's content load. The firewall must ALLOW it.
    document.getElementById('r-load').addEventListener('click', function () {
      fetch('/api/listthings', { method: 'POST' })
        .then(function () { document.getElementById('list-root').innerHTML = '<span id="loaded">loaded</span>'; })
        .catch(function () {});
    });
    // F: a mutation-NAMED control firing a BENIGN-named endpoint the URL-path gate cannot see (the residual).
    document.getElementById('f-follow').addEventListener('click', function () {
      fetch('/api/x123', { method: 'POST' }).catch(function () {});
    });
    // D: a BENIGN-named control firing a benign-named non-GET (no write verb in the path). Aborted by
    // DEFAULT under the inverted firewall; continued once the AGENT allowlists it as a read.
    document.getElementById('d-dostuff').addEventListener('click', function () {
      fetch('/api/dostuff', { method: 'POST' })
        .then(function () { document.getElementById('list-root').innerHTML = '<span id="processed">processed</span>'; })
        .catch(function () {});
    });
  </script>
</body></html>`;

function sendJson(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

export function start(port = 0) {
  let initHits = 0;
  let writeHits = 0;
  let readHits = 0;
  let xHits = 0;
  let dostuffHits = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }
    if (u.pathname === '/api/init') { initHits++; return sendJson(res, 200, { ok: true }); }
    // The MUTATION endpoint. A hit means a read-only crawl committed a follow/unfollow — the exact live
    // failure. The firewall's write-verb gate must keep this at 0.
    if (u.pathname === '/api/followandunfollow' && req.method === 'POST') { writeHits++; return sendJson(res, 200, { toggled: true }); }
    // A READ over POST (content load). It MUST reach the server, or the app never renders.
    if (u.pathname === '/api/listthings' && req.method === 'POST') { readHits++; return sendJson(res, 200, { items: [1, 2, 3] }); }
    // A benign-named write. Under abort-by-default the URL-path gate ABORTS it (residual closed); the operator
    // override or the NAME gate govern it. A hit means it reached the server (only under --allow-benign-post).
    if (u.pathname === '/api/x123' && req.method === 'POST') { xHits++; return sendJson(res, 200, { written: true }); }
    // A benign-named non-GET the write-verb gate cannot see. Aborted by DEFAULT (empty allowlist); a hit means
    // the agent allowlisted it as a read (content then loads). The FAIL-ON-REVERT lever for the inversion.
    if (u.pathname === '/api/dostuff' && req.method === 'POST') { dostuffHits++; return sendJson(res, 200, { items: [1, 2] }); }
    return sendJson(res, 404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    server.initHits = () => initHits;
    server.writeHits = () => writeHits;
    server.readHits = () => readHits;
    server.xHits = () => xHits;
    server.dostuffHits = () => dostuffHits;
    resolve(server);
  }));
}
