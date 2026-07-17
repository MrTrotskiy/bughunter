// Fixture for the ROUTE-MANIFEST seeder. A CONSTANT-URL onClick SPA: the home page exposes almost no
// a[href] (ONE nav link), so an a[href]-only route harvest collects ~1 route — yet the app's OWN
// same-origin bundle (/static/js/app.js) DECLARES its router with several static sections + a param
// route + a danger route + decoy asset/api literals. This is exactly the rawcaster shape the seeder
// exists to close: the honest denominator must jump from the href count to the declared count.
//
// The served bundle is DATA the extractor regexes over (never eval'd). It extracts ONLY React-Router
// `path:` config values — a bare leading-slash string-literal fallback is DELIBERATELY absent. Content:
//   static navigable : /a /b /c /user/settings   (path:"…", render real content on direct goto)
//   relative nested  : reports → /reports         (a v6 RELATIVE path: value, normalized + reachable)
//   redirect         : /d  → 302 to /            (HTTP redirect, caught PRE-settle)
//   client redirect  : /redir → JS replaceState to /  (a router redirect, caught only POST-settle; NOT
//                      in the manifest/href graph — reached only by a direct visitRoute in the coverage test)
//   empty (no ctrls) : /empty                     (visited, renders 0 controls → "visited but empty")
//   slow fetch target: /slow                      (answers after DCL so waitSettled waits — /redir's window)
//   danger           : /logout                   (declared, but routeRefused → NEVER seeded)
//   param pattern    : /item/:id                 (paramRoutes — counted, never directly navigated)
//   splat            : *                          (excluded — no leading slash / catch-all)
//   dynamic path expr: path:")".concat("z")        (a minified concat — the string regex grabs ")" →
//                      "/)"; the expr-char filter rejects it, mirroring the live rawcaster artifacts)
//   NOISE (rejected) : "/reactions" "/accept" "/static/js/app.js" "/api/data"  — NOT under `path:`,
//                      so the path:-only extractor drops them (the anti-inflation precision guard)

import http from 'node:http';

// The router literals a compiled React-Router bundle would carry (`path:"/x"` object literals, one v6
// RELATIVE nested value "reports"), plus NOISE literals that are NOT under `path:` — a bare route-shaped
// string ("/reactions", the socket.io/redux-action-fragment class) and three asset/api decoys. The
// extractor extracts ONLY `path:` values, so every NOISE literal below MUST be rejected.
const APP_JS = `
window.__ROUTER__ = [
  { path: "/a", element: "A" },
  { path: "/b", element: "B" },
  { path: "/c", element: "C" },
  { path: "/user/settings", element: "Settings" },
  { path: "/d", element: "D" },
  { path: "reports", element: "R" },
  { path: "/logout", element: "Logout" },
  { path: "/item/:id", element: "Item" },
  { path: ")".concat("z"), element: "Dyn" },
  { path: "*", element: "NotFound" }
];
function go(p){ history.pushState({}, "", p); }
var noise = "/reactions";
var frag = "/accept";
var asset = "/static/js/app.js";
var api = "/api/data";
`;

const html = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body>${body}</body></html>`;

// Home: ONE a[href] (so the href-only harvest finds a single route) + the declaring bundle.
const HOME = html('Onclick SPA', `
  <h1>Home</h1>
  <a href="/a" id="nav-a">Go to A</a>
  <script src="/static/js/app.js"></script>
`);

export function start(port) {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://x').pathname;
    if (p === '/static/js/app.js') {
      res.writeHead(200, { 'content-type': 'application/javascript; charset=utf-8' });
      return res.end(APP_JS);
    }
    if (p === '/d') { res.writeHead(302, { location: '/' }); return res.end(); } // HTTP-302 redirect → unreachable
    // /slow: a fetch target that answers AFTER domcontentloaded, so waitSettled must wait for it — the
    // window in which /redir's CLIENT-SIDE redirect fires (exercises visitRoute's POST-settle guard, the
    // one a pre-settle URL check cannot catch: an HTTP-302 lands before settle, a router redirect after).
    if (p === '/slow') { setTimeout(() => { res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok'); }, 120); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (p === '/a') return res.end(html('A', '<h1>Section A</h1><button id="a-btn" type="button">A action</button>'));
    if (p === '/b') return res.end(html('B', '<h1>Section B</h1>'));
    if (p === '/c') return res.end(html('C', '<h1>Section C</h1>'));
    if (p === '/user/settings') return res.end(html('Settings', '<h1>User settings</h1>'));
    if (p === '/reports') return res.end(html('Reports', '<h1>Reports</h1>')); // v6 relative path:"reports" → /reports
    // /redir: a SAME-ORIGIN CLIENT-SIDE redirect. On load it fetches /slow, then history.replaceState's
    // the URL to "/" AND appends a control that belongs to "/" — modelling a React-Router <Navigate> that
    // both rewrites the URL and swaps in another section's DOM. If visitRoute snapshotted it, that phantom
    // control would be double-attributed to /redir (the exact over-count the POST-settle guard prevents).
    if (p === '/redir') return res.end(html('Redir', '<h1>Redirecting</h1><script>fetch("/slow").then(function(){history.replaceState({},"","/");var b=document.createElement("button");b.id="phantom";b.textContent="Phantom";document.body.appendChild(b);});</script>'));
    // /empty: a Not-Found-like page with ZERO interactive controls — visited, but collects no own content.
    if (p === '/empty') return res.end(html('Not found', '<h1>Not found</h1><p>No controls here.</p>'));
    if (p === '/logout') return res.end(html('Logout', '<h1>Logged out</h1>'));
    if (/^\/item\/\w+$/.test(p)) return res.end(html('Item', '<h1>Item</h1>'));
    return res.end(HOME);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
