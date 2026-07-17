// Live proof of the CHURN bucket + honest termination on a re-rendering feed (blocker-6 Part B). The
// fixture feed re-renders WITHOUT stable data-ids AFTER the baseline snapshot, so the walked
// representative's CONTENT-keyed instanceKey ("News 0") vanishes and its stored positional selector goes
// stale. Before the fix such a vanished row was marked plain `unreachable`, conflating feed-churn with a
// genuine gap; and — worse — an unexplored representative that churned away kept `remaining` above 0
// forever, so the honest terminator could never declare DRAINED on a live feed. Now: a vanished LIST-ROW
// instance is reclassified CHURNED (peeled into `churnSkipped`, distinct from `unreachable`), so the STABLE
// control set drains to remaining===0 while the churn is QUANTIFIED; a vanished NON-listRow control stays
// honestly `unreachable`.
//
// Guards (one crawl):
//   (a) THE HONESTY WIN — after the walk, frontierInstanceStats(graph).remaining === 0 (the stable set
//       drained) WHILE churnSkipped > 0 (the vanished feed row is counted, not blocking termination).
//   (b) RECLASSIFICATION — the feed's representative instance ("News 0") is flagged `churned` and NOT
//       `unreachable`; the standalone #ghost (NON-listRow, also vanished) stays `unreachable` and NOT churned.
//   (c) STABLE COVERAGE — #stable ("Show status") is genuine coverage: explored, not unreachable.
//   (d) ATTRIBUTION — GET /api/status is a causal edge from #stable (wire-before-DOM contract).
//   (e) CAUSAL CLEANLINESS — the 80ms /api/poll background poll ticking inside #stable's slow window is
//       never credited (no request node, no edge); pollHits>=1 keeps the guard non-vacuous.
//
// FAIL-ON-REVERT (two levers, each reds a distinct guard):
//   LEVER 1 (guard a) — remove the `if (inst.churned) { churnSkipped++; continue; }` peel in
//       frontier.mjs frontierInstanceStats → the churned "News 0" re-enters `walkable` UNEXPLORED →
//       remaining === 1 (> 0) → "the stable set drained (remaining===0)" reds.
//   LEVER 2 (guard b) — drop the `node.listRow === true` branch in stateful-loop.mjs retireLeftovers
//       (mark every vanished candidate unreachable) → "News 0" is `unreachable`, not `churned`, and
//       churnSkipped === 0 → "the feed representative is CHURNED" AND "churnSkipped > 0" both red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/churn-feed-app/server.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { waitSettled } from '../../lib/browser/causal.mjs';
import { snapshotStep } from '../../lib/recon/step.mjs';
import { statefulStep } from '../../lib/recon/stateful-step.mjs';
import { statefulLoop } from '../../lib/recon/stateful-loop.mjs';
import { makeGraph } from '../../lib/graph/graph-store.mjs';
import { makeLedger } from '../../lib/graph/ids.mjs';
import { frontierInstanceStats } from '../../lib/recon/frontier.mjs';

