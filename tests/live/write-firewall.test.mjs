// Live proof of the Layer-3 replay-time WRITE-FIREWALL (docs/PHASE1-COLLECTION-PLAN.md §Layer 3): a
// reveal-path opener re-clicked during replay runs under __idle__, which drops the causal EDGE but
// NOT the outbound network request — so a non-GET fired by that click (an adaptive swap, or an extra
// analytics-beacon mutation the record-time act never recorded) would still HIT the live authed
// account. The firewall (page.route, active ONLY during replay) aborts any non-GET outside the
// opener's OWN recorded reads, so a mocked write makes the reveal fail honestly → the target ends
// unreachable, the account UNMUTATED. Driven directly through replayRevealPath with hand-built graphs
// (the deterministic way to model "the replay fires a write the recorded triggers do NOT allowlist" —
// the same adaptive-server style the stay-on-page safety-branch test uses).
//
// Guards:
//   (1) BLOCK THE WRITE — replaying #open-danger (fires GET /api/safe + allowlisted POST /api/list +
//       NON-allowlisted POST /api/track) ABORTS /api/track (trackHits stays 0 — account unmutated) and
//       the reveal fails honestly with REVEAL_WRITE_BLOCKED.
//   (2) DO NOT BREAK REACH — the SAFE GET and the ALLOWLISTED read-POST are NOT aborted (safeHits +
//       listHits both grow), and replaying an all-allowed opener (#open-safe) COMPLETES and reveals
//       its child. A too-aggressive firewall would red these.
//   (3) H1 SYMMETRIC CANON — #open-h1 fires POST /api/item?_method=DELETE; its PATHNAME collides with the
//       allowlisted read POST /api/item, but under FULL-url canon it is /api/item?_method=:param → NOT
//       allowlisted → ABORTED (itemWriteHits stays 0). Pathname-only canon would smuggle the DELETE through.
//   (4) M2 SAFE METHODS ARE NOT EXEMPT — #open-logout fires fetch('/logout'), a SAFE GET; the danger-route
//       guard ABORTS it (logoutHits stays 0) so a replay can never self-logout, even on a GET.
//   (5) L2 NON-POST NEVER ALLOWLISTED — a recorded DELETE /api/item (#open-delete) is never re-firable
//       (only read-over-POST is) → ABORTED (itemWriteHits stays 0).
//   (6) SOFT-BLOCK OFF-ORIGIN READ — a benign off-origin SAFE GET (#open-offorigin fires originB/offasset)
//       is ABORTED (offHits stays 0, leak prevented) but does NOT fail the reveal — the child IS revealed.
//       A safe-method off-origin sub-resource must not break reach (writes/danger still HARD-fail above).
//
// FAIL-ON-REVERT (each guard reds when its fix is reverted, then restored):
//   (1) delete the `await page.route('**/*', firewall)` install (or the `if (blocked.length > blockedBefore)`
//       throw) → #open-danger's POST /api/track passes → trackHits>0 (and, if install dropped, no throw → rejects reds).
//   (3) H1: canon the live request over `new URL(req.url()).pathname` instead of the FULL url → the smuggled
//       DELETE matches the allowlisted read → itemWriteHits>0 + no REVEAL_WRITE_BLOCKED.
//   (4) M2: short-circuit `SAFE_METHODS.has(method) → route.continue()` BEFORE the off-origin/danger check →
//       GET /logout is waved through → logoutHits>0 + no throw.
//   (5) L2: allowlist every non-GET in buildWriteAllowlist (drop the `method !== 'POST'` skip) → the recorded
//       DELETE becomes allowlisted → itemWriteHits>0 + no throw. All verified red, then restored.
//   (6) re-harden replayRevealPath (`find(b=>b.hard)` → `blocked.length > blockedBefore`) → the benign
//       off-origin GET fails the reveal → replay REJECTS (reach half — the guard reds on the throw, since the
//       child is set synchronously before the aborted fetch); drop the `|| offOrigin` clause in
//       makeFirewallHandler → the GET reaches serverB → offHits>0 (leak half).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { start } from '../fixtures/firewall-app/server.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { waitSettled } from '../../lib/browser/causal.mjs';
import { replayRevealPath } from '../../lib/recon/reveal-replay.mjs';

// A hand-built graph for the opener template `tid` at instance `#1` = selector `sel`, whose ONLY
// recorded non-GET trigger is POST /api/list (the allowlisted read). The reveal path is the opener
// itself (one hop) — replayRevealPath walks statePath, so it clicks the opener under the firewall.
function openerGraph(tid, sel) {
  return {
    elements: { [tid]: { name: 'Open list', route: '/', instances: [{ instanceKey: '#1', instanceSelector: sel }] } },
    requests: { 'POST /api/list': { type: 'request', method: 'POST', urlPattern: '/api/list' } },
    edges: [{ from: `element:${tid}`, to: 'request:POST /api/list', type: 'triggers', provenance: 'causal' }],
  };
}
const reveal = (tid) => ({ route: '/', statePath: [{ templateId: tid, instanceKey: '#1' }] });

