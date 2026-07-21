// Fixture for the `-hidden` VISIBILITY state-class de-fragmentation (schemaVersion 9). AntD toggles
// `ant-dropdown-hidden` on a dropdown wrapper as it opens/shuts, so a control THROUGH that wrapper had two
// template selectors — `.ant-dropdown > … > button` and `.ant-dropdown.ant-dropdown-hidden > … > button` —
// and fragmented into two templates for one control (measured ALIAS_COLLISION 1092/1098↔1100/1108 on the
// live target). The structural `ant-dropdown` anchor is KEPT; only the `-hidden` state suffix is stripped.
//
//   "Copy link" — a button inside a `div.ant-dropdown` wrapper, carrying NO stable id, so its template
//                 selector is the STRUCTURAL path through the wrapper (an id would anchor it and hide the
//                 bug). The wrapper stays VISIBLE in both states (the class is a marker, not display:none)
//                 so both snapshots capture the control and the fragmentation is purely the class.
//   #toggle     — adds `ant-dropdown-hidden` to the wrapper (what AntD leaves when the dropdown shuts), with
//                 NO other structural change, so a second snapshot exercises exactly the state-class flip.
import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>dropdown-hidden fixture</title></head>
<body>
  <main><section><div class="ant-dropdown"><ul class="ant-dropdown-menu"><li class="ant-dropdown-menu-item"><button type="button">Copy link</button></li></ul></div></section></main>
  <button id="toggle" type="button">Toggle</button>
  <script>
    document.getElementById('toggle').addEventListener('click', function () {
      // Exactly what AntD leaves when the dropdown shuts: the base class stays, the state suffix is added.
      document.querySelector('div.ant-dropdown').classList.add('ant-dropdown-hidden');
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
