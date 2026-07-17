// Zero-dep fixture for the WEBSOCKET causal-attribution hole (the live-session pivot's
// proof-or-kill, decisions.md 2026-07-16 "Live-session unified-connectome pivot: NO-GO").
// It models the ONE traffic class no other fixture has: a fetch rooted in a persistent
// WebSocket's onmessage handler, NOT a timer and NOT the parser — the exact shape
// classifyInitiator cannot reject (it only rejects timer/parser roots), so on a REUSED page
// with no re-nav a WS-driven fetch ticking inside a control's causal window inherits that
// control's cause token AND survives the initiator filter = a phantom causal edge.
//   - #a click        -> GET /api/a          (foreground / caused; fast)
//   - #b click        -> GET /api/b          (foreground / caused; responds SLOWLY ~600ms so
//                        #b's causal window stays open past a WS tick)
//   - WS onmessage    -> GET /api/ws-driven  (server pushes a frame every ~80ms; the handler
//                        fires this fetch — the adversarial in-window request under cause #b)
//
// The WebSocket server is hand-rolled (no `ws` dependency): RFC6455 handshake + unmasked
// server->client text frames (payload < 126 bytes). Incoming client frames are ignored (the
// browser only ever needs to RECEIVE here); the push interval is cleared on socket close.

import http from 'node:http';
import crypto from 'node:crypto';

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>WS cross-act fixture</title></head>
<body>
  <h1>WebSocket cross-act demo</h1>
  <button id="a" type="button">Load A</button>
  <button id="b" type="button">Load B</button>
  <script>
    // A persistent WebSocket whose onmessage handler fires a fetch — NOT a timer, NOT the
    // parser. This is the initiator classifier's blind spot.
    var ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/feed');
    ws.addEventListener('message', function () { fetch('/api/ws-driven').catch(function () {}); });
    document.getElementById('a').addEventListener('click', function () { fetch('/api/a').catch(function () {}); });
    document.getElementById('b').addEventListener('click', function () { fetch('/api/b').catch(function () {}); });
  </script>
</body></html>`;

function sendJson(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

// Encode one unmasked server->client TEXT frame (FIN=1, opcode=0x1). Payload kept < 126 bytes
// so the length fits the single-byte form — enough for a tiny "tick" push.
function wsTextFrame(text) {
  const payload = Buffer.from(String(text));
  return Buffer.concat([Buffer.from([0x81, payload.length]), payload]);
}

export function start(port = 0) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(PAGE);
    }
    if (u.pathname === '/api/a') return sendJson(res, 200, { ok: true });
    if (u.pathname === '/api/ws-driven') return sendJson(res, 200, { ok: true });
    // #b responds slowly, holding its causal window open so a WS tick is guaranteed to land inside it.
    if (u.pathname === '/api/b') return setTimeout(() => sendJson(res, 200, { ok: true }), 600);
    return sendJson(res, 404, { error: 'not found' });
  });

  // RFC6455 upgrade: complete the handshake, then push a text frame every ~80ms so a message
  // deterministically dispatches inside #b's ~600ms causal window.
  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if (!key) return socket.destroy();
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    );
    const iv = setInterval(() => {
      try { socket.write(wsTextFrame('tick')); } catch { clearInterval(iv); }
    }, 80);
    socket.on('data', () => {}); // ignore client frames (masked close/ping) — we only push
    socket.on('close', () => clearInterval(iv));
    socket.on('error', () => clearInterval(iv));
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
