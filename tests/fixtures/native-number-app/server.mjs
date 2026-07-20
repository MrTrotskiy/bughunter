// Minimal fixture for the NATIVE-SHAPE-FILL drain proof (SHOULD FIX 1). A single native
// `input[type=number]` in isolation, so the stateful loop reaches and drains its battery in a handful of
// steps rather than grinding a ten-control page — the test proves the DRAIN, not the crawler's ordering.
//
//   #amount — a native numeric input. The browser REFUSES a wrong-shape fill at fill time
//             (handle.fill('not-a-number') → "Malformed value"), so the type is enforced by construction:
//             the fill-invalid probe records NOT_FILLABLE (terminal) and drains, instead of the transient
//             ACT_FAILED that left it owed forever. A valid numeric fill-valid probe fills without a request
//             (the field has no commit handler), which is enough to record the row and reach the shape probe.
import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Native number fixture</title></head>
<body>
  <form id="f" onsubmit="return false">
    <label for="amount">Amount</label>
    <input id="amount" type="number" placeholder="Amount">
    <button id="save" type="button">Save</button>
  </form>
  <script>
    // A harmless commit so the loop has a second control and the page is not a single dead field.
    document.getElementById('save').addEventListener('click', function () {
      fetch('/api/save', { method: 'POST' }).catch(function(){});
    });
  </script>
</body></html>`;

export async function start(port = 0) {
  let saves = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/save') { saves++; res.writeHead(200).end('{}'); return; }
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE); return; }
    res.writeHead(404).end();
  });
  server.saveHits = () => saves;
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return server;
}
