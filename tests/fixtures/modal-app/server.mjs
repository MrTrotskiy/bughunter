// Zero-dep fixture for GAP 2 STAY-ON-PAGE reach (a control reachable ONLY by an in-page
// action). It models the real traffic classes plus the depth-1 reveal the replay test needs:
//   - GET /api/poll   a 200ms setInterval running the WHOLE time                → BACKGROUND
//                     (uncredited). It must stay uncredited even when it ticks inside a
//                     depth-1 modal act's window — the "causal survival at depth" guard.
//   - #baseline       a button on the initial page that fires NOTHING (a control that opens
//                     no state and causes no request — the honest contrast).
//   - #open           a button that, via JS with NO navigation (same URL), REVEALS a modal
//                     whose controls are NOT in the initial DOM (genuinely stay-on-page-only).
//   - modal #save     fires GET /api/modal-save, deliberately SLOW (~600ms) so the 200ms poll
//                     DETERMINISTICALLY ticks inside its causal window (the invariant is
//                     stressed at depth-1). This is the control the replay prologue must reach.
//   - modal #note     a plain text input (fillable, fires nothing) — a second modal control.
//   - modal #dismiss  closes the modal (fires nothing) — a third modal control.
//   - #open-post      a MUTATING opener: fires POST /api/mutate (a non-navigating mutation) and
//                     THEN reveals #save2. Because the revealing act is not all-GET, the GET-only
//                     replayability gate must NOT stamp #save2 with a reveal path — so #save2 stays
//                     honestly `unreachable` (its POST-revealed state is never replayed).
//
// The modal markup is injected on the #open / #open-post click (never present at load), so its
// inner controls are unreachable without replaying the reveal path. A poll hit-counter (pollHits)
// lets the test prove the poll was actually live (non-vacuous) during the crawl.

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Modal fixture</title></head>
<body>
  <h1>Stay-on-page modal demo</h1>
  <button id="baseline" type="button">Ping baseline</button>
  <button id="open" type="button">Open</button>
  <button id="open-post" type="button">Open form</button>
  <div id="modal-root"></div>
  <div id="modal-root2"></div>
  <script>
    // BACKGROUND: a setInterval-rooted poll running the whole time. The initiator classifier
    // must reject it even when it ticks inside the depth-1 modal act's (slow) causal window.
    setInterval(function () { fetch('/api/poll').catch(function () {}); }, 200);
    // #baseline fires nothing — an honest no-op control.
    document.getElementById('baseline').addEventListener('click', function () {});
    // #open REVEALS the modal by injecting markup that was NOT in the initial DOM. Same URL,
    // no navigation — the controls are reachable ONLY by replaying this click (stay-on-page).
    document.getElementById('open').addEventListener('click', function () {
      var root = document.getElementById('modal-root');
      if (root.childElementCount) return; // idempotent — replaying Open twice is a no-op
      root.innerHTML =
        '<div class="modal">' +
        '<input id="note" type="text" aria-label="Note">' +
        '<button id="save" type="button">Save</button>' +
        '<button id="dismiss" type="button">Dismiss</button>' +
        '</div>';
      // #save fires a SLOW GET so the 200ms poll ticks inside its causal window.
      document.getElementById('save').addEventListener('click', function () {
        fetch('/api/modal-save').catch(function () {});
      });
      // #dismiss closes the modal (fires nothing).
      document.getElementById('dismiss').addEventListener('click', function () {
        root.innerHTML = '';
      });
    });
    // #open-post is a MUTATING opener: it fires a POST (a non-navigating mutation) and THEN
    // reveals #save2. The GET-only gate must refuse to stamp #save2 with a reveal path.
    document.getElementById('open-post').addEventListener('click', function () {
      var root2 = document.getElementById('modal-root2');
      if (root2.childElementCount) return; // idempotent
      fetch('/api/mutate', { method: 'POST' }).catch(function () {});
      root2.innerHTML = '<div class="modal2"><button id="save2" type="button">Persist</button></div>';
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
  let logoutHits = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }
    if (u.pathname === '/api/poll') { pollHits++; return sendJson(res, 200, { t: Date.now() }); }
    // Slow 200 so the 200ms poll ticks inside #save's causal window (deterministic depth-1).
    if (u.pathname === '/api/modal-save') return setTimeout(() => sendJson(res, 200, { saved: true }), 600);
    // A non-navigating MUTATION fired by #open-post — makes that opener non-replayable (not all-GET).
    if (u.pathname === '/api/mutate' && req.method === 'POST') return sendJson(res, 200, { mutated: true });
    // A self-logout danger route — the pre-click reveal guard must REFUSE a hop that links here
    // BEFORE navigating, so this counter must stay 0 (a hit = a replay clicked its way to logout).
    if (u.pathname === '/logout') { logoutHits++; return sendJson(res, 200, { loggedOut: true }); }
    return sendJson(res, 404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    server.pollHits = () => pollHits;
    server.logoutHits = () => logoutHits;
    resolve(server);
  }));
}
