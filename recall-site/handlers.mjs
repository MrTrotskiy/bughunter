// Projection (d): the endpoint table + server-side effect counters — the NON-VACUOUS ground
// truth (the hunt-social-app createHits/deleteHits pattern). Each planted control that fires a
// request bumps its named counter; a danger control's counter is the proof the crawler DECLINED
// (it should stay 0). effects() returns a snapshot the recall scorer reads after the crawl.

import { CASES } from './cases.mjs';

// Segment-align a concrete pathname against a declared pattern (a ':seg' matches any one segment),
// so DELETE /api/contacts/1 matches the declared /api/contacts/:id.
function segMatch(pattern, pathname) {
  const p = pattern.split('/').filter(Boolean);
  const a = pathname.split('/').filter(Boolean);
  if (p.length !== a.length) return false;
  return p.every((seg, i) => seg.startsWith(':') || seg === a[i]);
}

function json(res, code, body) {
  const s = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(s) });
  res.end(s);
}

export function makeHandlers() {
  const table = CASES.filter((c) => c.endpoint).map((c) => ({ ...c.endpoint }));
  const counters = {};
  for (const e of table) counters[e.effect] = 0;

  // Returns true iff the request matched a declared endpoint (and was counted + answered).
  function handle(req, pathname, res) {
    const e = table.find((x) => x.method === req.method && segMatch(x.pattern, pathname));
    if (!e) return false;
    counters[e.effect] += 1;
    json(res, 200, { ok: true });
    return true;
  }

  return { handle, effects: () => ({ ...counters }) };
}
