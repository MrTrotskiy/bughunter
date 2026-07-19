// Zero-dep fixture for DURABLE-LOCATOR instance resolution (resolve-handle.mjs). Models a DYNAMIC feed
// whose rows re-render (reshuffle) WHILE the stateful walk stays on the page — the exact first-target
// failure: the stored POSITIONAL instanceSelector (:nth-child + data-id) goes STALE, so a positional-only
// resolver marks the control NO_INSTANCE-unreachable even though it is still right there. A durable
// role+name locator re-locates the LIVE element (a representative of the template).
//   - GET /api/init        one load-burst fetch (fires under __idle__, token-excluded).
//   - GET /api/poll        150ms background poll (must stay uncredited even inside a slow window).
//   - #feed                a <ul> of rows [alpha, beta, gamma], each `<li data-id="X"><button>Like X</button></li>`.
//                          The three buttons share ONE template (nth-child/data-id normalized out); its
//                          walked representative is instance[0] = alpha. alpha fires GET /api/like/alpha,
//                          made SLOW (~400ms) so the 150ms poll ticks INSIDE its causal window
//                          (adversarial cleanliness AT the durable act).
//   - window.__reshuffle() REVERSES the row order (MOVING the same DOM nodes, listeners intact) →
//                          [gamma, beta, alpha]. alpha moves to nth-child(3), so its stored
//                          `[data-id=alpha][:nth-child(1)]` selector goes null — the durable role+name
//                          locator "Like Alpha" still resolves it live (the representative case).
//   - #refresh             a standalone button OUTSIDE the feed (id-anchored, never reshuffled) firing
//                          GET /api/refresh — the EXACT-match control the resolver reaches via its
//                          surviving stored selector and must NOT flag a representative (no over-counting).
// No danger-worded controls/routes (Like Alpha/Beta/Gamma, Refresh feed). pollHits proves the poll was
// live (non-vacuous).

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Resolve fixture</title></head>
<body>
  <h1>Dynamic feed</h1>
  <ul id="feed">
    <li data-id="alpha"><button type="button">Like Alpha</button></li>
    <li data-id="beta"><button type="button">Like Beta</button></li>
    <li data-id="gamma"><button type="button">Like Gamma</button></li>
  </ul>
  <button id="refresh" type="button">Refresh feed</button>
  <script>
    // LOAD BURST: one fetch at load, under __idle__ — excluded by the token, never credited.
    fetch('/api/init').catch(function () {});
    // BACKGROUND: a 150ms poll running the whole time; must stay uncredited even inside alpha's window.
    setInterval(function () { fetch('/api/poll').catch(function () {}); }, 150);
    var feed = document.getElementById('feed');
    Array.prototype.forEach.call(feed.querySelectorAll('li'), function (li) {
      var id = li.getAttribute('data-id');
      li.querySelector('button').addEventListener('click', function () { fetch('/api/like/' + id).catch(function () {}); });
    });
    document.getElementById('refresh').addEventListener('click', function () { fetch('/api/refresh').catch(function () {}); });
    // Reverse the feed IN PLACE by moving the SAME nodes (their click listeners persist). Called by the
    // test AFTER the baseline snapshot, so the stored nth-child selectors go stale but identity holds.
    window.__reshuffle = function () {
      Array.prototype.slice.call(feed.children).reverse().forEach(function (li) { feed.appendChild(li); });
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
    // alpha (the walked representative) is SLOW so the 150ms poll ticks inside its causal window.
    if (u.pathname === '/api/like/alpha') return setTimeout(() => sendJson(res, 200, { liked: true }), 400);
    if (u.pathname.startsWith('/api/like/')) return sendJson(res, 200, { liked: true });
    if (u.pathname === '/api/refresh') return sendJson(res, 200, { refreshed: true });
    return sendJson(res, 404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    server.pollHits = () => pollHits;
    resolve(server);
  }));
}
