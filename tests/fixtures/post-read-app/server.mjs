// Zero-dep fixture for READ-ALLOWLIST POPULATION — the productive half of the abort-by-default read-only
// WRITE-FIREWALL (lib/recon/read-only-firewall.mjs). Models the rawcaster shape where a page's MAIN CONTENT
// loads over a POST-READ: on load the page fires POST /api/listitems (a list query — a READ over POST) and
// renders each returned item as an interactive control. Under the ABORT-BY-DEFAULT firewall with an EMPTY
// allowlist that POST is ABORTED, so the baseline is SPARSE (the item controls never render); once the AGENT
// judges POST /api/listitems a read (judge-endpoint --class=read → state/read-allowlist.json), the NEXT
// navigation CONTINUES it and the content — the item controls — loads into the graph. This is the multi-pass
// the whole feature exists to prove: abort-by-default stays safe, yet content loads PROGRESSIVELY.
//   listItems  POST /api/listitems  a READ over POST (content load). ABORTED empty-allowlist → sparse; ALLOWED once judged.
//   static     #static-ctrl         a control present WITHOUT any POST — proves pass 1 is sparse, not blank.
//   dostuff    POST /api/dostuff    a benign-NAMED write (no write verb in the path), NEVER allowlisted →
//                                   stays aborted on EVERY pass (the safety win: the read opening never opens the write).
//   /api/init  GET                  a load-time read so the probe's total>0 (fast waitSettled, no 3s stall).
// Server-side hit counters are the FAIL-ON-REVERT levers: listItemsHits rises ONLY when the read is allowed;
// dostuffHits stays 0 (a read-only crawl never reaches the write endpoint, judged or not).

import http from 'node:http';

// The item controls the POST-read renders. Distinct ids → distinct templates, so each is an addressable
// element in the graph — present ⇔ the content POST-read was CONTINUED.
const ITEMS = [
  { id: 'alpha', label: 'Item alpha' },
  { id: 'beta', label: 'Item beta' },
  { id: 'gamma', label: 'Item gamma' },
];

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>POST-read content fixture</title></head>
<body>
  <h1>POST-read content demo</h1>
  <button id="static-ctrl" type="button">Static action</button>
  <button id="w-dostuff" type="button">Process</button>
  <div id="content-root"></div>
  <script>
    // Load-time read so the probe registers network activity (total > 0 → fast settle).
    fetch('/api/init').catch(function () {});
    // MAIN CONTENT loads over a POST-READ. Aborted under the empty allowlist → SPARSE baseline (the item
    // controls never render); continued once the agent allowlists POST /api/listitems → the controls appear.
    fetch('/api/listitems', { method: 'POST' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        var root = document.getElementById('content-root');
        (data.items || []).forEach(function (it) {
          var b = document.createElement('button');
          b.id = 'item-' + it.id;
          b.type = 'button';
          b.textContent = it.label;
          root.appendChild(b);
        });
      })
      .catch(function () {}); // an aborted read rejects here — no content, sparse page.
    // A benign-NAMED write (no write verb in the path). Never allowlisted → aborted on every pass.
    document.getElementById('w-dostuff').addEventListener('click', function () {
      fetch('/api/dostuff', { method: 'POST' }).catch(function () {});
    });
  </script>
</body></html>`;

function sendJson(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

export function start(port = 0) {
  let initHits = 0;
  let listItemsHits = 0;
  let dostuffHits = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }
    if (u.pathname === '/api/init') { initHits++; return sendJson(res, 200, { ok: true }); }
    // The content READ-over-POST. A hit means the firewall CONTINUED it (allowlisted); on the empty allowlist
    // it is aborted and this counter stays 0 (the sparse-baseline lever).
    if (u.pathname === '/api/listitems' && req.method === 'POST') { listItemsHits++; return sendJson(res, 200, { items: ITEMS }); }
    // A benign-named write. A hit means a read-only crawl reached a write endpoint — must NEVER happen (it is
    // never allowlisted, so the firewall aborts it on every pass). The safety-win lever.
    if (u.pathname === '/api/dostuff' && req.method === 'POST') { dostuffHits++; return sendJson(res, 200, { ok: true }); }
    return sendJson(res, 404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    server.initHits = () => initHits;
    server.listItemsHits = () => listItemsHits;
    server.dostuffHits = () => dostuffHits;
    resolve(server);
  }));
}
