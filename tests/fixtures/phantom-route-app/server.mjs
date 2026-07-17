// Zero-dep fixture for GOAL-1 PHANTOM-ROUTE detection (the honest denominator / measurement gate).
// A CONSTANT-URL SPA — the server returns HTTP 200 + the SAME shell for EVERY path, and client JS
// routes on location.pathname. This is the rawcaster class: HTTP status can NOT tell a real section
// from a phantom, so only the SETTLED URL (redirect?) and the RENDERED SHAPE (client-404?) can.
//
// Routes the <nav> a[href] harvest discovers (so harvestRoutes → seedRoutes → visitRoute exercise the
// real classification path, no bundle needed):
//   /              REAL   — Home, own content (h1 + a button → an own element template).
//   /dashboard     REAL   — own content.
//   /reports       REAL   — own content.
//   /groups            CLIENT-404 — renders the SHARED Not-Found component (text-only, ZERO controls).
//   /settings/privacy  CLIENT-404 — renders the SAME Not-Found component → its contentSig equals the
//                      NEGATIVE-CONTROL probe sig (a GET to a guaranteed-nonexistent path renders the
//                      same catch-all Not-Found → graph.notFoundSig), so both are labelled client-404.
//   /inbox         CONTENT-STARVED REAL — own <h1>Inbox</h1><p>No messages</p>, ZERO interactive
//                  controls (so visited-but-empty), but a DISTINCT tag structure (h1, not the h2 of
//                  Not-Found) → its contentSig ≠ notFoundSig. It must STAY visited-empty, NOT be
//                  mislabelled client-404 — the case a naive "N empty routes share a sig → collapse"
//                  dedup fails and the negative-control-probe anchor passes.
//   /legacy        REDIRECT (LATE) — shows "Loading…", then at 200ms replaceState('/dashboard')+render.
//                  The redirect fires AFTER the network settles, so a single post-waitSettled URL read
//                  MISSES it (Q1 bug) — only a BOUNDED routeKey-stability poll catches it.
//   /old-home      REDIRECT (FAST) — replaceState('/') synchronously on first render. The CONTROL case:
//                  caught by visitRoute's pre-settle read WITHOUT the poll (proves the poll is only for
//                  the late class, not a blanket wall-clock window).
//
// Q1 proof: /legacy must classify 'redirect', not visited-empty. Q2 proof: /groups + /settings/privacy
// match the Not-Found probe sig → client-404, while /inbox (distinct sig) stays visited-empty; the
// collectable denominator = the 3 REAL sections (honest 3/3, not the raw 3/8 the inflated one reads).

import http from 'node:http';

const SHELL = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Phantom-route fixture</title></head>
<body>
  <nav>
    <a href="/dashboard">Dashboard</a>
    <a href="/reports">Reports</a>
    <a href="/groups">Groups</a>
    <a href="/settings/privacy">Privacy</a>
    <a href="/inbox">Inbox</a>
    <a href="/legacy">Legacy</a>
    <a href="/old-home">Old home</a>
  </nav>
  <main id="app"></main>
  <script>
    // One fast load fetch on EVERY route load so waitSettled (total>0 && inflight===0) settles quickly
    // (~one poll interval) instead of spinning to its 3s timeout on a fetch-less page. This is what makes
    // /legacy a genuine POLL-only case: the network settles ~fast, the single post-settle read fires
    // BEFORE the 200ms redirect (misses it), and only the bounded routeKey poll catches the late hop.
    fetch('/api/init').catch(function () {});
    function render() {
      var p = location.pathname;
      var app = document.getElementById('app');
      if (p === '/old-home') {                 // FAST redirect — fires during first render (pre-settle).
        history.replaceState({}, '', '/');
        return render();
      }
      if (p === '/') {
        app.innerHTML = '<section class="home"><h1>Home</h1><button id="home-act" type="button">Home action</button></section>';
        return;
      }
      if (p === '/dashboard') {
        app.innerHTML = '<section class="dash"><h1>Dashboard</h1><button id="dash-act" type="button">Dashboard action</button></section>';
        return;
      }
      if (p === '/reports') {
        app.innerHTML = '<section class="rep"><h1>Reports</h1><button id="rep-act" type="button">Reports action</button></section>';
        return;
      }
      if (p === '/inbox') {                     // CONTENT-STARVED REAL — own content, ZERO controls, but a
        app.innerHTML = '<section class="inbox"><h1>Inbox</h1><p>No messages.</p></section>'; // DISTINCT
        return;                                 // tag structure (h1) so its contentSig != the Not-Found sig.
      }
      if (p === '/legacy') {                    // LATE redirect — fires 200ms AFTER the page settles, so a
        app.innerHTML = '<section class="loading"><h1>Loading…</h1></section>'; // single post-settle URL
        setTimeout(function () { history.replaceState({}, '', '/dashboard'); render(); }, 200); // read misses
        return;                                 // it; only the bounded routeKey poll (window 250ms) catches it.
      }
      // Every OTHER path (/groups, /settings/privacy, …) is a CLIENT-404: the SHARED Not-Found shape,
      // text-only, ZERO interactive controls. Identical structure on every dead route → identical sig.
      app.innerHTML = '<section class="notfound"><h2>No route matches URL</h2><p>The page you requested does not exist.</p></section>';
    }
    render();
  </script>
</body></html>`;

export function start(port = 0) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/api/init') {          // the fast load fetch — resolves immediately so waitSettled settles
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end('{"ready":true}');
    }
    // Constant-URL: 200 + the same shell for EVERY other path (client-side routing). No server 404 ever —
    // the phantom-ness is purely client-rendered, exactly the class visitRoute must detect.
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(SHELL);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
