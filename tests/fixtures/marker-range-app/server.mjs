// Fixture for the OWNERSHIP-MARKER-BREAKS-SHAPED-INPUT proof. The run's invisible ownership marker
// (hunt-gate.invisibleMark — a zero-width unicode run) is appended to every self-fill under explore-all.
// Appended to a value the browser parses BY TYPE — `"0"` into an `input[type=range]` — the result is no
// longer a valid value for that type, so `handle.fill` throws "Malformed value" and the fill-valid probe
// fails on a purely cosmetic marker (measured: every malformed-fill failure in the trails was a shaped
// field carrying the mark). The fix skips stamping shaped types; this fixture lets a live crawl prove the
// probe now DRAINS.
//
//   #vol  — a native `input[type=range]`. Its fill-valid probe is a valid numeric ("0"/min). With the
//           marker appended it malforms; without it, the fill lands.
//   #note — a plain text input, present so the SAME run proves the marker is still applied where it BELONGS
//           (text has room for an invisible mark; a range does not). The commit echoes #note's value back
//           so the test can read whether the mark survived onto text.
import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Marker range fixture</title></head>
<body>
  <form id="f" onsubmit="return false">
    <label for="vol">Volume</label>
    <input id="vol" type="range" min="0" max="100">
    <label for="note">Note</label>
    <input id="note" type="text" placeholder="Note">
    <button id="save" type="button">Save</button>
  </form>
  <script>
    document.getElementById('save').addEventListener('click', function () {
      var note = document.getElementById('note').value;
      // Echo the text value (with any invisible mark) back to the server, URL-encoded so zero-width
      // characters survive transport intact.
      fetch('/api/save?note=' + encodeURIComponent(note), { method: 'POST' }).catch(function(){});
    });
  </script>
</body></html>`;

export async function start(port = 0) {
  const notes = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (url.pathname === '/api/save') { notes.push(url.searchParams.get('note') || ''); res.writeHead(200).end('{}'); return; }
    if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(PAGE); return; }
    res.writeHead(404).end();
  });
  server.notes = () => notes.slice();
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  return server;
}
