// Zero-dep fixture for the Layer-3 replay-time WRITE-FIREWALL (docs/PHASE1-COLLECTION-PLAN.md §Layer 3).
// Models the class the firewall must catch: a reveal-path OPENER that, when re-clicked during replay,
// fires a non-GET the record-time act never recorded (an adaptive swap / an extra analytics-beacon
// mutation). On an authed crawl that write would hit the LIVE account — replay is supposed to be
// side-effect-free. It exercises the THREE request classes the firewall classifies on ONE opener click:
//   - GET  /api/safe   a SAFE method → the firewall must ALWAYS continue it (safeHits++).
//   - POST /api/list   a judged-READ POST — when it is the opener's RECORDED trigger it is allowlisted,
//                      so the firewall must continue it (the intended reach; listHits++).
//   - POST /api/track  a MUTATION (write) that is NOT among the opener's recorded triggers → the
//                      firewall must ABORT it, keeping trackHits at 0 (the live account unmutated).
//
// Openers so a test can assert each guarantee cleanly:
//   - #open-danger fires all THREE (safe + list + track), revealing #child-danger. Replaying it must
//     abort /api/track (REVEAL_WRITE_BLOCKED) yet still let /api/safe + /api/list through.
//   - #open-safe  fires only the two ALLOWED ones (safe + list), revealing #child-safe. Replaying it
//     must COMPLETE without a throw and reveal its child — proof the firewall does not break reach.
//   - #open-h1    fires POST /api/item?_method=DELETE — a query-SMUGGLED write whose pathname collides
//     with the allowlisted read POST /api/item; only FULL-url canonicalization tells them apart (H1).
//   - #open-logout fires fetch('/logout') — a SAFE GET that would END the authed session; the danger-
//     route guard must abort it even though GET is "safe" (M2).
//   - #open-delete fires DELETE /api/item — a non-idempotent verb the graph recorded but which is
//     NEVER allowlisted (only read-over-POST is, L2).
//   - #open-offorigin fires a benign OFF-ORIGIN SAFE GET (a CDN image, to the ?off=<origin> second
//     server), revealing #child-offorigin. The firewall must ABORT the cross-origin GET (offHits stays
//     0) YET the reveal must COMPLETE — a safe-method off-origin sub-resource is a SOFT block that does
//     not fail reach (failing on it broke stay-on-page reach on every real app with off-origin assets).
//
// FAIL-ON-REVERT levers (server-side counters, kept at 0 by the firewall): trackHits (remove the
// firewall install → POST /api/track passes), itemWriteHits (revert H1 to pathname-only canon → the
// smuggled DELETE passes; revert L2 to allowlist-every-non-GET → the hard DELETE passes), logoutHits
// (revert M2 to unconditional safe-method continue → GET /logout passes), offHits (drop the off-origin
// abort → the cross-origin GET reaches the second server). The SOFT-block reach guard (a safe-method
// off-origin sub-resource does NOT fail the reveal) reverts by re-hardening every block → #open-offorigin
// throws REVEAL_WRITE_BLOCKED and #child-offorigin is absent.

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Write-firewall fixture</title></head>
<body>
  <h1>Replay write-firewall demo</h1>
  <button id="open-danger" type="button">Open danger list</button>
  <button id="open-safe" type="button">Open safe list</button>
  <button id="open-h1" type="button">Open (H1 query-smuggle)</button>
  <button id="open-logout" type="button">Open (logout side-effect)</button>
  <button id="open-delete" type="button">Open (hard delete)</button>
  <button id="open-offorigin" type="button">Open (off-origin asset)</button>
  <div id="root-danger"></div>
  <div id="root-safe"></div>
  <div id="root-h1"></div>
  <div id="root-logout"></div>
  <div id="root-delete"></div>
  <div id="root-offorigin"></div>
  <script>
    // #open-danger: a POST-nav opener whose REPLAY click fires an EXTRA write (/api/track) alongside
    // its allowlisted read (/api/list) and a safe GET. Reveals #child-danger (stay-on-page, no nav).
    document.getElementById('open-danger').addEventListener('click', function () {
      var root = document.getElementById('root-danger');
      if (root.childElementCount) return; // idempotent — replaying the click twice is a no-op
      fetch('/api/safe').catch(function () {});
      fetch('/api/list', { method: 'POST' }).catch(function () {});
      fetch('/api/track', { method: 'POST' }).catch(function () {}); // the write the firewall must abort
      root.innerHTML = '<div class="modal"><button id="child-danger" type="button">Expand</button></div>';
    });
    // #open-safe: the same shape MINUS the write — only the safe GET + the allowlisted read. Replaying
    // it must complete and reveal #child-safe, proving the firewall passes legitimate reach untouched.
    document.getElementById('open-safe').addEventListener('click', function () {
      var root = document.getElementById('root-safe');
      if (root.childElementCount) return; // idempotent
      fetch('/api/safe').catch(function () {});
      fetch('/api/list', { method: 'POST' }).catch(function () {});
      root.innerHTML = '<div class="modal"><button id="child-safe" type="button">Expand</button></div>';
    });
    // #open-h1: replay fires a QUERY-SMUGGLED write — POST /api/item?_method=DELETE — whose PATHNAME
    // (/api/item) collides with the allowlisted read POST /api/item. Only FULL-url canon (H1) keeps them
    // apart, so the DELETE is aborted. Reveals #child-h1.
    document.getElementById('open-h1').addEventListener('click', function () {
      var root = document.getElementById('root-h1');
      if (root.childElementCount) return;
      fetch('/api/item?_method=DELETE', { method: 'POST' }).catch(function () {});
      root.innerHTML = '<div class="modal"><button id="child-h1" type="button">Expand</button></div>';
    });
    // #open-logout: replay fires fetch('/logout') — a SAFE GET that would END the authed session. The
    // danger-route guard must abort it even though GET is "safe" (M2). Reveals #child-logout.
    document.getElementById('open-logout').addEventListener('click', function () {
      var root = document.getElementById('root-logout');
      if (root.childElementCount) return;
      fetch('/logout').catch(function () {});
      root.innerHTML = '<div class="modal"><button id="child-logout" type="button">Expand</button></div>';
    });
    // #open-delete: replay fires DELETE /api/item — a non-idempotent verb the graph recorded but which
    // is NEVER allowlisted (only read-over-POST is, L2). The firewall must abort it. Reveals #child-delete.
    document.getElementById('open-delete').addEventListener('click', function () {
      var root = document.getElementById('root-delete');
      if (root.childElementCount) return;
      fetch('/api/item', { method: 'DELETE' }).catch(function () {});
      root.innerHTML = '<div class="modal"><button id="child-delete" type="button">Expand</button></div>';
    });
    // #open-offorigin: replay fires a benign OFF-ORIGIN SAFE GET (a CDN image the revealed UI pulls in),
    // to the second-server origin passed as ?off=<origin>. The firewall must ABORT it (leak prevented,
    // offHits stays 0) YET the reveal must COMPLETE and reveal #child-offorigin — a safe-method off-origin
    // sub-resource is a SOFT block that does not fail reach. Reveals #child-offorigin.
    document.getElementById('open-offorigin').addEventListener('click', function () {
      var root = document.getElementById('root-offorigin');
      if (root.childElementCount) return;
      var off = new URLSearchParams(location.search).get('off');
      if (off) { fetch(off + '/offasset').catch(function () {}); } // benign off-origin CDN asset GET
      root.innerHTML = '<div class="modal"><button id="child-offorigin" type="button">Expand</button></div>';
    });
  </script>
