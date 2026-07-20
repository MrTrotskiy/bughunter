// Live proof of the BFS URL route-frontier (Increment 1a): Phase-1 recon reaches pages a control
// or the element OPENER_INSTANCE_CAP alone would never touch, WITHOUT re-committing the old
// project's census inflation and WITHOUT letting discovery forge a phantom causal edge. One real
// crawl over a wide-nav fixture + an off-origin trap, plus a direct seed-only sub-test.
//
// Guards (six mechanisms; (6) — off-origin-redirect refusal, security H1 — is its own test below):
//   (1) WIDE-NAV REACH   — a control (only-p9) that lives ONLY on /p9 (the 9th of 12 nav links that
//       are ONE template's instances — beyond the element frontier's non-opener limit) is genuinely
//       explored, which requires the route-frontier to discover + snapshot /p9.
//   (2) CENSUS BOUND     — a 50-link listing (one toUrlPattern /item/:param) yields exactly ONE
//       visited representative route; the other 49 are folded into siblings, never separately visited.
//   (3) DANGER REFUSAL   — the /logout danger route is never visited (routeRefused never enqueues it).
//   (4) OFF-ORIGIN REFUSAL — the off-origin partner is never hit AND never harvested into the queue.
//   (5) ZERO PHANTOM EDGES — snapshot-only discovery opens NO causal window: a pure seed produces
//       ZERO edges, and the background /beacon poll is never causally credited during the full crawl.
//
// FAIL-ON-REVERT:
//   (1) delete seedRoutes+refill in recon-run → /p9 (a beyond-limit nav route) never visited →
//       only-p9 never discovered → "only-p9 explored" fails.
//   (2) remove the per-pattern census representative check in harvestRoutes → 50 /item routes
//       visited → the /item/:param count is 50, not 1.
//   (3) drop routeRefused in harvestRoutes/visitRoute → /logout enqueued + visited (served 200) →
//       a visited /logout route appears.
//   (4) drop the sameOrigin/isOffOriginHttp filter in harvestRoutes → /partner-zone enqueued +
//       visited → graph.routes['/partner-zone'] appears → the "never harvested" assertion fails.
//   (5) make visitRoute open a causal window / addTrigger → discovery forges edges → edges.length>0.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start, startExternal, startRedirector } from '../fixtures/wide-nav-app/server.mjs';
import { crawl } from '../../lib/recon/recon-run.mjs';
import { loadGraph, makeGraph, toUrlPattern } from '../../lib/graph/graph-store.mjs';
import { makeLedger } from '../../lib/graph/ids.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { waitSettled } from '../../lib/browser/causal.mjs';
import { snapshotStep } from '../../lib/recon/step.mjs';
import { harvestRoutes, seedRoutes, routeFrontierStats } from '../../lib/recon/route-frontier.mjs';
import { ROW_SAMPLE } from '../../lib/recon/frontier.mjs';

async function bootServers() {
  const ext = await startExternal(0);
  const externalOrigin = `http://127.0.0.1:${ext.address().port}`;
  const main = await start(0, { externalOrigin });
  const url = `http://127.0.0.1:${main.address().port}/`;
  return { ext, main, url };
}

function withEnv(stateDir) {
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  const prevState = process.env.BUGHUNTER_STATE_DIR;
  process.env.PW_ALLOW_PRIVATE = '1';
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  return () => {
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
    if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState;
  };
}

