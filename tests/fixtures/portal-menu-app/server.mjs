// Zero-dep fixture for the REVEAL-BACKFILL fix (in-app-state reach; Fable design lock). Reproduces the live
// first-target class: a row's action menu is a PORTAL that MOUNTS ONLY on the "…" click — the menuitem is NEVER
// in the DOM while the menu is closed, so it can only ever be captured `visible===true` → the write-once
// `hiddenWhenSeen` is structurally always false → the OLD `fillRevealIfHidden` never backfills a reveal path
// → cold re-navigation can't reach it (NO_INSTANCE). The per-act `preVisible` transition (a control NOT
// visible immediately before the act, visible after → revealed by this act) fixes it.
//
// - `.more` "…" trigger lives INSIDE each row's <article> card (resolves on a cold nav).
// - Clicking "…" fires GET /menu-open (a READ → allGet, so the opener act STAMPS a reveal path) and mounts
//   `#portal-menu` as a direct child of <body> (DETACHED from the card) holding a SAFE menuitem "Copy link"
//   (fires GET /copy — the reach target; a Delete would be danger-floored and can't be the reach assertion).
//   A comment spacer is prepended to <body> each open so the portal's positional nth-child index SHIFTS
//   (exercises the durable role+name representative when the stored positional selector goes stale).
// - A 150ms GET /poll background tick runs the whole time (causal-survival: never credited to any act).

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Portal menu fixture</title></head>
<body>
  <div id="feed">
    <article data-id="r1"><span>Row one</span><button class="more" type="button">More</button></article>
    <article data-id="r2"><span>Row two</span><button class="more" type="button">More</button></article>
  </div>
  <script>
    function api(m, u) { return fetch(u, { method: m }).catch(function () {}); }
    setInterval(function () { api('GET', '/poll'); }, 150);           // background poll (never credited)
    document.querySelectorAll('.more').forEach(function (b) {
      b.addEventListener('click', function () {
        api('GET', '/menu-open');                                     // a READ → opener stamps
        var old = document.getElementById('portal-menu'); if (old) old.remove();
        document.body.insertBefore(document.createComment('spacer'), document.body.firstChild); // shift portal index
        var p = document.createElement('div'); p.id = 'portal-menu';
        p.innerHTML = '<button class="copy" type="button">Copy link</button>';
        document.body.appendChild(p);                                 // PORTAL — detached from the card, mounted on open
        p.querySelector('.copy').addEventListener('click', function () { api('GET', '/copy'); });
      });
    });
  </script>
</body></html>`;

function ok(res, body, type) {
  res.writeHead(200, { 'content-type': type || 'application/json' });
  res.end(body || '{}');
}

export function start(port = 0) {
  const server = http.createServer((req, res) => {
    const p = new URL(req.url, 'http://127.0.0.1').pathname;
    if (p === '/' || p === '') return ok(res, PAGE, 'text/html; charset=utf-8');
    if (p === '/menu-open' || p === '/copy' || p === '/poll') return ok(res, '{"ok":true}');
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not found"}');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
