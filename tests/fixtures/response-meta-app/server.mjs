// Zero-dep fixture for RESPONSE-METADATA and BODY capture. It models the real traffic classes
// plus the shapes the metadata-join and body-capture tests need:
//   - GET  /api/config  fired once on load                         → LOAD-BURST (uncredited)
//   - GET  /api/poll    a 250ms setInterval                        → BACKGROUND (uncredited)
//   - POST /api/create  clicked by #create; responds SLOWLY (~600ms) with 201, so the poll
//                       DETERMINISTICALLY ticks inside its causal window (the invariant is
//                       stressed WITH response-capture on) and its status is assertable
//   - GET  /api/seq?n=1|2  clicked by #twice, fired back-to-back; the status is keyed to the
//                       `n` query so it is deterministic regardless of server arrival order,
//                       while both share pathname /api/seq — this exercises the ORDERED
//                       takeResponse join (first fire ↔ first response) on one path.
//   - POST /api/secret clicked by #secret; a JSON REQUEST body carrying a password and a JSON
//                       RESPONSE body carrying a token/JWT, and SLOW (~600ms) so the poll ticks
//                       inside its window — proves redacted bodies attach to the kept fire only
//                       (invariant re-proven WITH body capture on).
//   - GET  /api/html   clicked by #html; a text/html response with a secret — OFF the allowlist,
//                       so NO body is captured (the content-type gate).

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Response-meta fixture</title></head>
<body>
  <h1>Response metadata demo</h1>
  <button id="create" type="button">Create thing</button>
  <button id="twice" type="button">Fire twice</button>
  <button id="secret" type="button">Reveal secret</button>
  <button id="html" type="button">Load html</button>
  <script>
    // LOAD-BURST: page-load fetch (cause is '__idle__') — must stay uncredited.
    fetch('/api/config').catch(function () {});
    // BACKGROUND: a setInterval-rooted poll — the initiator classifier must reject it even
    // when it ticks inside a control's causal window (proven WITH response-capture on).
    setInterval(function () { fetch('/api/poll').catch(function () {}); }, 250);
    // CAUSED: a slow POST returning 201 — its response status/type is joined to the fire.
    document.getElementById('create').addEventListener('click', function () {
      fetch('/api/create', { method: 'POST' }).catch(function () {});
    });
    // CAUSED x2 on ONE path, fired synchronously (both in flight at once so the window never
    // sees inflight===0 between them). The n= query fixes each response status deterministically.
    document.getElementById('twice').addEventListener('click', function () {
      fetch('/api/seq?n=1').catch(function () {});
      fetch('/api/seq?n=2').catch(function () {});
    });
    // CAUSED with BODIES: a JSON request body (password) + a JSON response body (token/JWT),
    // slow so the poll ticks inside — the redacted bodies must attach to THIS fire only.
    document.getElementById('secret').addEventListener('click', function () {
      fetch('/api/secret', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'neo', password: 'trinity123' }),
      }).catch(function () {});
    });
    // CAUSED, OFF-ALLOWLIST: a text/html response — its body must NOT be captured.
    document.getElementById('html').addEventListener('click', function () {
      fetch('/api/html').catch(function () {});
    });
  </script>
</body></html>`;

function sendJson(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

export function start(port = 0) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }
    if (u.pathname === '/api/config') return sendJson(res, 200, { ok: true });
    if (u.pathname === '/api/poll') return sendJson(res, 200, { t: Date.now() });
    // Slow 201 so the 250ms poll ticks inside #create's causal window (deterministic).
    if (u.pathname === '/api/create') return setTimeout(() => sendJson(res, 201, { created: true }), 600);
    // Status keyed to n= so it is stable no matter which of the two concurrent requests the
    // server happens to receive first; both share pathname /api/seq for the ordered join.
    if (u.pathname === '/api/seq') {
      const n = u.searchParams.get('n');
      return sendJson(res, n === '1' ? 201 : 202, { n });
    }
    // Slow 200 with a JSON response body carrying a JWT under a NON-SECRET key `data` (so the
    // test exercises VALUE-level detection, not just key-match) + real fields; the request also
    // carried a JSON body with a password (key-level). Redaction must strip both secrets.
    if (u.pathname === '/api/secret') {
      return setTimeout(() => sendJson(res, 200, {
        user: 'neo', items: [1, 2, 3],
        data: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJuZW8ifQ.s3cr3tSignatureValue',
      }), 600);
    }
    // A plain foreground endpoint with a JSON body — used by the two-pass endCause test as the
    // "lead" fire whose response-body await must NOT be allowed to reopen the kept-set decision.
    if (u.pathname === '/api/lead') return sendJson(res, 200, { lead: true });
    // text/html response WITH a secret — OFF the allowlist, so body capture must skip it.
    if (u.pathname === '/api/html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end('<!doctype html><p>token=eyJhbGciOi.secretpart.sig</p>');
    }
    return sendJson(res, 404, { error: 'not found' });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
