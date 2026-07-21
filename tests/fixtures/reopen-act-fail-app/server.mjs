// Fixture for L1 — the reveal-replay outcome carried INLINE on a recovery act.failed row. It reproduces the
// confusing reopen{ok:true}→act.failed pair the relocation memo documents: a container REOPENS successfully
// (the target resolves) yet the act inside it STILL fails.
//
//   #open  — an opener. Clicking it reveals the panel (and, with it, an overlay that covers the target).
//   #deep  — the target, inside the panel. It is display:none at baseline (so it does NOT resolve live and
//            recoverGated is the only path that reaches it), becomes VISIBLE when the panel opens (so the
//            reopen resolves it → REOPEN_OK), but the panel's #cover overlay intercepts pointer events, so
//            the recovery act's click on #deep times out → ACT_FAILED. The reopen therefore succeeded and the
//            act failed anyway — exactly the pair the inline `revealReplay` field exists to make legible.
import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>reopen-act-fail fixture</title></head>
<body>
  <button id="open" type="button">Open Panel</button>
  <div id="panel" style="display:none; position:relative">
    <button id="deep" type="button">Deep Control</button>
    <div id="cover" style="position:fixed; inset:0; z-index:9999; background:rgba(0,0,0,0.01)"></div>
  </div>
  <script>
    document.getElementById('open').addEventListener('click', function () {
      // Reveal the panel — the target becomes visible, AND the overlay that will intercept its click appears.
      document.getElementById('panel').style.display = 'block';
    });
  </script>
</body></html>`;

export async function start(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE); return; }
    res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return server;
}
