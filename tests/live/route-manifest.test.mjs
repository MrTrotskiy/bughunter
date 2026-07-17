// Live proof of the ROUTE-MANIFEST seeder: the honest route DENOMINATOR jumps from the ~1 an a[href]
// harvest finds on a constant-URL onClick SPA to the ~N the app's OWN router declares, and every
// declared section is GENUINELY visited (coverage claimed only from real visits, never the manifest).
// One real browser + the onclick-spa fixture (whose served bundle declares its router) + a full
// recon-run crawl; route-frontier's visitRoute/markRouteUnreachable are REUSED unchanged.
//
// Guards (route-manifest seeder):
//   (1) EXACT EXTRACTION + PATH-KEY PRECISION — extractRoutes returns EXACTLY the declared STATIC
//       `path:` values (a v6 RELATIVE "reports" normalized to /reports; the param one split into
//       paramRoutes), and REJECTS a NOISE bare literal ("/reactions", "/accept") that is NOT under
//       `path:` — the precision that stops the static-brain denominator inflation (a bare
//       leading-slash fallback would wrongly extract the socket.io/redux-action fragments).
//   (2) SEED EXPANDS DENOM — seedManifestRoutes puts N declared:true pending nodes in graph.routes
//       (minus the danger /logout), and the count ≫ the href-only harvest count.
//   (3) EDGE-FREE / IDENTITY-SAFE — seeding adds ZERO elements + ZERO edges (declared is additive,
//       never an identity input; no addTrigger / causal window).
//   (4) GENUINE VISITS    — a manifest-seeded crawl VISITS the real sections and markRouteUnreachable's
//       the redirecting one; report --route-coverage reports reached < declared (honest, not DRAINED).
//
// FAIL-ON-REVERT (mechanism levers):
//   (1) re-add a bare leading-slash literal fallback to extractRoutes → the NOISE "/reactions" +
//       "/accept" (NOT under `path:`) are extracted → "a bare noise literal is NOT extracted" reds.
//       Drop the EXPR_CHARS_RE check → the minified `path:")".concat(…)` fragment yields "/)" → "a
//       minified dynamic path:expr fragment (concat) is rejected" reds.
//   (2)/(4) disable the seeder (crawl({seedManifest:false}) — the differential in test 2, or
//       comment out the extractRoutes/seedManifestRoutes call in recon-run.mjs) → the denominator
//       collapses to the href-discovered count (declaredManifest 0, declared ≪ N) → "the declared
//       routes expand the denominator" reds.
//   (3) make the seeder call addTrigger / open a causal window → graph.edges.length > 0 → the
//       edge-free assertion reds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/onclick-spa/server.mjs';
import { attach, gotoGated } from '../../lib/browser/session.mjs';
import { waitSettled } from '../../lib/browser/causal.mjs';
import { extractRoutes, seedManifestRoutes, seedParamPatterns } from '../../lib/recon/route-manifest.mjs';
import { harvestRoutes, visitRoute } from '../../lib/recon/route-frontier.mjs';
import { routeCoverageOf } from '../../lib/recon/route-coverage.mjs';
import { crawl } from '../../lib/recon/recon-run.mjs';
import { report } from '../../lib/recon/report.mjs';
import { makeGraph, loadGraph } from '../../lib/graph/graph-store.mjs';
import { makeLedger } from '../../lib/graph/ids.mjs';

const STATIC = ['/a', '/b', '/c', '/d', '/logout', '/reports', '/user/settings'];

