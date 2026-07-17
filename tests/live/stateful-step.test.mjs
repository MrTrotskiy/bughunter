// Live proof of the STATEFUL in-session recon walk (stateful-step.mjs) — the operator's actual
// loop and the real fix for incomplete coverage. A control that exists ONLY after a click opens a
// panel (a modal #save, same URL, injected on #open) is genuinely reached, collected, and causally
// attributed WITHOUT any reveal-replay — because the loop STAYS on the page: #open's panel is still
// open when #save is acted (state accumulates). The cold path (persistentStep) closes the panel
// between acts and must reconstruct it via replay; stateful mode never does. And the causal
// invariant holds at depth: the background /api/poll ticking inside #save's window is NOT credited.
//
// Guards (crawl):
//   (a) STATEFUL REACH — #save is `explored`, NOT unreachable, reached by IN-SESSION accumulation.
//   (b) PROVENANCE, NOT REPLAY — #save was reached because the panel stayed open, not by replaying a
//       recorded path. Stateful mode now stamps a reveal breadcrumb for LOCATION honesty (Blocker-4),
//       but marks it stateful:true so a consumer tells it from a replayable stateless path: #save's
//       reveal is present, its opener hop is #open, and stateful:true is set. The discriminator vs. the
//       stateless stay-on-page test (whose save.reveal.statePath is a REPLAY path, no stateful marker).
//   (c) CAUSAL ATTRIBUTION AT DEPTH — GET /api/save is attributed to #save (edge present).
//   (d) CAUSAL CLEANLINESS AT DEPTH — the /api/poll background poll is NOT credited to anything
//       (no request node, no edge); pollHits>=2 is a liveness sanity (the rigorous in-window proof
//       is test #2, which shows the poll ticks inside #save's window carrying its cause).
// Guards (manual, in-window): at depth-1 (panel open, in-session), the poll ticks INSIDE #save's
//   measured window carrying #save's cause token (raw ring WOULD miscredit) yet attribution drops it.
//
// FAIL-ON-REVERT:
//   (a)/(c) LEVER A — force a cold re-nav between acts: add `await gotoGated(page, baselineUrl);`
//       as the FIRST line of statefulStep's returned step (stateful-step.mjs). The panel is closed
//       when #save is acted → NO_INSTANCE → #save.unreachable set, no /api/save edge → (a) and (c)
//       go red ("#save is genuine coverage" / "GET /api/save is attributed to #save").
//   (d)/in-window LEVER B — neuter the CDP initiator (classifyInitiator → {background:false} in
//       initiator.mjs) → the in-window /api/poll (carrying #save's cause) leaks into the kept set →
//       a GET /api/poll node+edge appears and test #2's "poll is dropped at depth" goes red.
//       (chromium-only mechanism.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/stateful-app/server.mjs';
import { crawl } from '../../lib/recon/recon-run.mjs';
import { loadGraph } from '../../lib/graph/graph-store.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { beginCause, endCause, waitSettled } from '../../lib/browser/causal.mjs';

test('stateful walk reaches a panel control IN-SESSION (no reveal-replay), attributes it, drops the in-window poll', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-stateful-'));
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
  // The panel control is named a benign read ("Details") — a --stateful crawl is read-only, so its NAME-level
  // mutation gate would refuse a write-verb-named control ("Save") at click time (see the fixture header).
  const save = Object.values(graph.elements).find((n) => n.name === 'Details');
  const open = Object.values(graph.elements).find((n) => n.name === 'Open panel');
  assert.ok(open, 'the Open button was discovered at baseline');
  assert.ok(save, 'the panel Details control was discovered (revealed by the in-session #open act)');

  // (a) STATEFUL REACH — #save is genuine coverage, reached by staying on the page, not marked unreachable.
  assert.ok(save.explored, '#save was explored');
  assert.ok(!save.unreachable, '#save is genuine coverage, NOT unreachable-coldstart');

  // (b) PROVENANCE, NOT REPLAY — #save was reached by accumulation, and now carries a stateful:true
  // provenance breadcrumb (location honesty) whose opener hop is #open — NOT a replayable stateless path.
  assert.ok(save.reveal, '#save carries a provenance reveal path (stateful location honesty)');
  assert.equal(save.reveal.stateful, true, '#save reveal is marked stateful:true (provenance, not a replayable path)');
  assert.equal(save.reveal.statePath[save.reveal.statePath.length - 1].templateId, open.templateId,
    "#save's reveal path opener hop is #open");

  // (c) CAUSAL ATTRIBUTION AT DEPTH — the depth-1 panel act binds request→control.
  assert.ok(graph.requests['GET /api/save'], 'the save request node exists');
  assert.ok(
    graph.edges.some((e) => e.from === `element:${save.templateId}` && e.to === 'request:GET /api/save'),
    'GET /api/save is attributed to #save',
  );

  // (d) CAUSAL CLEANLINESS AT DEPTH — the in-window background poll is NOT credited to anything.
  assert.equal(graph.requests['GET /api/poll'], undefined, 'the background poll is not a request node (never credited)');
  assert.ok(!graph.edges.some((e) => e.to === 'request:GET /api/poll'), 'no control is credited the background poll');
  assert.ok(server.pollHits() >= 2, `the background poll must have fired during the crawl (got ${server.pollHits()})`);
});

test('at depth-1 (panel open, in-session), the poll ticks INSIDE #save\'s window carrying its cause, yet is dropped', async (t) => {
  process.env.PW_ALLOW_PRIVATE = '1';
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const { browser, page } = await launch();
  t.after(async () => { await close(browser); server.close(); });

  await gotoGated(page, url);
  await waitSettled(page);
  // Enter the depth-1 state the stateful loop accumulates: open the panel IN-SESSION (same URL, no nav).
  await page.click('#open');
  await waitSettled(page);

  const cause = 'SAVE_BTN';
  const seq0 = await beginCause(page, cause);
  await page.click('#save'); // slow GET (~600ms); the 150ms poll deterministically ticks inside
  const kept = await endCause(page, seq0, cause);

  // Vacuity: a poll ticked INSIDE #save's measured window and carries its token — the raw ring
  // WOULD miscredit it. (If no poll ticked, guard (d) above would be trivially satisfied.)
  const raw = await page.evaluate(({ c, s }) => window.__bughuntFires
    .filter((f) => f.cause === c && f.seq >= s).map((f) => f.url), { c: cause, s: seq0 });
  assert.ok(raw.some((u) => u.includes('/api/poll')), 'a poll must tick inside the depth-1 window (else this guard is vacuous)');
  assert.ok(raw.some((u) => u.includes('/api/save')), 'the caused request is in the raw window too');

  // Attribution drops the poll, keeps the real request — causal survival at DEPTH, in-session.
  const keptUrls = kept.map((f) => f.url);
  assert.ok(!keptUrls.some((u) => u.includes('/api/poll')), 'the in-window poll is rejected at depth (attribution unchanged)');
  assert.ok(keptUrls.some((u) => u.includes('/api/save')), 'the save request survives attribution');
});
