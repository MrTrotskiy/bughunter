// Live proof of the "panel reach" fill (decisions.md 2026-07-15 depth-2 Option A, Fable-CTO design).
// A control PRESENT in the DOM at baseline but HIDDEN behind an overflow panel (an antd "…more") is
// discovered PATHLESS, so first-reveal-wins would lock it unreachable (NOT_VISIBLE, no reveal path to
// replay). The fill fixes it: when a STAMPED opener act makes a pre-existing hidden-at-baseline
// (hiddenWhenSeen) instance VISIBLE, that instance ACQUIRES the opener's reveal path and sheds its
// unreachable flag, so the frontier re-emits it and it is reached by replay -- single-pass, no retry.
//
// Guards (crawl over panel-tabs-app via the NODE loop — deterministic, no LLM). TWO tests, one per
// DOM ordering, to prove BOTH loop paths that a reveal-fill closes:
//
// TEST 1 (`/app`, tabs-first → cross-batch REOPEN path):
//   (a) FILL — the baseline-hidden pathless tab is `explored` (reached by replaying [More]), NOT
//       stuck NOT_VISIBLE-unreachable, and carries a 1-hop reveal path whose only step is More.
//   (b) OPENER-BY-UNCOVER — "More" reveals NO new instances (the tabs pre-exist) yet is flagged an
//       opener PURELY because the fill counted it (newlyReachable), so its children are walked.
//   (c) CAUSAL ATTRIBUTION — the reached tab's GET /tab-data is attributed to the tab (edge present).
//   (d) NO-MISATTRIBUTION SANITY — the background GET /api/poll ran (pollHits>0 liveness) yet is
//       attributed to NOTHING (no request node, no edge). This is a coarse sanity, NOT the in-window
//       adversarial proof: it does not force the poll to tick INSIDE the causal window. The hard
//       in-window-poll-is-dropped guard (raw ring WOULD miscredit, attribution drops it) lives at
//       depth in tests/live/stay-on-page.test.mjs and tests/live/whats-new.test.mjs.
//   FAIL-ON-REVERT: drop the fill else-branch in graph-store.mjs mergeSnapshot → the More act reveals
//     no new instances and fills nothing → More is never flagged an opener, the tab never acquires a
//     reveal path → it stays NOT_VISIBLE-unreachable → (a) `!tab.unreachable` + `tab.reveal` and
//     (b) `more.opener` go red (`tab.explored` STAYS green — the loop drains it on the NOT_VISIBLE act).
//
// TEST 2 (`/app-opener-first`, opener-first → same-batch persistentStep GRAPH re-read path):
//   #more is emitted in the SAME batch as the tab, BEFORE it. More's act fills the tab's [More] reveal,
//   but the tab's batch item was snapshotted before that fill (reveal=null). Only recon-run's live
//   graph re-read picks up the fresh path in time to replay it THIS batch. Same (a)-(c) assertions.
//   FAIL-ON-REVERT: replace `liveTarget` with `target` in recon-run.mjs persistentStep (drop the
//     graph re-read) → the tab acts with the stale reveal=null → NOT_VISIBLE, re-drained same batch,
//     never re-emitted → `!tab.unreachable` + `tab.reveal` go red. (TEST 1 stays green — its reopen is
//     cross-batch, so nextBatch already carries the fresh reveal without the re-read.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/panel-tabs-app/server.mjs';
import { crawl } from '../../lib/recon/recon-run.mjs';
import { loadGraph } from '../../lib/graph/graph-store.mjs';

