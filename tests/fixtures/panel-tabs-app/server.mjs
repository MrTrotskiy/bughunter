// Zero-dep fixture for the "panel reach" fill (decisions.md 2026-07-15 depth-2 Option A). Models the
// rawcaster antd-overflow failure: tabs that are PRESENT in the DOM at baseline but HIDDEN behind a
// "…more" panel, so they are discovered PATHLESS and, under first-reveal-wins, would be locked
// unreachable forever (NOT_VISIBLE with no reveal path to replay).
//   - Constant URL (`/app`): every state change is in-page, the URL never changes.
//   - Two tab buttons (`button.tab`, one template / two instances) are `display:none` at baseline —
//     captured by querySelectorAll but NOT visible, so mergeSnapshot stamps `hiddenWhenSeen: true`
//     and no reveal path (pathless). This is the exact lock-in the fill closes.
//   - A "More" toggle (visible at baseline, so hiddenWhenSeen:false — it must NEVER fill itself)
//     flips the tabs to visible on click, firing NO request (a pure uncover: it reveals NO new
//     instances, so ONLY the fill flags it an opener). The stamped act then fills the now-visible
//     pre-existing tabs with reveal=[More] and clears their unreachable — they become replayable.
//   - Clicking a revealed tab fires GET /tab-data (so a reached tab is genuine coverage with an
//     attributed request), reveals nothing (a leaf, not an opener).
//   - A 200ms background GET /api/poll runs throughout — the causal-survival guard (must never be
//     attributed to the tab act nor to the replayed "More" uncover).
//
// TWO DOM orderings, one behavior model, two DIFFERENT loop paths (a reveal reaches BOTH):
//   - `/app` — tabs BEFORE #more in the DOM, so the tab template gets the lower templateId and the
//     frontier emits it FIRST: the tab is acted (NOT_VISIBLE, drained) BEFORE More is ever seen, then
//     a LATER batch re-emits it after the fill reopened it. Exercises the cross-batch REOPEN path.
//   - `/app-opener-first` — #more BEFORE the tabs, so More gets the lower templateId and is emitted
//     FIRST, in the SAME batch as the tab. More's act fills the tab's reveal, but the tab's batch item
//     was snapshotted (by nextBatch) BEFORE that fill, so it still reads reveal=null. Only the
//     persistentStep GRAPH re-read (recon-run.mjs) picks up the fresh [More] path in time to replay it
//     THIS batch. Revert the re-read → this ordering leaves the tab NOT_VISIBLE-unreachable.

import http from 'node:http';

const SCRIPT = `<script>
    setInterval(function () { fetch('/api/poll').catch(function () {}); }, 200);
    document.getElementById('more').addEventListener('click', function () {
      for (var t of document.querySelectorAll('.tab')) t.style.display = 'inline-block';
    });
    for (var t of document.querySelectorAll('.tab')) {
      t.addEventListener('click', function (e) {
        fetch('/tab-data?t=' + e.currentTarget.getAttribute('data-t')).catch(function () {});
      });
    }
  </script>`;

const TABS = `<div id="tabs">
    <button class="tab" data-t="a" type="button" style="display:none">Tab A</button>
    <button class="tab" data-t="b" type="button" style="display:none">Tab B</button>
  </div>`;
const MORE = `<button id="more" class="more" type="button">More</button>`;

// tabs-first: the tab template gets the lower templateId → emitted first → cross-batch REOPEN path.
const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Panel-tabs fixture</title></head>
<body>
  <h1>Panel-hidden tabs</h1>
  ${TABS}
  ${MORE}
  ${SCRIPT}
</body></html>`;

// opener-first: #more gets the lower templateId → emitted first, SAME batch as the tab → the
// persistentStep graph re-read path (the tab's fresh [More] reveal must be picked up this batch).
const PAGE_OPENER_FIRST = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Panel-tabs fixture (opener-first)</title></head>
<body>
  <h1>Panel-hidden tabs (opener-first)</h1>
  ${MORE}
  ${TABS}
  ${SCRIPT}
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
    if (u.pathname === '/app-opener-first') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGE_OPENER_FIRST);
    }
    if (u.pathname === '/' || u.pathname === '/app') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }
    if (u.pathname === '/api/poll') { pollHits++; return sendJson(res, 200, { t: 1 }); }
    if (u.pathname === '/tab-data') return sendJson(res, 200, { tab: u.searchParams.get('t') });
    return sendJson(res, 404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    server.pollHits = () => pollHits;
    resolve(server);
  }));
}
