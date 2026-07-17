// Zero-dep fixture for the STATEFUL in-session recon walk (stateful-step.mjs). It models the
// real traffic classes PLUS a depth-1 reveal that ONLY an in-session (no re-navigation) walk
// reaches — the whole point of stateful mode. The cold path (persistentStep) would close the
// modal between acts; only an accumulate-state loop leaves it open and thus studies #save.
//   - GET /api/init   one fetch on page load                        → LOAD BURST (fires under
//                     __idle__, excluded by the token — the honest load-time class).
//   - GET /api/poll   a 150ms setInterval running the WHOLE time    → BACKGROUND (uncredited).
//                     It must stay uncredited even when it ticks inside #save's causal window.
//   - #open           a button that, via JS with NO navigation (same URL), REVEALS a panel whose
//                     #save control is NOT in the initial DOM (genuinely stay-in-session-only).
//   - panel #save     fires GET /api/save, deliberately SLOW (~600ms) so the 150ms poll
//                     DETERMINISTICALLY ticks inside its causal window (invariant stressed at
//                     depth-1). This is the control the stateful loop reaches with NO reveal-replay.
//   - #note           a plain text input inside the panel (fires nothing) — a second panel control.
//
// The panel markup is injected on the #open click (never present at load), so #save is unreachable
// unless the walk STAYS on the page (state accumulates). A poll hit-counter (pollHits) lets the
// test prove the poll was live (non-vacuous). The panel control is NAMED a benign read ("Details",
// not a write-verb like "Save"): a --stateful crawl is read-only, so its NAME-level mutation gate
// (danger-floor mutationFloor, refuseMutations) refuses a write-verb-named control at click time —
// this fixture isolates the depth-1 REACH mechanism from that gate. No danger-worded controls either.

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Stateful fixture</title></head>
<body>
  <h1>Stateful in-session demo</h1>
  <button id="open" type="button">Open panel</button>
  <div id="panel-root"></div>
  <script>
    // LOAD BURST: one fetch at load, under __idle__ — excluded by the token, never credited.
    fetch('/api/init').catch(function () {});
    // BACKGROUND: a setInterval-rooted poll running the whole time. The initiator classifier must
    // reject it even when it ticks inside #save's (slow) causal window.
    setInterval(function () { fetch('/api/poll').catch(function () {}); }, 150);
    // #open REVEALS the panel by injecting markup NOT in the initial DOM. Same URL, no navigation —
    // #save is reachable ONLY if the walk stays in-session (the stateful loop keeps the panel open).
    document.getElementById('open').addEventListener('click', function () {
      var root = document.getElementById('panel-root');
      if (root.childElementCount) return; // idempotent — re-opening is a no-op
      root.innerHTML =
        '<div class="panel">' +
        '<input id="note" type="text" aria-label="Note">' +
        '<button id="save" type="button">Details</button>' +
        '</div>';
      // #save fires a SLOW GET so the 150ms poll ticks inside its causal window (deterministic depth-1).
      document.getElementById('save').addEventListener('click', function () {
        fetch('/api/save').catch(function () {});
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
    // Slow 200 so the 150ms poll ticks inside #save's causal window (deterministic depth-1).
    if (u.pathname === '/api/save') return setTimeout(() => sendJson(res, 200, { saved: true }), 600);
    return sendJson(res, 404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    server.pollHits = () => pollHits;
    resolve(server);
  }));
}
