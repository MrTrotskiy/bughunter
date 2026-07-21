// Fixture for FIX 2 (stateful-loop.mjs recoverGated log defect): make reopenContainer THROW so the
// `reopen` trace event must carry the exception message instead of a bare REOPEN_THREW.
//
// A reopen's reload-replay rung navigates to the target's route with gotoGated → page.goto. This server
// serves the page HTML on the FIRST GET of '/' (the crawl's baseline), then answers every SUBSEQUENT GET
// of '/' with a `Content-Disposition: attachment` response — Chromium turns that top-level navigation into
// a DOWNLOAD and aborts the frame, so page.goto REJECTS ("net::ERR_ABORTED"). gotoGated propagates the
// rejection, walkAttempt does not catch it, and reopenContainer's try/finally lets it escape — exactly the
// mid-walk throw recoverGated used to swallow with `.catch(() => null)`.
//
// The page itself is inert (no scripts, no fetches), so the ONLY requests to '/' are navigations: the
// baseline (served HTML) and the reopen re-navigations (served the aborting attachment). No /api traffic.

import http from 'node:http';

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Reopen-throw fixture</title></head>
<body><h1>Reopen throw fixture</h1><p>Inert baseline page.</p></body></html>`;

export function start(port = 0) {
  let rootGets = 0;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    if (u.pathname === '/') {
      rootGets++;
      if (rootGets === 1) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        return res.end(PAGE);
      }
      // Every re-navigation aborts as a download → page.goto rejects → reopenContainer throws.
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-disposition': 'attachment; filename="abort.bin"',
      });
      return res.end('abort');
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => {
    server.rootGets = () => rootGets;
    resolve(server);
  }));
}
