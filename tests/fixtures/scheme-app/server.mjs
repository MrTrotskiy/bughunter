// Fixture for the off-origin scheme gate. A `javascript:` anchor is the classic
// button-as-anchor idiom — extremely common on real sites. Its resolved href has an
// OPAQUE origin, so a naive "not same-origin → external" test would wrongly drop it as an
// off-origin link and never fire it (inflating coverage with a control never exercised).
// The fire path must fall through and click it like any in-page control.

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Scheme</title></head>
<body>
  <h1>Scheme demo</h1>
  <a href="javascript:void(0)" id="js">JS action</a>
  <button id="plain" type="button">Plain</button>
</body></html>`;

export function start(port = 0) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
