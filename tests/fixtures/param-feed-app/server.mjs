// Zero-dep fixture for GOAL 2 — param-instance harvest (collect the dark `:param` patterns). A multi-route
// feed whose OWN JS bundle declares a React-Router `path:"/nugget/:id"` (so the route-manifest seeds the
// `:param` pattern into the denominator), a home feed of `<a href="/nugget/K">` rows (the FALLBACK content-
// derived id source), and a real `/nugget/N` detail page rendering its OWN content (an h1 + a control), so a
// GENUINELY-visited concrete instance flips the pattern from 0-collected to collected-via-representative.
//
// Expected: the manifest seeds `/nugget/:id` (param-pattern) + `/feed` (static). harvestRoutes on `/` finds
// the N `<a href=/nugget/K>`; the FIRST concrete (/nugget/1) is enqueued + `tagParamInstance` links it to
// `/nugget/:id`; the rest fold as census siblings of /nugget/1 (ONE visit, not N). visitRoute collects
// /nugget/1 (own content). route-coverage: `/nugget/:id` paramCollected via /nugget/1, siblings folded.

import http from 'node:http';

const BUNDLE = `
// minified-ish router config the extractor regexes (path:"..." keys only)
// NOTE: /user/settings is a DECLARED STATIC that shares /user/:handle's shape (React-Router ranks static
// above dynamic) — it must stay its OWN section, never be tagged a param proxy (the denominator-collapse guard).
var routes=[{path:"/feed",el:F},{path:"/nugget/:id",el:N},{path:"/user/:handle",el:U},{path:"/user/settings",el:S}];
`;

function homeHtml(n) {
  const rows = [];
  for (let i = 1; i <= n; i++) rows.push(`<li><a href="/nugget/${i}">Nugget ${i}</a></li>`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Param feed</title><script src="/app.js"></script></head>
<body>
  <h1>Feed</h1>
  <nav><a href="/feed">Feed</a> <a href="/user/alice">Alice</a> <a href="/user/bob">Bob</a> <a href="/user/settings">Settings</a></nav>
  <ul>${rows.join('')}</ul>
</body></html>`;
}

function nuggetHtml(id) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Nugget ${id}</title></head>
<body>
  <article class="nugget"><h1>Nugget ${id}</h1>
    <button id="fav-${id}" type="button">Favorite</button>
    <button id="share-${id}" type="button">Share</button>
  </article>
</body></html>`;
}

const staticHtml = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${title}</title></head>
<body><h1>${title}</h1>${body}</body></html>`;

export function start(port = 0, { rows = 5 } = {}) {
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://127.0.0.1');
    const p = u.pathname;
    if (p === '/app.js') {
      res.writeHead(200, { 'content-type': 'application/javascript' });
      return res.end(BUNDLE);
    }
    if (p === '/' || p === '') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(homeHtml(rows));
    }
    if (p === '/feed') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(staticHtml('Feed', '<button id="refresh" type="button">Refresh</button>'));
    }
    const m = p.match(/^\/nugget\/(\d+)$/);
    if (m) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(nuggetHtml(m[1]));
    }
    // STRING-keyed param (/user/:handle → /user/alice): toUrlPattern does NOT mask a word segment, so this
    // proves the STRUCTURAL matchParamPattern (segment-align), not pattern-equality, links a string-keyed concrete.
    const um = p.match(/^\/user\/([a-z]+)$/i);
    if (um) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(staticHtml(`User ${um[1]}`, `<button id="follow-${um[1]}" type="button">Follow</button>`));
    }
    // Everything else (incl. the literal /nugget/:id and /user/:handle patterns, which must NEVER be
    // navigated) 404s — proving the pattern node is seeded for the DENOMINATOR but visited only via a concrete.
    res.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(staticHtml('Not found', '<p>404</p>'));
  });
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
