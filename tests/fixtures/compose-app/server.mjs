// Zero-dep fixture for the COMMUNICATION hard-refusal. Initiating a real-time call is an IRREVERSIBLE
// OUTWARD side-effect — a WebRTC negotiation rings a real person — so unlike an ordinary write there is
// nothing downstream that could undo it after the fact. `communication` therefore sits in the always-
// consulted REFUSED set and the CLICK path must refuse it BEFORE the request leaves the browser.
//
//   - GET  /api/init          one fetch on load                       → LOAD BURST (token-excluded).
//   - #video-call "Video Call"    the CONTROL UNDER TEST. On click it would POST /api/call/start (a real
//                                 call). It must be HARD-refused (dangerFloor 'communication' ∈ REFUSED);
//                                 `callHits()` is the server-side ground truth that it never fired.
//   - #create-post "Create post"  a mutation-NAMED opener that fires POST /api/draft and reveals a composer
//                                 modal in #slot (pure DOM), whose child #post-submit "Post" fires
//                                 POST /api/createpost. Non-trivial write-shaped surface around the control
//                                 under test; nothing here asserts on it.
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

    // A mutation-NAMED opener: fires a draft-create write AND reveals the composer modal.
    document.getElementById('create-post').addEventListener('click', function () {
      fetch('/api/draft', { method: 'POST' }).catch(function () {});
      fetch('/api/follow?id=1').catch(function () {});
      var slot = document.getElementById('slot');
      slot.innerHTML = '<div class="composer">'
        + '<textarea id="composer-text" placeholder="Share something"></textarea>'
        + '<button id="post-submit" type="button">Post</button>'
        + '</div>';
      document.getElementById('post-submit').addEventListener('click', function () {
        fetch('/api/createpost', { method: 'POST' }).catch(function () {});
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
  // SERVER-SIDE GROUND TRUTH for the communication refusal: a click that got through would land here.
  // Asserting on the server (not on the client's promise) is what makes the guard non-vacuous.
  let callStarts = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(PAGE);
      return;
    }
    if (url.pathname === '/api/call/start') { callStarts++; sendJson(res, 200, { ok: true }); return; }
    if (url.pathname.startsWith('/api/')) { sendJson(res, 200, { ok: true, path: url.pathname }); return; }
    sendJson(res, 404, { ok: false });
  });
  server.callHits = () => callStarts;
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  start(3500).then((s) => process.stdout.write(JSON.stringify({ ok: true, port: s.address().port }) + '\n'));
}
