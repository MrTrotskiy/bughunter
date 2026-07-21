// Fixture for the APP-MODAL-COVER retry (stateful-step.mjs FIX 1). Models the live dashboard
// regression: a modal left OPEN by a PRIOR act covers the NEXT opener, so its click TIMES OUT with a
// pointer interception (`<div …> intercepts pointer events`), the opener is marked unreachable, and the
// 7-field form BEHIND it is never studied. Traffic + control classes:
//   - GET /api/poll        a 150ms setInterval running the WHOLE time → BACKGROUND (uncredited). It
//                          ticks while the modal-close runs, so a close that WRONGLY opened a causal
//                          window would credit it — the non-vacuous causal-cleanliness guard.
//   - #notice-open (X)     baseline button. Opens modal A (a full-screen role=dialog BACKDROP). Fires
//                          nothing — a pure opener. A stays open (no auto-close).
//   - modal A (#notice)    a blocking dialog that IGNORES Escape and exposes NO curated close class
//                          (no .ant-modal-close / .ant-modal-wrap / [aria-label=Close]) — so
//                          dismissBlockingOverlay CANNOT close it. Its ONLY close is a text "Cancel"
//                          button (#notice-cancel) that hides A and FIRES NOTHING (a pure client-side
//                          close — the server sees no request from it). This is what defeats the
//                          existing overlay dismisser and forces the app-modal fallback.
//   - #create-event (B)    baseline OPENER, obscured by A once A is open. Fires GET /api/event AND
//                          opens modal C. Reached ONLY after the fallback closes A and retries.
//   - modal C (#schedule)  the "Schedule a Meeting" form — 7 inputs, hidden at baseline, shown by B.
//                          Its fields are studied only if B fired (the whole point of the fix).
//
// DOM ORDER mints X and B the two LOWEST template ids (both visible at baseline), so the loop acts X
// first (A opens), then B (now behind A) — the exact "a prior act's modal covers the next opener"
// order. A's Cancel is named "Cancel" so pickLive ranks it LAST (dismiss), never ahead of B; the loop
// therefore reaches B while A is still up instead of closing A itself first (which would be vacuous).

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Modal-cover fixture</title></head>
<body>
  <h1>Dashboard</h1>
  <button id="notice-open" type="button">Show Notice</button>
  <button id="create-event" type="button">Create Event</button>

  <div id="notice" role="dialog" class="notice-modal"
       style="display:none;position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.6)">
    <div class="notice-body" style="background:#fff;padding:24px;max-width:420px;margin:80px auto">
      <p>A notice you must acknowledge.</p>
      <button id="notice-cancel" type="button">Cancel</button>
    </div>
  </div>

  <div id="schedule" role="dialog" class="schedule-modal"
       style="display:none;position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,.6)">
    <div class="schedule-body" style="background:#fff;padding:24px;max-width:520px;margin:60px auto">
      <h2>Schedule a Meeting</h2>
      <label>Title <input id="f-title" type="text" name="title"></label>
      <label>Location <input id="f-location" type="text" name="location"></label>
      <label>Date <input id="f-date" type="text" name="date"></label>
      <label>Start <input id="f-start" type="text" name="start"></label>
      <label>End <input id="f-end" type="text" name="end"></label>
      <label>Guests <input id="f-guests" type="text" name="guests"></label>
      <label>Notes <input id="f-notes" type="text" name="notes"></label>
    </div>
  </div>

  <script>
    // BACKGROUND poll — must stay uncredited even while the modal-close runs.
    setInterval(function () { fetch('/api/poll').catch(function () {}); }, 150);
    // X opens the blocking modal A (same URL, no navigation). A does NOT auto-close.
    document.getElementById('notice-open').addEventListener('click', function () {
      document.getElementById('notice').style.display = 'block';
    });
    // A closes ONLY via its text "Cancel" — a pure client-side hide, no fetch. Escape is NOT handled.
    document.getElementById('notice-cancel').addEventListener('click', function () {
      document.getElementById('notice').style.display = 'none';
    });
    // B fires GET /api/event AND opens the form modal C.
    document.getElementById('create-event').addEventListener('click', function () {
      fetch('/api/event').catch(function () {});
      document.getElementById('schedule').style.display = 'block';
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
  const paths = [];
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    paths.push(u.pathname);
    if (u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }
    if (u.pathname === '/api/poll') { pollHits++; return sendJson(res, 200, { t: Date.now() }); }
    if (u.pathname === '/api/event') return sendJson(res, 200, { created: true });
    return sendJson(res, 404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    server.pollHits = () => pollHits;
    // Every non-poll path the server was asked for — used to prove the close fired NO server request.
    server.nonPollPaths = () => paths.filter((p) => p !== '/api/poll' && p !== '/');
    resolve(server);
  }));
}
