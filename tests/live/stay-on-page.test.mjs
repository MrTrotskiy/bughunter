// Live proof of GAP 2 stay-on-page REACH: a control reachable ONLY by an in-page action (a
// modal opened by a page button, same URL) is genuinely reached, collected, and causally
// attributed — while the background poll that ticks inside its DEPTH-1 causal window stays
// uncredited (causal survival at depth). A real crawl over the modal-app fixture via recon-run,
// plus a focused manual drive that proves the in-window poll tick with the raw fire-ring.
//
// Guards (crawl):
//   (a) STAY-ON-PAGE REACH — the modal's Save control is `explored`, NOT unreachable-coldstart.
//       This requires the persistentStep replay prologue to re-open the modal before acting,
//       since the per-act re-navigation closes it.
//   (b) REVEAL ANNOTATION — Save.node.reveal.statePath === [the Open button's {templateId,
//       instanceKey}] — the collection stamp that lets the loop replay the path.
//   (c) CAUSAL ATTRIBUTION AT DEPTH — Save's GET /api/modal-save is attributed to Save (edge
//       present), so the depth-1 modal act still binds request→control.
//   (d) CAUSAL SURVIVAL AT DEPTH — the shared-path /api/poll background poll is NOT attributed
//       to anything (no request node, no edge); pollHits>0 is a liveness sanity (the RIGOROUS
//       in-window proof is the second test below).
//   (e) GET-ONLY REPLAYABILITY GATE — #save2, revealed by a MUTATING (POST) opener, gets NO
//       reveal annotation and stays `unreachable` (its mutation is never replayed).
// Guards (manual, in-window): at depth-1 (modal open), the poll ticks INSIDE Save's measured
//   window carrying Save's cause token (raw ring WOULD miscredit) yet attribution drops it.
// FAIL-ON-REVERT:
//   (a)/(c) disable the replay prologue (drop the `if (target.reveal) await replayRevealPath`
//       branch in reveal-replay.mjs applyReveal) → the modal is closed when Save is acted →
//       NO_INSTANCE → Save.unreachable set + no edge → (a) and (c) go red.
//   (d)/in-window neuter the CDP initiator (classifyInitiator → {background:false}) → the
//       in-window poll (carrying Save's cause token) leaks into the kept set → an /api/poll
//       edge appears and the manual test's "poll rejected at depth" goes red. (chromium-only.)
//   (e) remove the `requests.every(GET)` clause in step.mjs → #save2 is stamped + replayed →
//       "a mutating-opener child gets NO reveal" and "stays unreachable" go red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/modal-app/server.mjs';
import { startExternal } from '../fixtures/multi-route-app/server.mjs';
import { crawl } from '../../lib/recon/recon-run.mjs';
import { loadGraph } from '../../lib/graph/graph-store.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { beginCause, endCause, waitSettled } from '../../lib/browser/causal.mjs';
import { replayRevealPath, REVEAL_MAX_DEPTH } from '../../lib/recon/reveal-replay.mjs';

