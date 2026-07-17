// Zero-dep fixture for the REVEAL-OPENER read (collect a compose UI without committing a write) + the
// COMMUNICATION hard-refusal. The gap it models: on a live authed app the read-only crawl name-refuses a
// mutation-NAMED control ("Create post") BEFORE the click, so the composer modal it would open is never
// collected. The fix lets the AGENT judge such a control a form-opener (--reveal-opener) → the click is
// allowed, the revealed modal is collected, and the network write-firewall stays the HARD net that ABORTS
// any actual write the click fires. Separately, initiating a real-time call ("Video Call") is an
// irreversible OUTWARD side-effect off the abortable HTTP layer — it must stay hard-refused even under
// --reveal-opener.
//
//   - GET  /api/init          one fetch on load                       → LOAD BURST (token-excluded).
//   - #create-post "Create post"  a mutation-NAMED opener. On click it BOTH fires POST /api/draft (a
//                                 draft-create WRITE — the firewall must ABORT it) AND reveals the composer
//                                 modal in #slot (pure DOM). So: reveal-opener collects the modal; the net
//                                 prevents the server side-effect. Its revealed child #post-submit "Post"
//                                 fires POST /api/createpost — also a write, never acted here.
//   - #video-call "Video Call"    a COMMUNICATION control. On click it would POST /api/call/start (a real
//                                 call). It must be HARD-refused (dangerFloor 'communication' ∈ REFUSED),
//                                 NOT exempted by --reveal-opener.
//   - #refresh "Refresh feed"     a safe baseline read (GET /api/feed). Present so the baseline is non-trivial.

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Compose fixture</title></head>
<body>
  <main>
    <button id="create-post" type="button">Create post</button>
    <button id="video-call" type="button">Video Call</button>
    <button id="refresh" type="button">Refresh feed</button>
    <div id="slot"></div>
  </main>
  <script>
    fetch('/api/init').catch(function () {});

    document.getElementById('refresh').addEventListener('click', function () {
      fetch('/api/feed').catch(function () {});   // GET read — continued
    });

    // A mutation-NAMED opener: fires a draft-create WRITE (firewall aborts) AND reveals the composer.
    // It ALSO fires an RPC-over-GET mutation (a legacy /follow over GET) — the write-firewall nets non-GET
    // only, so this GET-commit must be caught by the reveal-opener strict-GET gate (security review H1).
    document.getElementById('create-post').addEventListener('click', function () {
      fetch('/api/draft', { method: 'POST' }).catch(function () {}); // WRITE — must be aborted by the firewall
      fetch('/api/follow?id=1').catch(function () {});               // RPC-over-GET mutation — strict-GET aborts it (H1)
      var slot = document.getElementById('slot');
      slot.innerHTML = '<div class="composer">'
        + '<textarea id="composer-text" placeholder="Share something"></textarea>'
        + '<button id="post-submit" type="button">Post</button>'
        + '</div>';
      document.getElementById('post-submit').addEventListener('click', function () {
        fetch('/api/createpost', { method: 'POST' }).catch(function () {}); // the SUBMIT write (never acted)
      });
    });

    // A COMMUNICATION side-effect: initiating a real call. Must be hard-refused (never fires).
    document.getElementById('video-call').addEventListener('click', function () {
      fetch('/api/call/start', { method: 'POST' }).catch(function () {});
    });
  </script>
</body></html>`;

function sendJson(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

export function start(port = 0) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE);
      return;
    }
    if (url.pathname.startsWith('/api/')) { sendJson(res, 200, { ok: true, path: url.pathname }); return; }
    sendJson(res, 404, { ok: false });
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  start(3500).then((s) => process.stdout.write(JSON.stringify({ ok: true, port: s.address().port }) + '\n'));
}