test('route-manifest: extracts the declared route list, seeds a bigger denominator, edge-free', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const origin = new URL(url).origin;
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  process.env.PW_ALLOW_PRIVATE = '1';
  t.after(() => {
    server.close();
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
  });

  const { page, release } = await attach();
  let extracted; let hrefCount;
  try {
    await gotoGated(page, url);
    await waitSettled(page);
    extracted = await extractRoutes(page);
    // The pre-manifest denominator: what an a[href]-only harvest alone collects on the home page.
    const hgraph = makeGraph();
    await harvestRoutes(page, hgraph, origin);
    hrefCount = Object.keys(hgraph.routes).length;
  } finally { await release(); }

  // (1) EXACT extraction: the declared STATIC `path:` values (sorted; the RELATIVE "reports"
  // normalized to /reports), param routes split out. PATH-KEY PRECISION: the NOISE bare literals
  // ("/reactions", "/accept") that are NOT under `path:` are REJECTED — a bare-literal fallback would
  // extract them and inflate the denominator (the static-brain failure mode).
  assert.deepEqual(extracted.routes, STATIC, `extracted static routes = ${JSON.stringify(extracted.routes)}`);
  assert.deepEqual(extracted.paramRoutes, ['/item/:id'], 'param route split into paramRoutes, not the static list');
  assert.ok(!extracted.routes.includes('/reactions') && !extracted.paramRoutes.includes('/reactions'), 'a bare noise literal is NOT extracted (path:-only precision)');
  assert.ok(!extracted.routes.includes('/accept'), 'a second bare noise fragment is NOT extracted');
  assert.ok(!extracted.routes.includes('/)'), 'a minified dynamic path:expr fragment (concat) is rejected by the expr-char filter');
  assert.ok(extracted.routes.includes('/reports'), 'a RELATIVE path:"reports" is normalized to /reports and kept');

  // (2) SEED expands the denominator: on a fresh graph the seeder adds every static route EXCEPT the
  // danger /logout (routeRefused) as declared:true pending nodes; the param pattern is counted apart.
  const graph = makeGraph();
  const seedRes = seedManifestRoutes(graph, extracted.routes, origin);
  const paramRes = seedParamPatterns(graph, extracted.paramRoutes);
  assert.equal(seedRes.seeded, 6, 'seeds the 6 non-danger static routes');
  assert.equal(seedRes.skipped, 1, 'skips exactly the danger /logout');
  assert.equal(seedRes.declaredTotal, 7);
  assert.equal(paramRes.seeded, 1);
  assert.ok(!graph.routes['/logout'], 'danger /logout is NEVER seeded');
  for (const rk of ['/a', '/b', '/c', '/d', '/reports', '/user/settings']) {
    assert.equal(graph.routes[rk].declared, true, `${rk} carries the additive declared flag`);
    assert.equal(graph.routes[rk].pending, true, `${rk} is pending → genuinely visited by visitRoute`);
  }
  assert.equal(graph.routes['/item/:id'].unreachable, 'param-pattern', 'param pattern counted, not navigated');
  assert.equal(graph.routes['/item/:id'].declared, true);

  // (3) The seed EXPANDS the denominator well beyond the href-only harvest (the revert-lever's point).
  assert.ok(hrefCount < seedRes.seeded, `href-only harvest (${hrefCount}) ≪ manifest-seeded (${seedRes.seeded})`);

  // (4) IDENTITY-SAFE / EDGE-FREE: seeding is METADATA-only — zero elements, zero edges (declared is
  // never an identity input; the seeder never addTriggers or opens a causal window).
  assert.equal(Object.keys(graph.elements).length, 0, 'seeding adds NO elements');
  assert.equal(graph.edges.length, 0, 'seeding adds NO edges (phantom-edge-safe by construction)');
});

test('route-manifest: a seeded crawl reaches declared sections, redirect→unreachable, report reached<declared', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-manifest-'));
  const stateDirNo = mkdtempSync(path.join(tmpdir(), 'bughunter-manifest-no-'));
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  const prevState = process.env.BUGHUNTER_STATE_DIR;
  process.env.PW_ALLOW_PRIVATE = '1';
  t.after(() => {
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(stateDirNo, { recursive: true, force: true });
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
    if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState;
  });

  // WITH the manifest seeder (default ON): the full crawl seeds declared routes, then visits them.
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  await crawl({ url });
  const graph = loadGraph(path.join(stateDir, 'graph.json'));

  // Coverage is claimed ONLY from real visits: the real declared sections were GENUINELY visited
  // (incl. the RELATIVE-normalized /reports).
  for (const rk of ['/a', '/b', '/c', '/user/settings', '/reports']) {
    const n = graph.routes[rk];
    assert.ok(n && !n.pending && !n.unreachable, `${rk} was genuinely visited (not pending/unreachable)`);
  }
  // The redirecting /d is markRouteUnreachable (honest), never hidden.
  assert.equal(graph.routes['/d'].unreachable, 'redirect', '/d redirect → markRouteUnreachable');
  // The danger /logout was never seeded → never navigated.
  assert.ok(!graph.routes['/logout'], 'danger route never entered the queue');
  // The param pattern is counted in the denominator, never directly navigated.
  assert.equal(graph.routes['/item/:id'].unreachable, 'param-pattern');

  // report --route-coverage: the EXACT reached/declared oracle, reached < declared (honest, not a
  // bare DRAINED). /d unreachable keeps reached below declared.
  const rc = report({ routeCoverage: true, json: true });
  assert.ok(rc.reached < rc.declared, `reached (${rc.reached}) < declared (${rc.declared})`);
  assert.ok(rc.declaredManifest >= 5, `the manifest expanded the denominator (declaredManifest=${rc.declaredManifest})`);
  assert.equal(rc.paramPatterns, 1, 'the param pattern is counted apart');
  const text = report({ routeCoverage: true });
  assert.match(text, /Route coverage: \d+ of \d+ collectable sections collected \(own content\)/);
  assert.match(text, /Not yet reached:/);

  // REVERT-LEVER / DIFFERENTIAL: the SAME crawl with the seeder OFF collapses the denominator to the
  // href-discovered count (≪ declared-with-manifest) — proving the declared routes are what expand it.
  process.env.BUGHUNTER_STATE_DIR = stateDirNo;
  await crawl({ url, seedManifest: false });
  const rcNo = report({ routeCoverage: true, json: true });
  assert.equal(rcNo.declaredManifest, 0, 'seeder OFF → zero declared-manifest sections');
  assert.ok(rcNo.declared < rc.declared, `seeder OFF collapses the denominator (${rcNo.declared} < ${rc.declared})`);
});