test('recon reaches a control behind a depth-1 modal, attributes it, and drops the in-window poll', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;

  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-stayonpage-'));
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  const prevState = process.env.BUGHUNTER_STATE_DIR;
  process.env.PW_ALLOW_PRIVATE = '1';
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  t.after(() => {
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
    if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState;
  });

  const res = await crawl({ url, steps: 12 });
  assert.equal(res.ok, true, 'crawl completed');

  const graph = loadGraph(path.join(stateDir, 'graph.json'));
  const save = Object.values(graph.elements).find((n) => n.name === 'Save');
  const open = Object.values(graph.elements).find((n) => n.name === 'Open');
  assert.ok(save, 'the modal Save control was discovered');
  assert.ok(open, 'the Open button was discovered');

  // (a) Save is genuine coverage — reached by replaying the reveal path, not marked unreachable.
  assert.ok(save.explored, 'Save was explored');
  assert.ok(!save.unreachable, 'Save is genuine coverage, NOT unreachable-coldstart');

  // (b) Save carries the exact reveal path that reaches it: the Open button, one hop.
  assert.deepEqual(
    save.reveal && save.reveal.statePath,
    [{ templateId: open.templateId, instanceKey: open.instances[0].instanceKey }],
    'Save.reveal.statePath is [the Open button]',
  );
  assert.equal(save.reveal.route, '/', 'the reveal path is rooted at the modal route /');

  // (c) Save's request is causally attributed at depth: the edge Save --triggers--> the endpoint.
  assert.ok(graph.requests['GET /api/modal-save'], 'the modal-save request node exists');
  assert.ok(
    graph.edges.some((e) => e.from === `element:${save.templateId}` && e.to === 'request:GET /api/modal-save'),
    'GET /api/modal-save is causally attributed to Save',
  );

  // (d) The in-window background poll is NOT attributed to anything (causal survival at depth):
  // no request node was minted for it, and no element edges to it.
  assert.equal(graph.requests['GET /api/poll'], undefined, 'the background poll is not a request node (never credited)');
  assert.ok(!graph.edges.some((e) => e.to === 'request:GET /api/poll'), 'no control is credited the background poll');
  // Liveness sanity: the poll actually fired during the crawl (the in-window proof is test #2).
  assert.ok(server.pollHits() >= 2, `the background poll must have fired during the crawl (got ${server.pollHits()})`);

  // (e) GET-only replayability gate: #save2 is revealed by a MUTATING (POST) opener, so it is
  // NOT stamped with a reveal path and is NEVER replayed — it stays honestly unreachable.
  const save2 = Object.values(graph.elements).find((n) => n.name === 'Persist');
  assert.ok(save2, 'the POST-opened control was discovered');
  assert.equal(save2.reveal, undefined, 'a mutating-opener child gets NO reveal annotation (GET-only gate)');
  assert.ok(save2.unreachable, 'the POST-revealed control stays unreachable (never replayed)');
});

test('at depth-1 (modal open), the poll ticks INSIDE Save\'s window carrying its cause, yet is dropped', async (t) => {
  process.env.PW_ALLOW_PRIVATE = '1';
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const { browser, page } = await launch();
  t.after(async () => { await close(browser); server.close(); });

  await gotoGated(page, url);
  await waitSettled(page);
  // Enter the DEPTH-1 state the replay prologue produces: open the modal (same URL, no nav).
  await page.click('#open');
  await waitSettled(page);

  const cause = 'SAVE_BTN';
  const seq0 = await beginCause(page, cause);
  await page.click('#save'); // slow GET (~600ms); the 200ms poll deterministically ticks inside
  const kept = await endCause(page, seq0, cause);

  // Vacuity: a poll ticked INSIDE Save's measured window and carries its token — the raw ring
  // WOULD miscredit it. (If no poll ticked, guard (d) would be trivially satisfied.)
  const raw = await page.evaluate(({ c, s }) => window.__bughuntFires
    .filter((f) => f.cause === c && f.seq >= s).map((f) => f.url), { c: cause, s: seq0 });
  assert.ok(raw.some((u) => u.includes('/api/poll')), 'a poll must tick inside the depth-1 window (else this guard is vacuous)');
  assert.ok(raw.some((u) => u.includes('/api/modal-save')), 'the caused request is in the raw window too');

  // Attribution drops the poll, keeps the real request — causal survival at DEPTH.
  const keptUrls = kept.map((f) => f.url);
  assert.ok(!keptUrls.some((u) => u.includes('/api/poll')), 'the in-window poll is rejected at depth (attribution unchanged)');
  assert.ok(keptUrls.some((u) => u.includes('/api/modal-save')), 'the modal-save request survives attribution');
});

