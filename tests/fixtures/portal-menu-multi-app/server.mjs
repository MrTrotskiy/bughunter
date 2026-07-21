// Zero-dep fixture for PORTAL-MENU IDENTITY (INC.2; decisions.md 2026-07-18 "portal-menu identity").
// Faithfully reproduces the live Ant Design shape that the earlier single-item portal-menu-app fixture
// did NOT: a body-portal `<ul role="menu">` holding MULTIPLE `<li role="menuitem">` of DISTINCT names,
// opened from TWO different rows, mounted under a BARE (class/id-less) <body>-child div — so under the OLD
// identity model every menuitem collapses onto ONE templateSelector and their open-order `#N` keys COLLIDE
// across the two menus (a self-check: Share-Link#1 == Edit#1). The INC.2 name-fold makes each action its own
// template (distinct edges) and its own `#1` instance (collision gone). This is the FAIL-ON-REVERT guard:
// revert the fold → distinct-template + no-collision assertions fail.
//
// Faithful to the live DOM:
// - each row's `.more` "…" trigger lives INSIDE the row card (resolves on a cold nav); clicking it fires a
//   READ GET /menu-open (allGet → the opener act STAMPS a reveal path) and mounts the portal DETACHED at <body>.
// - the portal wrapper is a bare `<div>` (no id/class → positional `body > div:nth-child(N)` path); a spacer
//   comment is prepended each open so that nth-child index SHIFTS (exercises the durable role-name fallback).
// - menuitems are `<li class="ant-dropdown-menu-item" role="menuitem" data-menu-id="rc-menu-uuid-…">` (the
//   framework-noise data-menu-id must NOT become a discriminator; the NAME must).
// - own row → Edit / Delete / Share Link; other row → Share Link / Block account / Report content / Save Item (N)
//   where N INCREMENTS each open (count-badge → must strip to a stable template, no per-render explosion).
// - one item carries value="MY_EVENTS" (semantic enum → folds from value, not text).
// - "Share Link" is the SAFE reach target (fires GET /share); Delete/Block/Report would be danger-floored.
// - a 120ms GET /poll background tick runs throughout (causal-survival: never credited to any measured act).

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Portal multi-menu fixture</title></head>
<body>
  <div id="app-root">
    <article class="card" data-id="own"><span>My own post</span><button class="more" type="button">More</button></article>
    <article class="card" data-id="other"><span>Someone else post</span><button class="more" type="button">More</button></article>
  </div>
  <script>
    function api(m, u) { return fetch(u, { method: m }).catch(function () {}); }
    setInterval(function () { api('GET', '/poll'); }, 120);            // background poll (never credited)
    var fanCount = 11;
    // action label -> [safe GET endpoint | null]. Only "Share Link" is safe to fire in a read-only crawl.
    var OWN = [['Edit', null], ['Delete', null], ['Share Link', '/share']];
    var OTHER = [['Share Link', '/share'], ['block Block account', null], ['report Report content', null], ['Save Item', null], ['My Events', null]];
    function mountMenu(items) {
      document.querySelectorAll('div[data-portal]').forEach(function (o) { o.remove(); });      // teardown (data-portal is identity-invisible)
      document.body.insertBefore(document.createComment('spacer'), document.body.firstChild);   // shift portal nth-child
      var portal = document.createElement('div'); portal.setAttribute('data-portal', '');       // BARE positional wrapper (no id/class), like live antd
      var ul = document.createElement('ul'); ul.className = 'ant-dropdown-menu ant-dropdown-menu-root'; ul.setAttribute('role', 'menu');
      items.forEach(function (it, i) {
        var label = it[0];
        if (label === 'Save Item') label = 'Save Item (' + (++fanCount) + ')';                   // count-badge that grows each open
        var li = document.createElement('li');
        li.className = 'ant-dropdown-menu-item'; li.setAttribute('role', 'menuitem');
        li.setAttribute('data-menu-id', 'rc-menu-uuid-99-' + i);                                // framework noise — must NOT key identity
        if (it[0] === 'My Events') li.setAttribute('value', 'MY_EVENTS');                        // semantic enum → folds from value
        li.textContent = label;
        if (it[1]) li.addEventListener('click', function () { api('GET', it[1]); });
        ul.appendChild(li);
      });
      portal.appendChild(ul); document.body.appendChild(portal);                                // PORTAL: bare div detached at <body>
    }
    document.querySelectorAll('.card').forEach(function (card) {
      card.querySelector('.more').addEventListener('click', function () {
        api('GET', '/menu-open');                                                               // READ → opener stamps
        mountMenu(card.getAttribute('data-id') === 'own' ? OWN : OTHER);
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
    if (p === '/menu-open' || p === '/share' || p === '/poll') return ok(res, '{"ok":true}');
    res.writeHead(404, { 'content-type': 'application/json' }); res.end('{"error":"not found"}');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
