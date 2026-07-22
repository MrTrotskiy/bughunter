// RECALL FIXTURE server — HTTP glue only. Serves the pages (rendered from CASES), the API
// (handlers.mjs, with server-side effect counters), and the self-emitted GET /__manifest__ (the
// known denominator). /__manifest__ is UNLINKED — no <a href> to it and not a page route — so the
// crawler's a[href]-driven route frontier can never enqueue it; a live test asserts the graph
// never visited it (the ground-truth channel is provably absent from the crawl).
//
// server.effects() exposes the counters as the recall scorer's non-vacuous ground truth.

import http from 'node:http';
import { CASES } from './cases.mjs';
import { pageHtml } from './render-page.mjs';
import { manifestOf } from './manifest.mjs';
import { makeHandlers } from './handlers.mjs';

// A concrete detail path (/contacts/1) serves its base section's page (/contacts) so the
// route-transition lands on real content rather than a 404.
function pageRouteFor(pathname, routes) {
  if (routes.includes(pathname)) return pathname;
  const parent = '/' + pathname.split('/').filter(Boolean)[0];
  return routes.includes(parent) ? parent : '/';
}

export function start(port = 0) {
  const { handle, effects } = makeHandlers();
  const routes = [...new Set(CASES.map((c) => c.route))];

  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');

    if (u.pathname === '/__manifest__') {
      const s = JSON.stringify(manifestOf(CASES));
      res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
      return res.end(s);
    }
    if (u.pathname.startsWith('/api/')) {
      if (handle(req, u.pathname, res)) return;
      res.writeHead(404, { 'content-type': 'application/json' });
      return res.end('{"error":"no route"}');
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(pageHtml(pageRouteFor(u.pathname, routes), CASES));
  });

  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    server.effects = effects;
    resolve(server);
  }));
}
