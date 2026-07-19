// Zero-dep fixture for the SAME-NAME representative bug (INC.6) — the last link in the create chain.
//
// Reproduces the live target shape exactly: the button that OPENS the create modal and the button that
// SUBMITS it carry the SAME accessible name ("Create Event"). They are different controls with different
// templates, and only the second one creates anything.
//
//   - #opener  "Create Event"  reveals the modal. Fires GET /api/open — the read that stood in for a create
//                              across seven live runs.
//   - modal submit "Create Event"  POSTs /api/create. This is the one that matters, and the one whose
//                              stored positional selector goes stale the moment the modal closes.
//
// The trap: with the modal shut, a page-wide getByRole('button', {name:'Create Event'}) resolves the
// OPENER. A resolver that accepts it hands back a control from a DIFFERENT template while the act is
// recorded against the submit — so the crawl reports the create as exercised and the server never hears
// of it. createHits() is the ground truth that separates the two.

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Same-name fixture</title></head>
<body>
  <main><button id="opener" type="button">Create Event</button></main>
  <div id="modal" style="display:none">
    <div class="modal-footer"><button id="submit" type="button">Create Event</button></div>
  </div>
  <script>
    document.getElementById('opener').addEventListener('click', function () {
      fetch('/api/open').catch(function () {});
      document.getElementById('modal').style.display = 'block';
    });
    document.getElementById('submit').addEventListener('click', function () {
      fetch('/api/create', { method: 'POST' }).catch(function () {});
    });
  </script>
</body></html>`;

export async function start(port = 0) {
  let creates = 0;
  let opens = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/create' && req.method === 'POST') { creates++; res.writeHead(200).end('{}'); return; }
    if (url.pathname === '/api/open') { opens++; res.writeHead(200).end('{}'); return; }
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE); return; }
    res.writeHead(404).end();
  });
  server.createHits = () => creates;
  server.openHits = () => opens;
  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  return server;
}
