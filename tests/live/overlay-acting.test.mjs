// Live proof of OVERLAY-AWARE stateful acting (overlay-dismiss.mjs + the stateful-step retry +
// the stateful-loop close-after-study) — the real fix for a modal-heavy site regressing the
// stateful walk. An act OPENS a full-screen backdrop modal that OBSCURES a base-page sibling, so a
// RAW click on that sibling TIMES OUT (obscured, NOT hidden — Playwright reports it visible). Without
// the fix that sibling is marked unreachable → mass unreachable → premature drain (the live target
// symptom: 7 explored stateful vs 31 stateless, 17 of 35 unreachable were click-timeouts). The
// overlay-aware loop STUDIES the modal control, CLOSES the modal (Escape, mid-walk), and REACHES the
// sibling — genuine coverage, its request causally attributed.
//
// Guards (crawl):
//   (a) STUDY-THEN-CLOSE — #open (A) opens the modal, #modal-act (M) is studied, THEN #target (B) —
//       obscured by the backdrop — is reached AFTER the mid-walk dismiss closes the modal. A, M, B are
//       all `explored`, none `unreachable`. B would click-TIMEOUT (unreachable) without the dismiss.
//   (b) CAUSAL ATTRIBUTION AT DEPTH — GET /api/modal-act → M, GET /api/target → B (edges present).
//   (c) CAUSAL CLEANLINESS — the /api/poll background poll (ticking inside M's slow window) is NEVER
//       credited (no request node, no edge; pollHits>=2 is the non-vacuous liveness check). AND the
//       Escape-dismiss forges NO request node: the ONLY credited requests are the two real ones —
//       proving the closer opened no causal window.
//
// FAIL-ON-REVERT (sentinel: "#target (B) is genuine coverage, NOT unreachable"):
//   Remove the dismiss-and-retry in stateful-step.mjs (make the catch just `recordFail(err); throw err`)
//   AND the close-after-study in stateful-loop.mjs drainRoute (make picked===null `return false`).
//   Then B's obscured click times out → statefulStep re-throws → the loop marks B unreachable → guard
//   (a) `!target.unreachable` reds and (b) the GET /api/target edge is absent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/modal-block-app/server.mjs';
import { crawl } from '../../lib/recon/recon-run.mjs';
import { loadGraph } from '../../lib/graph/graph-store.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { beginCause, endCause, waitSettled } from '../../lib/browser/causal.mjs';
import { dismissBlockingOverlay } from '../../lib/recon/overlay-dismiss.mjs';

test('overlay-aware stateful loop studies a modal, closes it, reaches the obscured sibling', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-overlay-act-'));
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

  const res = await crawl({ url, steps: 12, stateful: true });
  assert.equal(res.ok, true, 'stateful crawl completed');

  const graph = loadGraph(path.join(stateDir, 'graph.json'));
  const open = Object.values(graph.elements).find((n) => n.name === 'Open dialog');
  const modalAct = Object.values(graph.elements).find((n) => n.name === 'Apply');
  const target = Object.values(graph.elements).find((n) => n.name === 'Do thing');
  assert.ok(open, 'the Open button was discovered at baseline');
  assert.ok(modalAct, 'the modal control was discovered');
  assert.ok(target, 'the obscured sibling was discovered at baseline');

  // (a) STUDY-THEN-CLOSE — all three genuine coverage; the sibling is NOT unreachable.
  assert.ok(open.explored, '#open (A) was explored');
  assert.ok(modalAct.explored && !modalAct.unreachable, 'the modal control (M) is genuine coverage (studied before the close)');
  assert.ok(target.explored && !target.unreachable, '#target (B) is genuine coverage, NOT unreachable');

  // (b) CAUSAL ATTRIBUTION AT DEPTH — both the modal control and the reached sibling bind request→control.
  assert.ok(graph.requests['GET /api/modal-act'], 'the modal-act request node exists');
  assert.ok(
    graph.edges.some((e) => e.from === `element:${modalAct.templateId}` && e.to === 'request:GET /api/modal-act'),
    'GET /api/modal-act is attributed to the modal control',
  );
  assert.ok(graph.requests['GET /api/target'], 'the target request node exists (the sibling was reached after the dismiss)');
  assert.ok(
    graph.edges.some((e) => e.from === `element:${target.templateId}` && e.to === 'request:GET /api/target'),
    'GET /api/target is attributed to #target',
  );

  // (c) CAUSAL CLEANLINESS — the in-window poll is never credited, and the Escape-dismiss forged no
  // request node: the ONLY credited requests are the two real ones (the closer opened no causal window).
  assert.equal(graph.requests['GET /api/poll'], undefined, 'the background poll is not a request node');
  assert.ok(!graph.edges.some((e) => e.to === 'request:GET /api/poll'), 'no control is credited the background poll');
  assert.deepEqual(
    Object.keys(graph.requests).sort(),
    ['GET /api/modal-act', 'GET /api/target'],
    'exactly the two real requests are credited — the dismiss added no phantom request',
  );
  assert.ok(server.pollHits() >= 2, `the poll must have fired during the crawl (got ${server.pollHits()})`);
});