// A hand-built graph for opener template `tid` at instance `#1` = `sel`, whose recorded non-GET
// triggers are `triggers` (each { method, urlPattern }). The generic form of openerGraph — used by the
// H1 / M2 / L2 cases where the recorded read is NOT the fixed POST /api/list. An empty `triggers`
// models an opener with no recorded read (its whole reveal fetch is a side-effect the firewall judges).
function graphWith(tid, sel, triggers) {
  const requests = {};
  const edges = [];
  for (const t of triggers) {
    const key = `${t.method} ${t.urlPattern}`;
    requests[key] = { type: 'request', method: t.method, urlPattern: t.urlPattern };
    edges.push({ from: `element:${tid}`, to: `request:${key}`, type: 'triggers', provenance: 'causal' });
  }
  return {
    elements: { [tid]: { name: 'Open', route: '/', instances: [{ instanceKey: '#1', instanceSelector: sel }] } },
    requests,
    edges,
  };
}

test('the firewall aborts a non-allowlisted replay-time write, fails the reveal, and leaves the account unmutated', async (t) => {
  process.env.PW_ALLOW_PRIVATE = '1';
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const { browser, page } = await launch();
  // Cleanup registered BEFORE any assertion that can throw (doctrine: t.after first).
  t.after(async () => { await close(browser); server.close(); });

  await gotoGated(page, url);
  await waitSettled(page);

  // (1) Replaying #open-danger fires the write POST /api/track — NOT in the opener's recorded triggers
  // (only POST /api/list is), so the firewall aborts it and the reveal throws REVEAL_WRITE_BLOCKED.
  await assert.rejects(
    () => replayRevealPath(page, openerGraph(100, '#open-danger'), reveal(100)),
    (e) => e.code === 'REVEAL_WRITE_BLOCKED',
    'a non-allowlisted write fired during replay throws REVEAL_WRITE_BLOCKED',
  );
  assert.equal(server.trackHits(), 0, 'the mutation POST /api/track was ABORTED — the live account is unmutated');

  // (2) The firewall did NOT break legitimate reach: the safe GET and the allowlisted read-POST both
  // reached the server (they were continued, not aborted), even though the step ultimately failed.
  assert.ok(server.safeHits() >= 1, 'the safe GET /api/safe was continued (not aborted)');
  assert.ok(server.listHits() >= 1, 'the allowlisted read POST /api/list was continued (not aborted)');
});

test('the firewall passes an all-allowed opener untouched — replay completes and reveals the child', async (t) => {
  process.env.PW_ALLOW_PRIVATE = '1';
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const { browser, page } = await launch();
  t.after(async () => { await close(browser); server.close(); });

  await gotoGated(page, url);
  await waitSettled(page);

  // #open-safe fires only the SAFE GET + the ALLOWLISTED read-POST — no write — so the reveal replay
  // must COMPLETE without throwing (a too-aggressive firewall would abort the read-POST and red this).
  await replayRevealPath(page, openerGraph(200, '#open-safe'), reveal(200));

  // The reveal genuinely reached the state: the opener's revealed child is present (the firewall let
  // the click's requests through and torn itself down cleanly), and no write was ever fired.
  const child = await page.$('#child-safe');
  assert.ok(child, 'the opener revealed its child — legitimate reach is NOT broken by the firewall');
  assert.ok(server.safeHits() >= 1, 'the safe GET was continued during the successful replay');
  assert.ok(server.listHits() >= 1, 'the allowlisted read POST was continued during the successful replay');
  assert.equal(server.trackHits(), 0, 'no write endpoint was ever fired by the all-allowed opener');
});

test('H1: a query-smuggled write (POST /api/item?_method=DELETE) is NOT matched to the allowlisted read POST /api/item', async (t) => {
  process.env.PW_ALLOW_PRIVATE = '1';
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const { browser, page } = await launch();
  t.after(async () => { await close(browser); server.close(); });

  await gotoGated(page, url);
  await waitSettled(page);

  // The opener's ONLY recorded read is POST /api/item (allowlisted). At replay it fires
  // POST /api/item?_method=DELETE — a DIFFERENT urlPattern under full-url canon (/api/item?_method=:param)
  // → NOT allowlisted → aborted. Pathname-only canon would strip the query and match the read, executing it.
  await assert.rejects(
    () => replayRevealPath(page, graphWith(300, '#open-h1', [{ method: 'POST', urlPattern: '/api/item' }]), reveal(300)),
    (e) => e.code === 'REVEAL_WRITE_BLOCKED',
    'the query-smuggled DELETE is blocked with REVEAL_WRITE_BLOCKED',
  );
  assert.equal(server.itemWriteHits(), 0, 'the smuggled POST /api/item?_method=DELETE was ABORTED — account unmutated');
});