test('panel reach: a baseline-hidden pathless tab, uncovered by "More", is reached via replay', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/app`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-panel-reach-'));
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

  const res = await crawl({ url, steps: 20 });
  assert.equal(res.ok, true, 'crawl completed');
  const graph = loadGraph(path.join(stateDir, 'graph.json'));

  const more = Object.values(graph.elements).find((n) => n.name === 'More');
  const tab = Object.values(graph.elements).find((n) => (n.templateSelector || '').includes('button.tab'));
  assert.ok(more, 'the More opener was discovered');
  assert.ok(tab, 'the tab template (baseline-hidden) was discovered');

  // (b) OPENER-BY-UNCOVER: More revealed no NEW instances, yet the fill flagged it an opener.
  assert.ok(more.opener, 'More is flagged an opener purely by uncovering hidden tabs (the fill)');

  // (a) FILL: the baseline-hidden tab is genuine coverage, reached by replaying [More] — not stuck.
  const t0 = tab.instances[0];
  assert.ok(t0.explored, 'the uncovered tab was explored (reached via replay)');
  assert.ok(!t0.unreachable, 'the tab is NOT stuck NOT_VISIBLE-unreachable (the fill shed the flag)');
  assert.ok(t0.reveal && t0.reveal.statePath && t0.reveal.statePath.length === 1, 'the tab acquired a 1-hop reveal path');
  assert.equal(t0.reveal.statePath[0].templateId, more.templateId, 'the acquired reveal path is [More]');

  // (c) CAUSAL ATTRIBUTION: the reached tab's GET /tab-data is credited to the tab.
  assert.ok(graph.requests['GET /tab-data?t=:param'], 'the tab-data request node exists');
  assert.ok(
    graph.edges.some((e) => e.from === `element:${tab.templateId}` && e.to === 'request:GET /tab-data?t=:param'),
    'GET /tab-data is causally attributed to the tab',
  );

  // (d) NO-MISATTRIBUTION SANITY: the background poll ran yet is credited to nothing. Coarse — the
  // in-window adversarial proof lives in stay-on-page.test.mjs / whats-new.test.mjs (see header).
  assert.equal(graph.requests['GET /api/poll'], undefined, 'the background poll is never a request node');
  assert.ok(!graph.edges.some((e) => e.to === 'request:GET /api/poll'), 'no control is credited the background poll');
  assert.ok(server.pollHits() >= 2, `the poll fired during the crawl (liveness, got ${server.pollHits()})`);
});

test('panel reach (opener-first): the tab acquires [More] SAME-batch via the live graph re-read', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/app-opener-first`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-panel-reach-of-'));
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

  const res = await crawl({ url, steps: 20 });
  assert.equal(res.ok, true, 'crawl completed');
  const graph = loadGraph(path.join(stateDir, 'graph.json'));

  const more = Object.values(graph.elements).find((n) => n.name === 'More');
  const tab = Object.values(graph.elements).find((n) => (n.templateSelector || '').includes('button.tab'));
  assert.ok(more, 'the More opener was discovered');
  assert.ok(tab, 'the tab template (baseline-hidden) was discovered');

  // (a) FILL via the SAME-batch re-read: the tab is genuine coverage, reached by replaying [More].
  // Without recon-run's live graph re-read the stale batch item (reveal=null) fails NOT_VISIBLE.
  const t0 = tab.instances[0];
  assert.ok(t0.explored, 'the uncovered tab was explored (reached via replay)');
  assert.ok(!t0.unreachable, 'the tab is NOT stuck NOT_VISIBLE-unreachable (the re-read replayed [More])');
  assert.ok(t0.reveal && t0.reveal.statePath && t0.reveal.statePath.length === 1, 'the tab acquired a 1-hop reveal path');
  assert.equal(t0.reveal.statePath[0].templateId, more.templateId, 'the acquired reveal path is [More]');

  // (c) CAUSAL ATTRIBUTION: the reached tab's GET /tab-data is credited to the tab.
  assert.ok(graph.requests['GET /tab-data?t=:param'], 'the tab-data request node exists');
  assert.ok(
    graph.edges.some((e) => e.from === `element:${tab.templateId}` && e.to === 'request:GET /tab-data?t=:param'),
    'GET /tab-data is causally attributed to the tab',
  );

  // (d) NO-MISATTRIBUTION SANITY (see TEST 1 / header for the in-window adversarial proof).
  assert.equal(graph.requests['GET /api/poll'], undefined, 'the background poll is never a request node');
  assert.ok(!graph.edges.some((e) => e.to === 'request:GET /api/poll'), 'no control is credited the background poll');
});
