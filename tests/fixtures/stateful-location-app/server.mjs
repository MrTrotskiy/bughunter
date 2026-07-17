// Zero-dep fixture for STATEFUL LOCATION-HONESTY provenance (stateful-step.mjs reveal.statePath
// stamping, Blocker-4). A CONSTANT-URL app (every reveal is an in-page DOM injection, the URL never
// changes) with a 2-DEEP reveal chain so the accumulated provenance breadcrumb is exercised at depth:
//   - GET  /api/init    one fetch on page load                       → LOAD BURST (under __idle__,
//                       excluded by the token — the honest load-time class).
//   - GET  /api/poll    a 150ms setInterval running the WHOLE time   → BACKGROUND (uncredited),
//                       must stay uncredited across the whole crawl.
//   - #open-outer (A)   a baseline button. Fires a read-over-POST /api/outer (NON-GET on purpose:
//                       it makes actStep's allGet=false, so the reveal stamp depends on the
//                       statefulProvenance widen — the method-agnostic gate under test — not on the
//                       vacuous GET-only default). Reveals panel-1 containing #open-inner.
//   - #open-inner (B)   a control REVEALED by A (not in the initial DOM). Fires read-over-POST
//                       /api/inner (same reason). Reveals panel-2 containing #leaf.
//   - #leaf (X)         a control REVEALED by B (2 hops deep). Fires GET /api/info — the terminal
//                       read whose causal edge is asserted (wire-before-DOM).
//
// The panels are injected on click (never present at load), so B is reachable only after A and X only
// after B: an in-session accumulate-state walk reaches all three, stamping X.reveal.statePath = [A, B]
// (length 2) and B.reveal.statePath = [A] (length 1) — three DISTINCT locationKeys on ONE URL. Control
// names are benign reads ("Open …"/"Show info"): a --stateful crawl is read-only, so a write-verb name
// would be refused at click time (mutationFloor) — this fixture isolates the provenance mechanism.

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Stateful location fixture</title></head>
<body>
  <h1>Stateful location-honesty demo</h1>
  <button id="open-outer" type="button">Open outer</button>
  <div id="panel-1"></div>
  <script>
    // LOAD BURST + BACKGROUND poll — the honest traffic classes (excluded / uncredited).
    fetch('/api/init').catch(function () {});
    setInterval(function () { fetch('/api/poll').catch(function () {}); }, 150);

    // A: read-over-POST + reveal panel-1 (which holds B). NON-GET so the reveal stamp exercises the
    // method-agnostic statefulProvenance widen, not the vacuous all-GET default.
    document.getElementById('open-outer').addEventListener('click', function () {
      fetch('/api/outer', { method: 'POST' }).catch(function () {});
      var p1 = document.getElementById('panel-1');
      if (p1.childElementCount) return; // idempotent
      p1.innerHTML = '<div class="panel"><button id="open-inner" type="button">Open inner</button><div id="panel-2"></div></div>';

      // B: read-over-POST + reveal panel-2 (which holds X). Wired when panel-1 mounts.
      document.getElementById('open-inner').addEventListener('click', function () {
        fetch('/api/inner', { method: 'POST' }).catch(function () {});
        var p2 = document.getElementById('panel-2');
        if (p2.childElementCount) return; // idempotent
        p2.innerHTML = '<div class="panel"><button id="leaf" type="button">Show info</button></div>';

        // X: the terminal read (GET), 2 hops deep.
        document.getElementById('leaf').addEventListener('click', function () {
          fetch('/api/info').catch(function () {});
        });
      });
    });
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
    if (u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }
    if (u.pathname === '/api/init') return sendJson(res, 200, { ready: true });
    if (u.pathname === '/api/poll') { pollHits++; return sendJson(res, 200, { t: Date.now() }); }
    if (u.pathname === '/api/outer') return sendJson(res, 200, { opened: 'outer' });
    if (u.pathname === '/api/inner') return sendJson(res, 200, { opened: 'inner' });
    if (u.pathname === '/api/info') return sendJson(res, 200, { info: true });
    return sendJson(res, 404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    server.pollHits = () => pollHits;
    resolve(server);
  }));
}
