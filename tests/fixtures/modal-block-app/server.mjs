// Fixture for OVERLAY-AWARE stateful acting (overlay-dismiss.mjs). Models the modal-heavy-app
// regression the live rawcaster stateful run hit: an act OPENS a full-screen backdrop modal that
// OBSCURES the base-page siblings, so a raw click on a sibling TIMES OUT (obscured, NOT hidden —
// Playwright still reports it visible) → mass unreachable → premature drain. Real traffic classes
// plus the depth-1 modal the fix must STUDY, then CLOSE:
//   - GET /api/poll       a 150ms setInterval running the WHOLE time            → BACKGROUND
//                         (uncredited), must stay uncredited even when it ticks inside #modal-act's
//                         (slow) causal window — the causal-survival-at-depth invariant.
//   - #open (A)           a baseline button that SHOWS the modal (the hidden-at-baseline #modal
//                         becomes display:flex). Fires nothing — a pure opener.
//   - #modal-act (M)      a control INSIDE the modal (hidden at baseline, shown by A). Fires a SLOW
//                         GET /api/modal-act (~600ms) so the 150ms poll deterministically ticks
//                         inside its window. On top of the backdrop, so it is clickable — the modal
//                         control the loop STUDIES.
//   - #target (B)         a baseline sibling that fires GET /api/target. When the modal is open the
//                         full-screen backdrop OBSCURES it → a raw click times out. Reached ONLY
//                         after dismissBlockingOverlay closes the modal.
//
// The modal closes ONLY on the Escape key (a document keydown listener) — NEVER via a clickable
// control. If it had a clickable close button, the loop would enumerate + click it as a normal
// control, closing the modal WITHOUT exercising the mid-walk dismisser — the fixture would then pass
// even reverted (vacuous). Escape is reachable ONLY by dismissBlockingOverlay, so the guard is real.
//
// #modal is display:none at baseline but PRESENT in the DOM before #target, so the snapshot mints
// #modal-act's id BEFORE #target's (the snapshot captures hidden controls with visible:false). The
// loop therefore studies M (once A makes it visible) before B — the study-then-close order.

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Modal-block fixture</title></head>
<body>
  <h1>Overlay-aware acting demo</h1>
  <button id="open" type="button">Open dialog</button>
  <div id="modal" role="dialog" class="modal"
       style="display:none;position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.6);align-items:center;justify-content:center">
    <div class="modal-body" style="background:#fff;padding:24px">
      <p>Choose your option</p>
      <button id="modal-act" type="button">Apply</button>
    </div>
  </div>
  <button id="target" type="button">Do thing</button>
  <script>
    // BACKGROUND: a setInterval-rooted poll running the whole time. The initiator classifier must
    // reject it even when it ticks inside #modal-act's (slow) causal window.
    setInterval(function () { fetch('/api/poll').catch(function () {}); }, 150);
    // #open SHOWS the modal (a hidden-at-baseline overlay). Same URL, no navigation.
    document.getElementById('open').addEventListener('click', function () {
      document.getElementById('modal').style.display = 'flex';
    });
    // #modal-act fires a SLOW GET so the 150ms poll ticks inside its causal window (depth-1).
    document.getElementById('modal-act').addEventListener('click', function () {
      fetch('/api/modal-act').catch(function () {});
    });
    // #target fires a plain GET — but only reachable once the backdrop is gone.
    document.getElementById('target').addEventListener('click', function () {
      fetch('/api/target').catch(function () {});
    });
    // The modal closes ONLY on Escape — the mid-walk dismisser's path, never a clickable control.
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') document.getElementById('modal').style.display = 'none';
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
    if (u.pathname === '/api/poll') { pollHits++; return sendJson(res, 200, { t: Date.now() }); }
    // Slow 200 so the 150ms poll ticks inside #modal-act's causal window (deterministic depth-1).
    if (u.pathname === '/api/modal-act') return setTimeout(() => sendJson(res, 200, { applied: true }), 600);
    if (u.pathname === '/api/target') return sendJson(res, 200, { ok: true });
    return sendJson(res, 404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    server.pollHits = () => pollHits;
    resolve(server);
  }));
}
