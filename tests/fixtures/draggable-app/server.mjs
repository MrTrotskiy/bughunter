// Fixture for the TRANSIENT `-dragged` state-class de-fragmentation (the ALIAS_COLLISION denominator fix).
// react-draggable adds `react-draggable-dragged` to its wrapper AFTER the element is first dragged (and
// `react-draggable-dragging` DURING a drag). Before the fix, `div.react-draggable > button` and
// `div.react-draggable.react-draggable-dragged > button` are TWO template selectors for ONE control, so a
// draggable button fragments into two templates across a drag — the phantom-denominator + ALIAS_COLLISION
// class measured on the live target.
//
//   "Move me" — a button inside a `div.react-draggable` wrapper. It carries NO stable id, so its template
//               selector is the STRUCTURAL path THROUGH the wrapper (`div.react-draggable > button`) — the
//               positional/class case that fragmented live. An id would anchor the selector and hide the bug.
//   #drag     — flips the wrapper to carry `react-draggable-dragged` (what a real drag would leave behind),
//               with NO other structural change, so a second snapshot exercises exactly the state-class flip.
import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Draggable fixture</title></head>
<body>
  <main><section><div class="react-draggable"><button type="button">Move me</button></div></section></main>
  <button id="drag" type="button">Simulate drag</button>
  <script>
    document.getElementById('drag').addEventListener('click', function () {
      // Exactly what react-draggable leaves after a drag: the base class stays, the state suffix is added.
      document.querySelector('div.react-draggable').classList.add('react-draggable-dragged');
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
