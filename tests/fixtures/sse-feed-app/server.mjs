// Zero-dep fixture for the SERVER-SENT-EVENTS (EventSource) causal-attribution hole — the
// documented SYMMETRIC follow-up to the WebSocket hole (decisions.md 2026-07-16 "HONEST RESIDUAL:
// SSE has the same shape and is NOT yet covered"). It models the ONE traffic class the WS fixture's
// sibling does for sockets: a fetch rooted in a persistent EventSource message handler, NOT a timer
// and NOT the parser — the exact shape classifyInitiator cannot reject (it only rejects timer/parser
// roots), so on a REUSED page with no re-nav an SSE-driven fetch ticking inside a control's causal
// window inherits that control's cause token AND survives the initiator filter = a phantom edge.
//
//   - #b click            -> GET /api/b                 (foreground / caused; responds SLOWLY ~600ms
//                            so #b's causal window stays open past several SSE ticks)
//   - SSE unnamed event   -> GET /api/sse-driven        (an addEventListener('message') handler; the
//                            server pushes a bare `data:` frame every ~80ms)
//   - SSE NAMED event     -> GET /api/sse-driven-named  (an addEventListener('feed') handler; the
//                            server pushes an `event: feed` frame every ~80ms)
//
// The NAMED path is the SSE-specific case a naive 'message'-only wrap would MISS: per WHATWG HTML
// "server-sent events" / MDN EventSource, a server event carrying an `event:` field dispatches to a
// NAMED listener, not to 'message'. Both handlers tick adversarially inside any measured window.

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>SSE cross-act fixture</title></head>
<body>
  <h1>EventSource cross-act demo</h1>
  <button id="b" type="button">Load B</button>
  <script>
    // A persistent EventSource whose handlers fire a fetch — NOT a timer, NOT the parser. This is
    // the initiator classifier's blind spot, identical in shape to the WebSocket onmessage hole.
    var es = new EventSource('/feed');
    // Unnamed events dispatch to 'message'.
    es.addEventListener('message', function () { fetch('/api/sse-driven').catch(function () {}); });
    // NAMED events (server frame carries "event: feed") dispatch to the NAMED listener, never 'message'.
    es.addEventListener('feed', function () { fetch('/api/sse-driven-named').catch(function () {}); });
    document.getElementById('b').addEventListener('click', function () { fetch('/api/b').catch(function () {}); });
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
    if (u.pathname === '/feed') {
      // Open-ended SSE stream: push an unnamed frame AND a named "feed" frame every ~80ms, so both
      // the 'message' and the 'feed' handlers deterministically dispatch inside #b's ~600ms window.
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      const iv = setInterval(() => {
        try {
          res.write('data: tick\n\n');
          res.write('event: feed\ndata: tick\n\n');
        } catch { clearInterval(iv); }
      }, 80);
      req.on('close', () => clearInterval(iv));
      return undefined;
    }
    if (u.pathname === '/api/sse-driven') return sendJson(res, 200, { ok: true });
    if (u.pathname === '/api/sse-driven-named') return sendJson(res, 200, { ok: true });
    // #b responds slowly, holding its causal window open so SSE ticks are guaranteed to land inside it.
    if (u.pathname === '/api/b') return setTimeout(() => sendJson(res, 200, { ok: true }), 600);
    return sendJson(res, 404, { error: 'not found' });
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