// HONEST route coverage (the over-count fix): a "reached" route is only genuinely COLLECTED when it
// rendered its OWN content. Two dishonesty modes proven against the truth:
//   (Fix 1) a SAME-ORIGIN CLIENT-SIDE redirect (/redir → /) must read UNREACHABLE, not visited — its
//           pre-settle URL is still /redir (the old guard passed it); only the POST-settle re-read catches it.
//   (Fix 2) a visited route with ZERO controls (/empty) is "visited but empty", NOT collected; the
//           collected count equals ONLY the routes with own elements (/a).
// Direct visitRoute drive (no full crawl) so the three buckets are asserted in isolation.
//
// FAIL-ON-REVERT:
//   (Fix 1) remove the POST-settle same-origin redirect re-read in visitRoute → /redir snapshots the
//           landed "/" DOM (a phantom control) under /redir → "a same-origin redirect must not count as
//           a reached section" reds (/redir.unreachable is no longer 'redirect').
//   (Fix 2) collapse the visited-but-empty bucket into collected (collected := reached) → /empty inflates
//           collected to 2 → "a visited-but-empty section must not count as collected" reds.
test('route-coverage: same-origin redirect → unreachable, empty page → visited-but-empty, collected = own-content only', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const origin = new URL(url).origin;
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  process.env.PW_ALLOW_PRIVATE = '1';
  t.after(() => {
    server.close();
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
  });

  const { page, release } = await attach();
  const graph = makeGraph();
  const ledger = makeLedger();
  try {
    await gotoGated(page, url); // initialise the probe/context before the per-route visits
    // markRouteUnreachable/markRouteVisited only record on a PRE-EXISTING node — seed the three as pending.
    for (const rk of ['/a', '/empty', '/redir']) graph.routes[rk] = { type: 'route', url: rk, pending: true, declared: true };
    for (const rk of ['/a', '/empty', '/redir']) await visitRoute(page, graph, ledger, rk, { origin });
  } finally { await release(); }

  // Fix 1: the same-origin client redirect is UNREACHABLE, never a reached section, and not left pending.
  assert.equal(graph.routes['/redir'].unreachable, 'redirect', 'a same-origin redirect must not count as a reached section');
  assert.ok(!graph.routes['/redir'].pending, '/redir is resolved out of the pending queue');
  // /a rendered its own control; /empty was genuinely visited (not pending/unreachable) but bare.
  assert.ok(!graph.routes['/a'].pending && !graph.routes['/a'].unreachable, '/a genuinely visited');
  assert.ok(!graph.routes['/empty'].pending && !graph.routes['/empty'].unreachable, '/empty genuinely visited');
  const routesWithElements = new Set(Object.values(graph.elements).map((el) => el.route));
  assert.ok(routesWithElements.has('/a'), '/a attributed its own control (button)');
  assert.ok(!routesWithElements.has('/empty'), '/empty attributed ZERO controls');
  assert.ok(!routesWithElements.has('/redir'), '/redir never snapshotted → no phantom control attributed');

  // Fix 2: the honest buckets — collected counts ONLY routes with own content, /empty is visited-but-empty.
  const rc = routeCoverageOf(graph);
  assert.equal(rc.collected, 1, 'a visited-but-empty section must not count as collected'); // /a only
  assert.equal(rc.collected, [...routesWithElements].filter((r) => r === '/a').length, 'collected == the routes with own elements');
  assert.ok(rc.visitedEmpty.includes('/empty'), '/empty is surfaced in the visited-but-empty list, not hidden');
  assert.ok(!rc.visitedEmpty.includes('/a'), '/a (own content) is NOT in visited-but-empty');
  const emptyReason = rc.notReached.find((n) => n.route === '/redir');
  assert.equal(emptyReason && emptyReason.reason, 'redirect', '/redir listed as unreachable:redirect in the gap');
});
