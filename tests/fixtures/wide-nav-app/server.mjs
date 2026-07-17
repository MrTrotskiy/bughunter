// Fixture for the BFS URL route-frontier (Increment 1a). Two SERVERS on two ports (= two origins).
// The MAIN app's home carries FOUR link classes the route-frontier must handle:
//   - a WIDE NAV of 12 identical <a href="/pN"> (N=1..12) — ONE link template with 12 instances, so
//     the element frontier (non-opener, limit=1) reaches only /p1 by acting; /p9 is reachable ONLY by
//     the route-frontier discovering + visiting it. /p9 carries a control (only-p9) present nowhere else.
//   - a LISTING of 50 <a href="/item/N"> in <li> — ONE toUrlPattern /item/:param, so the census bound
//     visits ONE representative concrete route and folds the other 49 into its siblings tally.
//   - an <a href="/logout"> — a DANGER route the frontier must never navigate to (routeRefused).
//   - an off-origin <a href> to the PARTNER server — a scope trap: never harvested, never visited.
// /p1 is the DEEP page: a background setInterval beacon (a timer-rooted poll that must never be
// causally credited) plus a control firing a slow request (so a real causal window stays open while
// the beacon ticks — the non-vacuous half of the zero-phantom-edge guard).

import http from 'node:http';

const navLinks = () => Array.from({ length: 12 }, (_, i) =>
  `<a class="nav-link" href="/p${i + 1}">Page ${i + 1}</a>`).join('\n    ');

const itemLinks = () => Array.from({ length: 50 }, (_, i) =>
  `<li><a class="item-link" href="/item/${i + 1}">Item ${i + 1}</a></li>`).join('\n      ');

const HOME = (externalOrigin) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Wide nav</title></head>
<body>
  <h1>Home</h1>
  <nav>
    ${navLinks()}
  </nav>
  <ul>
      ${itemLinks()}
  </ul>
  <a href="/logout" id="logout-link">Logout</a>
  <a href="${externalOrigin}/partner-zone" id="partner-link">Partner site</a>
</body></html>`;

// A plain /pN page (bare heading). /p9 and /p1 override this with extra content below.
const plainPage = (n) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Page ${n}</title></head>
<body><h1>Page ${n}</h1></body></html>`;

// /p9 — the only page carrying the only-p9 control (a beyond-element-cap page).
const P9 = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Page 9</title></head>
<body>
  <h1>Page 9</h1>
  <button id="only-p9" type="button">Only P9</button>
</body></html>`;

// /p1 — the DEEP page: a background beacon poll + a control that fires a slow request, so a genuine
// causal window stays open long enough for the beacon to tick inside it (yet never be credited).
const P1 = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Page 1</title></head>
<body>
  <h1>Page 1</h1>
  <button id="p1-load" type="button">Load</button>
  <script>
    setInterval(function () { fetch('/beacon').catch(function () {}); }, 120);
    document.getElementById('p1-load').addEventListener('click', function () {
      fetch('/p1-data').catch(function () {});
    });
  </script>
</body></html>`;

const ITEM = (n) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Item ${n}</title></head>
<body><h1>Item ${n}</h1></body></html>`;

export function start(port, { externalOrigin }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (p === '/beacon') { res.writeHead(204); return res.end(); }
    if (p === '/p1-data') {
      // Slow reply holds p1-load's causal window open past the 120ms beacon interval.
      return setTimeout(() => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      }, 400);
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (p === '/p1') return res.end(P1);
    if (p === '/p9') return res.end(P9);
    const item = p.match(/^\/item\/(\d+)$/);
    if (item) return res.end(ITEM(item[1]));
    const pg = p.match(/^\/p(\d+)$/);
    if (pg) return res.end(plainPage(pg[1]));
    return res.end(HOME(externalOrigin));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// A MAIN-origin server whose /redir-evil path-preservingly 302-redirects to an OFF-ORIGIN sink — the
// H1 trap: a hostile target sends a same-origin href to a foreign/private host on the SAME path, so
// the path-only routeKey check would pass and the internal response would be snapshotted. The
// route-frontier must refuse to capture the landed off-origin page. Home links /redir-evil so harvest
// enqueues it.
export function startRedirector(port, { sinkOrigin }) {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/redir-evil') {
      res.writeHead(302, { location: `${sinkOrigin}/redir-evil` });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Redir home</title></head>'
      + '<body><h1>Home</h1><a href="/redir-evil" id="redir-link">Go</a></body></html>');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// The off-origin PARTNER server: minimal page + a hit counter the test asserts stays 0.
export function startExternal(port) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><h1>Partner</h1><button id="x">Go</button></body></html>');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    server.extHits = () => hits;
    resolve(server);
  }));
}