</body></html>`;

function sendJson(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

export function start(port = 0) {
  let safeHits = 0;
  let listHits = 0;
  let trackHits = 0;
  let logoutHits = 0;
  let itemWriteHits = 0;
  let offHits = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }
    if (u.pathname === '/api/safe') { safeHits++; return sendJson(res, 200, { ok: true }); }
    if (u.pathname === '/api/list' && req.method === 'POST') { listHits++; return sendJson(res, 200, { items: [1, 2, 3] }); }
    // The MUTATION endpoint. A hit here means a replay-time write reached the live account — the exact
    // failure the firewall prevents. The firewall must keep this counter at 0.
    if (u.pathname === '/api/track' && req.method === 'POST') { trackHits++; return sendJson(res, 200, { tracked: true }); }
    // A self-logout GET the danger-route guard must abort (M2) even though GET is a safe method.
    if (u.pathname === '/logout') { logoutHits++; return sendJson(res, 200, { loggedOut: true }); }
    // /api/item WRITE surface: the H1 query-smuggle (POST + ?_method) and the L2 hard DELETE both land
    // here. A hit means a replay-time write reached the live account — the firewall must keep this at 0.
    if (u.pathname === '/api/item' && (req.method === 'DELETE' || (req.method === 'POST' && u.searchParams.has('_method')))) {
      itemWriteHits++; return sendJson(res, 200, { written: true });
    }
    // The OFF-ORIGIN asset (a benign CDN image the revealed UI pulls in). A hit here means the firewall
    // let a cross-origin SAFE GET through — it must ABORT it (leak prevented) while NOT failing the reveal.
    if (u.pathname === '/offasset') { offHits++; return sendJson(res, 200, { asset: true }); }
    return sendJson(res, 404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    server.safeHits = () => safeHits;
    server.listHits = () => listHits;
    server.trackHits = () => trackHits;
    server.logoutHits = () => logoutHits;
    server.itemWriteHits = () => itemWriteHits;
    server.offHits = () => offHits;
    resolve(server);
  }));
}
