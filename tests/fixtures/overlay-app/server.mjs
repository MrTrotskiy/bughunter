// Fixture for consent-overlay dismissal. A fixed, full-viewport consent banner (high
// z-index) covers the page and INTERCEPTS pointer events, so the underlying control's
// click is blocked until the banner is gone — exactly what a real cookie wall does. The
// accept button uses a known consent-framework id (OneTrust) so the curated dismiss finds
// it; clicking it removes the banner. The underlying #target fires GET /api/thing, so the
// test can assert the control became reachable (its causal request fired) only after the
// overlay was cleared.

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Overlay</title></head>
<body>
  <h1>Overlay demo</h1>
  <button id="target" type="button" onclick="fetch('/api/thing')">Do thing</button>
  <div id="cookie-banner" style="position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center">
    <div>
      <p style="color:#fff">We use cookies.</p>
      <button id="onetrust-accept-btn-handler" type="button"
        onclick="document.getElementById('cookie-banner').remove()">Accept all</button>
    </div>
  </div>
</body></html>`;

// A page with an accept-TEXT button ("OK") that is NOT inside any consent-scoped
// container — the dismiss must LEAVE IT ALONE (false-positive guard). Only a consent-
// scoped accept-text button may be clicked by the text fallback.
const PLAIN = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Plain</title></head>
<body><h1>Plain</h1><button id="ok" type="button">OK</button></body></html>`;

export function start(port = 0) {
  let thingHits = 0;
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/api/thing') {
      thingHits++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(url.pathname === '/plain' ? PLAIN : PAGE);
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    server.thingHits = () => thingHits;
    resolve(server);
  }));
}