// Guards: at depth-1 (modal open, in-session) the slow modal act's window swallows a background poll
//   tick that carries its cause token — the raw ring WOULD miscredit it (asserted, non-vacuous) yet
//   attribution drops it. AND dismissBlockingOverlay, run under __idle__, actually closes the modal
//   (the mechanism the crawl relies on) firing no credited request.
// FAIL-ON-REVERT: neuter the CDP initiator (classifyInitiator → {background:false} in initiator.mjs)
//   → the in-window /api/poll (carrying the modal act's cause) leaks into the kept set → "the in-window
//   poll is rejected at depth" reds. (chromium-only mechanism.)
test('the in-window poll is dropped at the modal depth, and the mid-walk dismiss closes the modal', async (t) => {
  process.env.PW_ALLOW_PRIVATE = '1';
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const { browser, page } = await launch();
  t.after(async () => { await close(browser); server.close(); });

  await gotoGated(page, url);
  await waitSettled(page);
  // Enter the depth-1 state: open the modal IN-SESSION (same URL, no navigation).
  await page.click('#open');
  await waitSettled(page);

  const cause = 'MODAL_ACT';
  const seq0 = await beginCause(page, cause);
  await page.click('#modal-act'); // slow GET (~600ms); the 150ms poll deterministically ticks inside
  const kept = await endCause(page, seq0, cause);

  // Vacuity: a poll ticked INSIDE the modal act's window and carries its token — the raw ring WOULD
  // miscredit it (if none ticked, the drop assertion would be trivially satisfied).
  const raw = await page.evaluate(({ c, s }) => window.__bughuntFires
    .filter((f) => f.cause === c && f.seq >= s).map((f) => f.url), { c: cause, s: seq0 });
  assert.ok(raw.some((u) => u.includes('/api/poll')), 'a poll must tick inside the modal-depth window (else this guard is vacuous)');
  assert.ok(raw.some((u) => u.includes('/api/modal-act')), 'the caused request is in the raw window too');

  // Attribution drops the poll, keeps the real request — causal survival at the modal depth.
  const keptUrls = kept.map((f) => f.url);
  assert.ok(!keptUrls.some((u) => u.includes('/api/poll')), 'the in-window poll is rejected at depth');
  assert.ok(keptUrls.some((u) => u.includes('/api/modal-act')), 'the modal-act request survives attribution');

  // The mid-walk closer works on this fixture (Escape closes the modal) — and runs under __idle__
  // (endCause already reset the cause), so it forges no causal edge.
  const dismissed = await dismissBlockingOverlay(page);
  assert.equal(dismissed, true, 'dismissBlockingOverlay closed the open modal');
});
