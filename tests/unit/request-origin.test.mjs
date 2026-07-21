// Unit test for the REQUEST-ORIGIN evidence fields — the log defect that made the single largest
// failure class of a live run undiagnosable. A reference run (108 acts) refused 22 reveal paths with:
//
//   reveal step 76 fired a firewall-refused request POST /api/addview (off-origin)
//
// and NOTHING in the run could say which host that was: every request record carried only a
// path-shaped `urlPattern`, so aggregating all 18 captured requests yielded exactly one bucket,
// "path with no host". A genuine cross-subdomain call and a firewall misfire on the app's own
// origin are then indistinguishable — the log recorded the OUTCOME of a decision without the
// EVIDENCE the decision was made on, which this repo's log rule makes a defect to fix.
//
// Layer rule: pure/synthetic throughout. The ledger is driven by synthetic CDP params (its
// established pattern, see response-ledger.test.mjs) and the firewall handler by a fake
// page/route, so the real decision path runs with no browser.
//
// Guards: the origin + wall-clock timestamp on a captured request record; `urlPattern` staying
//   byte-identical for the same input (it is the census/dedup key, ADDED-to, never replaced);
//   and the firewall refusal message naming the refused origin AND the page origin it was
//   judged against.
// FAIL-ON-REVERT (host): drop the `origin: originOf(url)` field from the ledger entry in
//   response-ledger.mjs onRequest → "the captured request record must name the HOST" fails.
// FAIL-ON-REVERT (timestamp): drop `startedAt` from the ledger entry (or return it as the
//   monotonic `startTs`) → "the captured request record must carry a wall-clock timestamp" fails.
// FAIL-ON-REVERT (message): revert describeBlock to the bare `(${b.reason})` form in
//   reveal-firewall.mjs → "the refusal message must name the REFUSED ORIGIN" fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeLedgerTracker } from '../../lib/browser/response-ledger.mjs';
import { originOf } from '../../lib/browser/initiator.mjs';
import { toUrlPattern } from '../../lib/graph/graph-store.mjs';
import { makeFirewallHandler, describeBlock } from '../../lib/recon/reveal-firewall.mjs';

// A synthetic Network.requestWillBeSent carrying an ABSOLUTE url (CDP always reports absolute,
// even when the page passed fetch a relative string — the reason the host is knowable here at all).
const req = (requestId, method, url, { type = 'Fetch', timestamp = 1, wallTime } = {}) => ({
  requestId, request: { url, method }, initiator: { type: 'script' }, type, timestamp, wallTime,
});

test('a captured request record carries the HOST and a wall-clock timestamp', () => {
  const lt = makeLedgerTracker();
  lt.markCursor();
  // wallTime is CDP's seconds-since-epoch: 2026-07-20T00:00:00Z.
  lt.onRequest(req('1', 'POST', 'https://api.example.com/api/addview', { wallTime: 1784505600 }));

  const meta = lt.takeResponse('POST', '/api/addview');
  assert.ok(meta, 'the request is joined on its pathname as before');
  assert.equal(
    meta.origin, 'https://api.example.com',
    'the captured request record must name the HOST — a path-shaped pattern alone cannot say which origin was called',
  );
  assert.equal(
    meta.startedAt, 1784505600000,
    'the captured request record must carry a wall-clock timestamp (epoch ms), joinable against the trail`s own ts',
  );
});

test('startedAt is WALL-CLOCK, not the CDP monotonic timestamp used for durations', () => {
  const lt = makeLedgerTracker();
  lt.markCursor();
  // A monotonic `timestamp` of 10 is a plausible CDP domain time and an absurd epoch (1970).
  // Without wallTime the local clock stands in — never the monotonic reading.
  lt.onRequest(req('1', 'GET', 'https://app.example.com/api/me', { timestamp: 10 }));
  const meta = lt.takeResponse('GET', '/api/me');
  assert.notEqual(meta.startedAt, 10, 'the monotonic domain time is never passed off as a timestamp');
  assert.ok(meta.startedAt > 1600000000000, 'startedAt is epoch ms, so it orders against trail events');
});