// The replay path's SAFETY branches (drive replayRevealPath directly on a real page with hand-
// built graphs — the deterministic way to force each adversarial hop):
//   (a) REVEAL_STALE     — a statePath step whose instance is gone from the graph.
//   (L1) REVEAL_TOO_DEEP — a path deeper than REVEAL_MAX_DEPTH (deep/cyclic guard).
//   (H1) PRE-CLICK safety — a live element that is an OFF-ORIGIN link (REVEAL_OFFORIGIN) or links
//        to a /logout danger route (REVEAL_DANGER) is refused BEFORE the click, so the partner /
//        logout endpoints get ZERO hits — an authed session can never self-logout / leave scope.
//        The stored NAME is innocent ('Partner'/'Go'), so only the LIVE-href re-derivation catches
//        it (the adaptive-server-serves-a-danger-element scenario).
// FAIL-ON-REVERT: remove the two `if (href && ...)` pre-click guards in reveal-replay.mjs → the
//   off-origin/logout link is CLICKED (off-origin: same pathname '/', so the post-hoc route check
//   does NOT catch it → replay completes with no throw; logout: extHits/logoutHits = 1) → the
//   REVEAL_OFFORIGIN/REVEAL_DANGER assert.rejects + the 0-hit assertions go red.
test('replay REFUSES a stale, too-deep, off-origin, or danger-route hop BEFORE clicking it', async (t) => {
  process.env.PW_ALLOW_PRIVATE = '1';
  const ext = await startExternal(0);
  const extOrigin = `http://127.0.0.1:${ext.address().port}`;
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const { browser, page } = await launch();
  t.after(async () => { await close(browser); server.close(); ext.close(); });

  await gotoGated(page, url);
  await waitSettled(page);

  // (a) REVEAL_STALE — a statePath step whose instance is absent from the graph.
  await assert.rejects(
    () => replayRevealPath(page, { elements: {} }, { route: '/', statePath: [{ templateId: 999, instanceKey: '#1' }] }),
    (e) => e.code === 'REVEAL_STALE',
    'a statePath step that no longer resolves throws REVEAL_STALE',
  );

  // (L1) REVEAL_TOO_DEEP — refused before any hop is walked.
  const deep = Array.from({ length: REVEAL_MAX_DEPTH + 1 }, (_, i) => ({ templateId: i, instanceKey: '#1' }));
  await assert.rejects(
    () => replayRevealPath(page, { elements: {} }, { route: '/', statePath: deep }),
    (e) => e.code === 'REVEAL_TOO_DEEP',
    'a path deeper than REVEAL_MAX_DEPTH throws REVEAL_TOO_DEEP',
  );

  // (H1a) PRE-CLICK OFF-ORIGIN — a live off-origin link hop is refused BEFORE the click, so the
  // partner server gets ZERO hits. Its stored name is innocent, so only the live-href check fires.
  await page.evaluate((href) => {
    const a = document.createElement('a');
    a.id = 'x-ext'; a.href = href; a.textContent = 'Partner';
    document.body.appendChild(a);
  }, `${extOrigin}/`);
  const extGraph = { elements: { 50: { name: 'Partner', route: '/', instances: [{ instanceKey: '#1', instanceSelector: '#x-ext' }] } } };
  await assert.rejects(
    () => replayRevealPath(page, extGraph, { route: '/', statePath: [{ templateId: 50, instanceKey: '#1' }] }),
    (e) => e.code === 'REVEAL_OFFORIGIN',
    'an off-origin reveal hop is refused with REVEAL_OFFORIGIN',
  );
  assert.equal(ext.extHits(), 0, 'the off-origin link was never followed (refused before the click)');

  // (H1b) PRE-CLICK DANGER ROUTE — a live /logout link hop is refused before the click, so the
  // authed session is never self-logged-out (/logout gets ZERO hits). Stored name 'Go' is safe.
  await page.evaluate(() => {
    const a = document.createElement('a');
    a.id = 'x-logout'; a.href = '/logout'; a.textContent = 'Log out';
    document.body.appendChild(a);
  });
  const logoutGraph = { elements: { 51: { name: 'Go', route: '/', instances: [{ instanceKey: '#1', instanceSelector: '#x-logout' }] } } };
  await assert.rejects(
    () => replayRevealPath(page, logoutGraph, { route: '/', statePath: [{ templateId: 51, instanceKey: '#1' }] }),
    (e) => e.code === 'REVEAL_DANGER',
    'a /logout reveal hop is refused with REVEAL_DANGER',
  );
  assert.equal(server.logoutHits(), 0, 'the /logout route was never followed (refused before the click)');
});
