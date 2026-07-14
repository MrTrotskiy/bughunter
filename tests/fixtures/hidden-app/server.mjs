// Zero-dep fixture with one VISIBLE and one DOM-present-but-HIDDEN control, to prove the
// fire path fast-fails on an unclickable element instead of waiting the 30s Playwright
// actionability timeout. Real sites are full of these — responsive layouts keep a mobile
// menu in the DOM but display:none on desktop; recon discovers them, then must not hang.

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Hidden fixture</title></head>
<body>
  <h1>Hidden demo</h1>
  <button id="vis" type="button">Visible</button>
  <button id="hid" type="button" style="display:none">Hidden</button>
</body></html>`;

export function start(port = 0) {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(PAGE);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