test('urlPattern is UNCHANGED for the same input — the census key is added to, never replaced', () => {
  // The exact contract the 50-row listing depends on: same masking, same shape, same fold.
  assert.equal(toUrlPattern('https://api.example.com/api/addview'), '/api/addview');
  assert.equal(toUrlPattern('/api/item/42'), '/api/item/:param');
  assert.equal(toUrlPattern('/api/search?q=hello'), '/api/search?q=:param');
  // A 50-row listing still folds to ONE pattern while each row's origin is separately knowable.
  const patterns = new Set();
  for (let i = 1; i <= 50; i++) patterns.add(toUrlPattern(`https://app.example.com/item/${i}`));
  assert.equal(patterns.size, 1, 'a 50-row listing still folds to one urlPattern');
  // And the origin is NOT smuggled into the pattern — that would change the census key.
  assert.ok(!toUrlPattern('https://api.example.com/x').includes('example.com'), 'urlPattern stays host-less');
});

test('originOf refuses to invent a host for a relative or opaque url', () => {
  assert.equal(originOf('/api/addview'), null, 'a relative url has no knowable origin');
  assert.equal(originOf('data:text/plain,hi'), null, 'an opaque origin is null, not the string "null"');
  assert.equal(originOf('https://app.example.com:8443/x?y=1'), 'https://app.example.com:8443', 'scheme+host+port, no path or query');
});

// --- The refusal message: the one string an operator reads first. ----------------------------

// A fake page/route pair driving the REAL handler — no browser, no stub of the decision itself.
const fakeRoute = (method, url) => {
  const calls = [];
  return {
    calls,
    request: () => ({ method: () => method, url: () => url }),
    abort: async () => { calls.push('abort'); },
    continue: async () => { calls.push('continue'); },
  };
};

test('the firewall records BOTH origins its off-origin verdict was computed from', async () => {
  const blocked = [];
  const page = { url: () => 'https://app.example.com/app/feed' };
  const handler = makeFirewallHandler(page, new Set(), blocked);
  const route = fakeRoute('POST', 'https://api.example.com/api/addview');

  await handler(route);

  assert.deepEqual(route.calls, ['abort'], 'policy unchanged: the off-origin write is still aborted');
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].reason, 'off-origin', 'policy unchanged: still classified off-origin');
  assert.equal(blocked[0].hard, true, 'policy unchanged: a non-safe method is still HARD');
  assert.equal(blocked[0].urlPattern, '/api/addview', 'urlPattern unchanged');
  assert.equal(blocked[0].origin, 'https://api.example.com', 'the REFUSED origin is recorded');
  assert.equal(blocked[0].pageOrigin, 'https://app.example.com', 'the origin it was JUDGED AGAINST is recorded');
});

test('the refusal message names the refused origin and the page origin', () => {
  const msg = describeBlock({
    method: 'POST', urlPattern: '/api/addview', reason: 'off-origin',
    origin: 'https://api.example.com', pageOrigin: 'https://app.example.com', hard: true,
  });
  assert.ok(
    msg.includes('https://api.example.com'),
    'the refusal message must name the REFUSED ORIGIN — "(off-origin)" alone cannot tell a genuine cross-subdomain call from a firewall misfire',
  );
  assert.ok(msg.includes('https://app.example.com'), 'and the page origin the verdict was judged against');
  assert.ok(msg.startsWith('POST /api/addview'), 'the method + pattern still lead the message');
  // [L1] holds: an origin carries no query, so no secret-in-query can ride the message.
  assert.ok(!msg.includes('?'), 'no raw url / query string in the operator-facing message');
});

test('describeBlock degrades to the bare reason rather than inventing a host', () => {
  const msg = describeBlock({ method: 'POST', urlPattern: '/api/x', reason: 'write', hard: true });
  assert.equal(msg, 'POST /api/x (write)', 'an unknown origin is omitted, never fabricated');
});
