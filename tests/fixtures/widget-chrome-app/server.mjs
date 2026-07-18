// Zero-dep fixture for WIDGET CHROME exclusion (INC.6f) — and, just as importantly, for the converse.
//
// Reproduces the two AntD portal shapes the crawler must treat OPPOSITELY, both mounted into <body> and
// both opened by a CLICK (never present in the baseline markup — that is the live shape, and a fixture that
// pre-renders them would not exercise the path where they actually enter the graph):
//
//   #date   — a readonly input inside `.ant-picker`. Clicking it mounts `.ant-picker-dropdown` containing
//             month/year/decade switcher buttons. This is CHROME: nobody "covers" `Choose a decade`, they
//             pick a date. It must never become a coverage obligation. Measured on the live target: 55 such
//             templates, 17% of the graph, ZERO requests ever fired between them.
//
//   #more   — a "…" button. Clicking it mounts a `[role=menu]` portal with `role=menuitem` entries. This is
//             GENUINE application surface — a row's Edit/Delete/Share, the exact case INC.2 exists to make
//             addressable — and it must keep being walked. It also fires a real request when clicked, so the
//             test can prove it is reachable rather than merely enumerated.
//
// The discriminator under test is the ARIA authoring pattern, not the container: role=menuitem is never
// chrome. On the live graph the two sets have ZERO role overlap across 84 templates (chrome is
// button/generic; portal menus are menuitem/menu).

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Widget chrome fixture</title></head>
<body>
  <main>
    <div class="ant-picker"><input id="date" readonly placeholder="Enter start date"></div>
    <button id="more" type="button">more_horiz</button>
    <div class="ant-select"><input id="sel" readonly placeholder="Choose community"></div>
    <button id="plain" type="button">Refresh</button>
  </main>
  <script>
    // The picker panel: mounted on click, as a body-level portal, exactly like AntD.
    document.getElementById('date').addEventListener('click', function () {
      if (document.querySelector('.ant-picker-dropdown')) return;
      var d = document.createElement('div');
      d.className = 'ant-picker-dropdown';
      d.innerHTML = '<button type="button" class="ant-picker-month-btn">Choose a month</button>'
                  + '<button type="button" class="ant-picker-year-btn">Choose a year</button>'
                  + '<button type="button" class="ant-picker-decade-btn">Choose a decade</button>'
                  + '<button type="button" class="ant-picker-header-super-next-btn">Next year (Control + right)</button>';
      document.body.appendChild(d);
    });
    // The HARD case (AntD dropdownRender): a select popup that contains BOTH chrome (the option list)
    // AND a real application control injected by the app. The container is identical to the picker's, so
    // only the ARIA role can tell them apart — this is what makes the role exemption load-bearing rather
    // than decorative.
    document.getElementById('sel').addEventListener('click', function () {
      if (document.querySelector('.ant-select-dropdown')) return;
      var d = document.createElement('div');
      d.className = 'ant-select-dropdown';
      d.innerHTML = '<div class="ant-select-item-option">Alpha</div>'
                  + '<div class="ant-select-item-option">Beta</div>'
                  + '<div role="menuitem" id="mi-add">Add new community</div>';
      document.body.appendChild(d);
      d.querySelector('#mi-add').addEventListener('click', function () { fetch('/api/add').catch(function () {}); });
    });
    // The portal MENU: same body-portal shape, but role=menu/menuitem — real controls.
    document.getElementById('more').addEventListener('click', function () {
      if (document.querySelector('[role=menu]')) return;
      var m = document.createElement('div');
      m.setAttribute('role', 'menu');
      m.className = 'ant-dropdown-menu';
      m.innerHTML = '<div role="menuitem" id="mi-edit">Edit</div><div role="menuitem" id="mi-share">Share Link</div>';
      document.body.appendChild(m);
      m.querySelector('#mi-share').addEventListener('click', function () { fetch('/api/share').catch(function () {}); });
    });
    document.getElementById('plain').addEventListener('click', function () { fetch('/api/refresh').catch(function () {}); });
  </script>
</body></html>`;

export async function start(port = 0) {
  let shares = 0;
  let adds = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/share') { shares++; res.writeHead(200).end('{}'); return; }
    if (url.pathname === '/api/add') { adds++; res.writeHead(200).end('{}'); return; }
    if (url.pathname === '/api/refresh') { res.writeHead(200).end('{}'); return; }
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE); return; }
    res.writeHead(404).end();
  });
  server.shareHits = () => shares;
  server.addHits = () => adds;
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}