test('a re-rendering feed drains the stable set to remaining=0 with the churn quantified, not blocking, not hidden', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-churn-'));
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  const prevState = process.env.BUGHUNTER_STATE_DIR;
  process.env.PW_ALLOW_PRIVATE = '1';
  process.env.BUGHUNTER_STATE_DIR = stateDir;

  const cold = await launch();
  t.after(async () => {
    await close(cold.browser);
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
    if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState;
  });

  const page = cold.page;
  const origin = new URL(url).origin;
  const graph = makeGraph();
  const ledger = makeLedger();

  await gotoGated(page, url);
  await waitSettled(page);
  await snapshotStep(page, graph, ledger, '/');

  const byName = (n) => Object.values(graph.elements).find((e) => e.name === n);
  const feed = byName('News 0');   // the 3 feed buttons collapse into ONE list-row template; instance[0] = "News 0"
  const stable = byName('Show status');
  const ghost = byName('Open panel');
  assert.ok(feed, 'the feed list-row template was discovered at baseline');
  assert.ok(stable, 'the stable control was discovered at baseline');
  assert.ok(ghost, 'the standalone (non-list) #ghost control was discovered at baseline');
  assert.equal(feed.listRow, true, 'the feed template is a LIST ROW (its instances sit in <li>)');
  assert.equal(ghost.listRow, undefined, '#ghost is NOT a list row (a standalone control)');
  const feedSel = feed.instances[0].instanceSelector;

  // Re-render the feed AFTER the baseline snapshot: "News 0" churns away, its positional selector goes
  // stale, and #ghost is removed.
  await page.evaluate(() => window.__churn());

  // NON-VACUOUS: the representative's stored positional selector is now STALE and #ghost is GONE, and no
  // live "News 0" button remains — so resolveHandle cannot reach the representative by ANY strategy.
  assert.equal(await page.$(feedSel), null, 'the stored positional selector for the walked feed representative is STALE');
  assert.equal(await page.$('#ghost'), null, '#ghost was removed by the churn (it must reclassify unreachable, not churned)');
  const liveNews0 = await page.getByRole('button', { name: 'News 0' }).elementHandles();
  assert.equal(liveNews0.length, 0, 'no live "News 0" button remains (the durable role+name locator also fails)');

  // Drive the LOCATION-AWARE stateful loop in place (no cold re-nav): it drains the stable control, then
  // retireLeftovers reclassifies the vanished feed representative CHURNED and the vanished #ghost UNREACHABLE.
  const step = statefulStep({ page, origin, baselineUrl: url, ledger });
  const loop = await statefulLoop(graph, { page, origin, ledger, step, budget: { steps: 20 } });
  assert.equal(loop.stopped, 'frontier-drained', 'the stateful walk drained the frontier (no live pickable candidate left)');

  // (a) THE HONESTY WIN — the STABLE set drained to remaining===0 WHILE churn is quantified > 0. LEVER 1
  // reds "remaining===0": without the peel the churned representative re-enters walkable UNEXPLORED.
  const stats = frontierInstanceStats(graph);
  assert.equal(stats.remaining, 0, 'the stable control set drained (remaining===0) despite the live feed churning');
  assert.ok(stats.churnSkipped > 0, `the vanished feed row is quantified in churnSkipped (got ${stats.churnSkipped})`);
  assert.equal(stats.churnSkipped, 1, 'exactly the one representative "News 0" churned (the other rows are drillSkipped)');

  // (b) RECLASSIFICATION — the feed representative is CHURNED, not unreachable; #ghost is the contrast.
  // LEVER 2 reds both of these (the row lands in unreachable and churnSkipped stays 0).
  assert.equal(feed.instances[0].churned, true, 'the feed representative ("News 0") is flagged CHURNED (a re-rendered-away list row)');
  assert.ok(!feed.instances[0].unreachable, 'the churned feed row is NOT conflated into unreachable');
  assert.ok(ghost.unreachable || ghost.instances[0].unreachable, 'the vanished NON-listRow #ghost stays honestly UNREACHABLE');
  assert.ok(!ghost.instances[0].churned, 'a non-list control is never churned (churn is a feed-row bucket)');

  // (c) STABLE COVERAGE — the stable control is genuine coverage.
  assert.ok(stable.explored, 'the stable control was explored');
  assert.ok(!stable.unreachable, 'the stable control is genuine coverage, not unreachable');

  // (d) ATTRIBUTION — the stable act binds request→control (wire-before-DOM).
  assert.ok(graph.requests['GET /api/status'], 'the status request node exists');
  assert.ok(
    graph.edges.some((e) => e.from === `element:${stable.templateId}` && e.to === 'request:GET /api/status'),
    'GET /api/status is causally attributed to the stable control',
  );

  // (e) CAUSAL CLEANLINESS — the in-window background poll is never credited.
  assert.equal(graph.requests['GET /api/poll'], undefined, 'the background poll is never a request node');
  assert.ok(!graph.edges.some((e) => e.to === 'request:GET /api/poll'), 'no control is credited the background poll');
  assert.ok(server.pollHits() >= 1, `the poll must have fired during the crawl (got ${server.pollHits()})`);
});