test('route-frontier: whole-site reach, census bound, danger + off-origin refusal, zero phantom edges', async (t) => {
  const { ext, main, url } = await bootServers();
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-routefront-'));
  const restoreEnv = withEnv(stateDir);
  t.after(() => {
    main.close();
    ext.close();
    rmSync(stateDir, { recursive: true, force: true });
    restoreEnv();
  });

  const res = await crawl({ url, steps: 40 });
  assert.equal(res.ok, true, 'crawl completed');
  const graph = loadGraph(path.join(stateDir, 'graph.json'));

  // (1) WIDE-NAV REACH: only-p9 lives ONLY on /p9 — reachable only because the route-frontier
  // discovered + visited /p9 (a nav route beyond the element frontier's reach), then the loop acted it.
  const onlyP9 = Object.values(graph.elements).find((n) => n.name === 'Only P9');
  assert.ok(onlyP9, 'the /p9-only control was discovered (route-frontier visited /p9)');
  assert.equal(onlyP9.route, '/p9', 'only-p9 is attributed to /p9');
  assert.ok(onlyP9.explored, 'only-p9 was explored (genuine coverage), not merely discovered');
  assert.ok(!onlyP9.unreachable, 'only-p9 is genuine coverage, not unreachable');

  // (2) CENSUS BOUND: 50 /item links (one toUrlPattern) → a HANDFUL of visited representatives, 49 folded
  // into the siblings tally — never 50 visits.
  //
  // WHY THIS IS A BOUND AND NO LONGER AN EXACT 1. The route QUEUE still enqueues exactly one representative
  // per url-pattern; that is what this guard exists to protect and it is unchanged. What changed is that
  // boundary ROW SAMPLING now walks up to ROW_SAMPLE rows of a listing instead of one, and on this fixture a
  // row click NAVIGATES — so up to ROW_SAMPLE concrete /item routes are LANDED on by acts. Those landings are
  // coverage the crawler genuinely earned, not queue entries, and the number is bounded by ROW_SAMPLE rather
  // than by the listing's length.
  //
  // Relaxing it this far is deliberate and argues against our own folding: architectural review established
  // that this census is strictly MORE aggressive than Scrapy (which never folds path values at all) and
  // Heritrix (whose PathologicalPathDecideRule matches only identical repeated segments), so it is our own
  // design risk — and its failure mode is precisely a folded sibling whose control set differs, an invisible
  // coverage loss. A few representatives shrink that risk; fifty would be the runaway this guard forbids.
  //
  // FAIL-ON-REVERT is intact: remove the per-pattern census check and all 50 are enqueued and visited, which
  // is far past ROW_SAMPLE and reds.
  const itemRoutes = Object.values(graph.routes).filter((r) => !r.pending && toUrlPattern(r.url) === '/item/:param');
  assert.ok(itemRoutes.length >= 1 && itemRoutes.length <= ROW_SAMPLE,
    `/item visits must stay bounded by the row sample (1..${ROW_SAMPLE}), got ${itemRoutes.length}`);
  assert.ok(routeFrontierStats(graph).siblingsFolded >= 49, `>=49 sibling routes folded, got ${routeFrontierStats(graph).siblingsFolded}`);

  // (3) DANGER REFUSAL: the /logout danger route is never visited (routeRefused never enqueues it).
  const logout = Object.values(graph.routes).find((r) => r.url === '/logout');
  assert.ok(!logout || logout.unreachable, 'the /logout danger route was never visited');

  // (4) OFF-ORIGIN REFUSAL: the partner is never hit, and its link is never harvested into the queue.
  assert.equal(ext.extHits(), 0, 'the off-origin partner server was never hit');
  assert.ok(!graph.routes['/partner-zone'], 'the off-origin link is never harvested into the route queue');

  // (5) ZERO PHANTOM EDGES (full-crawl half): the background /beacon poll (timer-rooted) is never
  // credited to any control, even though it ticks inside p1-load's live causal window. Non-vacuous:
  // p1-load's real request (/p1-data) IS credited, proving a window genuinely opened while it ticked.
  assert.ok(graph.requests['GET /p1-data'], 'p1-load fired /p1-data (a real causal window opened)');
  assert.ok(!graph.edges.some((e) => e.to === 'request:GET /beacon'), 'the /beacon poll is never causally credited');
});

test('route-frontier: a pure seed produces ZERO edges while visiting the whole discoverable site', async (t) => {
  const { ext, main, url } = await bootServers();
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-routeseed-'));
  const restoreEnv = withEnv(stateDir);
  const cold = await launch();
  t.after(async () => {
    await close(cold.browser);
    main.close();
    ext.close();
    rmSync(stateDir, { recursive: true, force: true });
    restoreEnv();
  });

  const page = cold.page;
  const graph = makeGraph();
  const ledger = makeLedger();
  const origin = new URL(url).origin;

  // The discovery path ONLY: baseline snapshot → harvest → BFS seed. No act, no reconLoop, so if any
  // edge appears it came from discovery itself (a causal window visitRoute must never open).
  await gotoGated(page, url);
  await waitSettled(page);
  await snapshotStep(page, graph, ledger, '/');
  await harvestRoutes(page, graph, origin);
  await seedRoutes(page, graph, ledger, { origin });

  const stats = routeFrontierStats(graph);
  assert.ok(stats.visited >= 13, `the seed visited the whole discoverable site (>=13 routes), got ${stats.visited}`);
  assert.equal(graph.edges.length, 0, `snapshot-only discovery forges ZERO edges, got ${graph.edges.length}`);
});

// (6) OFF-ORIGIN REDIRECT REFUSAL (security H1): a same-origin harvested link whose server 302s it to
// an OFF-ORIGIN host on the SAME path (which the path-only routeKey check cannot see) must NOT be
// snapshotted — the route is marked unreachable, the foreign/internal response never captured.
// FAIL-ON-REVERT: drop the sameOrigin(origin, landed) re-check in visitRoute → routeKey matches the
// path → the off-origin sink page is snapshotted → /redir-evil reads visited, not unreachable → fails.
test('route-frontier: a path-preserving off-origin redirect is refused, not snapshotted (H1)', async (t) => {
  const sink = await startExternal(0);
  const sinkOrigin = `http://127.0.0.1:${sink.address().port}`;
  const main = await startRedirector(0, { sinkOrigin });
  const url = `http://127.0.0.1:${main.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-redir-'));
  const restoreEnv = withEnv(stateDir);
  const cold = await launch();
  t.after(async () => {
    await close(cold.browser);
    main.close();
    sink.close();
    rmSync(stateDir, { recursive: true, force: true });
    restoreEnv();
  });

  const page = cold.page;
  const graph = makeGraph();
  const ledger = makeLedger();
  const origin = new URL(url).origin;

  await gotoGated(page, url);
  await waitSettled(page);
  await snapshotStep(page, graph, ledger, '/');
  await harvestRoutes(page, graph, origin); // enqueues /redir-evil (a same-origin href)
  await seedRoutes(page, graph, ledger, { origin });

  // Non-vacuous: the 302 genuinely fired to the off-origin sink (the blind GET happened)...
  assert.ok(sink.extHits() >= 1, 'the /redir-evil 302 reached the off-origin sink (the redirect actually fired)');
  // ...but the landed off-origin page is REFUSED, not snapshotted: the route is unreachable, not visited.
  const redir = graph.routes['/redir-evil'];
  assert.equal(redir && redir.unreachable, 'redirect-offorigin',
    'the path-preserving off-origin redirect is marked unreachable, its content never captured');
});
