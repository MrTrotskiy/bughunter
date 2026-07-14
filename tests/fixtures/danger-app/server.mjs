// Zero-dep single-page fixture whose ONLY control is an obvious destructive one, so a
// test can prove the fire-path danger gate refuses to click it. The page wires:
//   - a "Delete" button that, WHEN CLICKED, POSTs /api/delete (the effect we must never
//     let recon trigger). The server counts those POSTs so the test can assert ZERO —
//     the gate must stop the click before the request, not after.
// There is no benign control here on purpose: this fixture exists to exercise refusal.

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Danger fixture</title></head>
<body>
  <h1>Danger demo</h1>
  <button id="del" type="button">Delete</button>
  <script>
    // If this ever fires, the fire-path gate failed: a destructive control was clicked.
    document.getElementById('del').addEventListener('click', function () {
      fetch('/api/delete', { method: 'POST' }).catch(function () {});
    });
  </script>
</body></html>`;

function sendJson(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

// Boot on a caller-provided port (0 → ephemeral), bound to loopback. Resolves with the
// listening server; the server carries a `deleteHits()` accessor for the count of
// destructive POSTs it received.
export function start(port = 0) {
  let deleteHits = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }
    if (u.pathname === '/api/delete' && req.method === 'POST') {
      deleteHits++;
      return sendJson(res, 200, { deleted: true });
    }
    return sendJson(res, 404, { error: 'not found' });
  });
  server.deleteHits = () => deleteHits;
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
