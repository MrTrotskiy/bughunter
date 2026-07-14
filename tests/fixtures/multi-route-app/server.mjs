// Fixture for multi-route recon + origin scoping. Two SERVERS on two ports (= two
// origins). The main app has:
//   /          — a same-origin nav link to /products AND an OFF-ORIGIN link to the second
//                server. The off-origin link is the trap: the fire path must REFUSE to
//                click it (clicking would navigate out of scope and hit the other server).
//   /products  — a control (Filter) that exists ONLY here, reachable only by first
//                navigating to /products. Proves the crawl visits more than one page and
//                attributes /products' controls to /products, not to /.
// The off-origin server counts every hit, so the test can assert it was NEVER reached.

import http from 'node:http';

const HOME = (externalOrigin) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Home</title></head>
<body>
  <h1>Home</h1>
  <a href="/products" id="nav-products">Products</a>
  <a href="${externalOrigin}/" id="ext-link">Partner site</a>
</body></html>`;

const PRODUCTS = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Products</title></head>
<body>
  <h1>Products</h1>
  <button id="filter" type="button">Filter results</button>
  <a href="/" id="home">Home</a>
</body></html>`;

export function start(port, { externalOrigin }) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (url.pathname === '/products') res.end(PRODUCTS);
    else res.end(HOME(externalOrigin));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}

// The off-origin server: minimal page + a hit counter the test asserts stays 0.
export function startExternal(port) {
  let hits = 0;
  const server = http.createServer((req, res) => {
    hits++;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body><h1>Partner</h1><button id="x">Go</button></body></html>');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    server.extHits = () => hits;
    resolve(server);
  }));
}
