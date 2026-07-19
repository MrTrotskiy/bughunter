// Zero-dep fixture for the CHURN bucket (blocker-6 Part B). Models a RE-RENDERING FEED WITHOUT stable
// data-ids — the live-target archetype. A feed row's instanceKey is CONTENT-derived (dom-snapshot rowKey:
// no data-id → the row's text), so when the feed re-renders with NEW text the OLD instanceKey vanishes and
// a NEW unexplored instance is minted. An unexplored REPRESENTATIVE that churns away before it is walked
// would else sit in `walkable` forever and keep frontierInstanceStats.remaining above 0 — the honest
// terminator could never declare DRAINED on a live feed. This fixture drives that vanishing DETERMINISTICALLY.
//
//   - GET /api/init      one load-burst fetch at load (fires under __idle__, token-excluded).
//   - GET /api/poll      80ms background poll (must stay uncredited even inside a slow window).
//   - #stable            a STABLE button "Show status" OUTSIDE the feed → GET /api/status, made SLOW (~300ms)
//                        so the 80ms poll ticks INSIDE its causal window (adversarial cleanliness). NEVER
//                        churns — it is the stable control set that must drain to remaining===0.
//   - #feed              a <ul> of rows `<li><button>News N</button></li>` with NO data-ids. Baseline text
//                        "News 0/1/2" → the feed template's instance[0] is "News 0". A NON-opener list-row
//                        template (inRow=true → node.listRow), so only instance[0] is walkable.
//   - #ghost             a STANDALONE button "Open panel" OUTSIDE any list (id-anchored, NOT a list row).
//                        Removed by __churn → it vanishes like a feed row but is NON-listRow, so it must be
//                        reclassified UNREACHABLE (a genuine gap), NOT churned — the contrast case.
//   - window.__churn()   PREPENDS a non-button separator `<li>` and REPLACES every item's text ("News 3/4/5")
//                        AND removes #ghost. The separator makes the OLD top item's stored POSITIONAL selector
//                        (`#feed > li:nth-child(1) > button`) resolve to a button-less li → null, and its role
//                        +name ("News 0") is gone — so resolveHandle CANNOT reach "News 0" by ANY strategy →
//                        retireLeftovers reclassifies it CHURNED (list row). The new items mint fresh
//                        instanceKeys (the "text changed → new instance appended" the CTO describes).
// No danger-worded controls/routes. pollHits proves the poll was live (non-vacuous).

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Churn feed fixture</title></head>
<body>
  <h1>Live feed</h1>
  <button id="stable" type="button">Show status</button>
  <button id="ghost" type="button">Open panel</button>
  <ul id="feed">
    <li><button type="button">News 0</button></li>
    <li><button type="button">News 1</button></li>
    <li><button type="button">News 2</button></li>
  </ul>
  <script>
    // LOAD BURST: one fetch at load, under __idle__ — excluded by the token, never credited.
    fetch('/api/init').catch(function () {});
    // BACKGROUND: an 80ms poll running the whole time; must stay uncredited even inside the stable window.
    setInterval(function () { fetch('/api/poll').catch(function () {}); }, 80);
    document.getElementById('stable').addEventListener('click', function () { fetch('/api/status').catch(function () {}); });
    // #ghost fires nothing meaningful — it is never clicked (removed by __churn before the walk reaches it).
    document.getElementById('ghost').addEventListener('click', function () { fetch('/api/help').catch(function () {}); });
    // CHURN: prepend a button-less separator (breaks the old top item's positional selector), relabel the
    // items with brand-new text (mints new content-keyed instanceKeys), and remove #ghost. Called by the
    // test AFTER the baseline snapshot, so the stored representative "News 0" can no longer be resolved.
    window.__churn = function () {
      var feed = document.getElementById('feed');
      feed.innerHTML =
        '<li class="sep">\\u2014 older \\u2014</li>' +
        '<li><button type="button">News 3</button></li>' +
        '<li><button type="button">News 4</button></li>' +
        '<li><button type="button">News 5</button></li>';
      var ghost = document.getElementById('ghost');
      if (ghost) ghost.remove();
    };
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
    // #stable is SLOW so the 80ms poll ticks inside its causal window (adversarial cleanliness).
    if (u.pathname === '/api/status') return setTimeout(() => sendJson(res, 200, { ok: true }), 300);
    if (u.pathname === '/api/help') return sendJson(res, 200, { help: true });
    return sendJson(res, 404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    server.pollHits = () => pollHits;
    resolve(server);
  }));
}