test('M2: a reveal opener fetch(/logout) (a SAFE GET) is aborted by the danger-route guard, not waved through', async (t) => {
  process.env.PW_ALLOW_PRIVATE = '1';
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const { browser, page } = await launch();
  t.after(async () => { await close(browser); server.close(); });

  await gotoGated(page, url);
  await waitSettled(page);

  // #open-logout fires fetch('/logout') — a SAFE GET. A firewall that short-circuits safe methods to
  // continue would end the authed session; the danger-route guard must abort it FIRST (M2).
  await assert.rejects(
    () => replayRevealPath(page, graphWith(400, '#open-logout', []), reveal(400)),
    (e) => e.code === 'REVEAL_WRITE_BLOCKED',
    'the safe-GET /logout is firewall-refused → REVEAL_WRITE_BLOCKED',
  );
  assert.equal(server.logoutHits(), 0, 'the GET /logout was ABORTED even though GET is a safe method — session preserved');
});

test('L2: a recorded DELETE /api/item is never allowlisted (only read-over-POST is) → aborted on replay', async (t) => {
  process.env.PW_ALLOW_PRIVATE = '1';
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const { browser, page } = await launch();
  t.after(async () => { await close(browser); server.close(); });

  await gotoGated(page, url);
  await waitSettled(page);

  // The graph records a DELETE /api/item trigger, but buildWriteAllowlist keeps ONLY read-over-POST —
  // a non-idempotent verb is never re-firable (L2), so the replay-time DELETE is aborted.
  await assert.rejects(
    () => replayRevealPath(page, graphWith(500, '#open-delete', [{ method: 'DELETE', urlPattern: '/api/item' }]), reveal(500)),
    (e) => e.code === 'REVEAL_WRITE_BLOCKED',
    'the recorded DELETE is not re-firable → REVEAL_WRITE_BLOCKED',
  );
  assert.equal(server.itemWriteHits(), 0, 'DELETE /api/item was ABORTED — a non-idempotent verb is never allowlisted');
});

test('a benign off-origin SAFE-method sub-resource is aborted (leak prevented) but does NOT fail the reveal', async (t) => {
  // Guards: a safe-method OFF-ORIGIN sub-resource (a CDN image/font/pixel the revealed UI pulls in) is a
  // SOFT block — aborted to prevent the leak, yet the reveal COMPLETES and reveals its child. The old
  // "any aborted request fails the reveal" broke stay-on-page reach on every real app with off-origin
  // assets (found live on the target host: composer + Live-events reveals died REVEAL_WRITE_BLOCKED on
  // a benign GET /nuggets/Image_*.jpg served off-origin). Writes/danger-routes still HARD-fail (tests above).
  // FAIL-ON-REVERT (reach): re-harden replayRevealPath (`blocked.slice(blockedBefore).find(b=>b.hard)` →
  //   `blocked.length > blockedBefore`) → the off-origin GET fails the reveal → `replayRevealPath` REJECTS
  //   (the child is set synchronously before the aborted fetch, so the guard reds on the throw, not on child absence).
  // FAIL-ON-REVERT (leak): drop the `|| offOrigin` abort clause in makeFirewallHandler → the cross-origin
  //   GET is waved through → serverB.offHits() > 0.
  process.env.PW_ALLOW_PRIVATE = '1';
  const serverA = await start(0); // serves the page
  const serverB = await start(0); // the OFF-ORIGIN "CDN" (different port ⇒ different origin, RFC 6454)
  const originB = `http://127.0.0.1:${serverB.address().port}`;
  const url = `http://127.0.0.1:${serverA.address().port}/?off=${encodeURIComponent(originB)}`;
  const { browser, page } = await launch();
  t.after(async () => { await close(browser); serverA.close(); serverB.close(); });

  await gotoGated(page, url);
  await waitSettled(page);

  // #open-offorigin fires only a benign cross-origin SAFE GET (originB/offasset) — no recorded triggers,
  // so the allowlist is empty. The reveal must COMPLETE (not throw): the safe-method off-origin sub-resource
  // is a SOFT block, aborted without failing reach.
  await replayRevealPath(page, graphWith(600, '#open-offorigin', []), reveal(600));

  const child = await page.$('#child-offorigin');
  assert.ok(child, 'the reveal COMPLETED and revealed its child — a benign off-origin asset does not break reach');
  assert.equal(serverB.offHits(), 0, 'the cross-origin GET /offasset was ABORTED — the off-origin leak is still prevented');
});
