// Live proof of GOAL 2 — param-instance harvest (collect the dark `:param` patterns). The manifest seeds
// `/nugget/:id` + `/user/:handle` into the denominator as `param-pattern` (counted, never navigated, 0
// collected). This drives the EDGE-FREE seed path (baseline → manifest seed → harvest → BFS visit) and
// asserts each pattern flips to collected VIA a genuinely-visited concrete representative — census-bounded
// (one visit per pattern, the rest folded), and for a STRING-keyed param the toUrlPattern census can't fold.
//
// Guards:
//   (NUMERIC) `/nugget/:id`: exactly ONE concrete (/nugget/1) is visited (census bound), tagged
//     paramInstanceOf `/nugget/:id`, the other rows folded as siblings.
//   (STRING-KEYED) `/user/:handle`: the STRUCTURAL matchParamPattern (segment-align) links /user/alice →
//     `/user/:handle` — toUrlPattern leaves a word segment unmasked, so pattern-equality would miss it —
//     and folds /user/bob as a sibling (one visit).
//   (COVERAGE) routeCoverageOf: paramCollected===2, collectedTotal folds both patterns in, the concrete
//     proxies are NOT counted as their own static sections (no denominator inflation).
//
// FAIL-ON-REVERT:
//   drop `tagParamInstance`/the harvest param-branch → the concrete is not linked → paramCollected 2→0 →
//     "both patterns collected" reds. Drop the string-keyed structural fold → /user/bob is visited separately
//     → visitedUsers 1→2 → the census assertion reds. Count the proxy as a section → collected inflates.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/param-feed-app/server.mjs';
import { makeGraph, loadGraph } from '../../lib/graph/graph-store.mjs';
import { makeLedger } from '../../lib/graph/ids.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { waitSettled } from '../../lib/browser/causal.mjs';
import { snapshotStep } from '../../lib/recon/step.mjs';
import { harvestRoutes, seedRoutes } from '../../lib/recon/route-frontier.mjs';
import { extractRoutes, seedManifestRoutes, seedParamPatterns } from '../../lib/recon/route-manifest.mjs';
import { routeCoverageOf } from '../../lib/recon/route-coverage.mjs';

test('param-instance: a :param pattern is collected via a visited concrete (numeric + string-keyed), census-bounded', async (t) => {
  const server = await start(0, { rows: 5 });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-param-'));
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
  const graph = makeGraph();
  const ledger = makeLedger();
  const origin = new URL(url).origin;

  // Edge-free seed path (no reconLoop act, so the census is isolated from a drill-nav): baseline snapshot →
  // manifest seed (the `:param` patterns) → harvest the home feed's a[href] → BFS-visit the queue.
  await gotoGated(page, url);
  await waitSettled(page);
  await snapshotStep(page, graph, ledger, '/');
  const manifest = await extractRoutes(page);
  seedManifestRoutes(graph, manifest.routes, origin);
  seedParamPatterns(graph, manifest.paramRoutes);
  await harvestRoutes(page, graph, origin);
  await seedRoutes(page, graph, ledger, { origin });

  // The patterns were seeded, never navigated as literals (the literal /nugget/:id would 404).
  assert.equal(graph.routes['/nugget/:id'] && graph.routes['/nugget/:id'].unreachable, 'param-pattern', '/nugget/:id seeded as a param pattern');
  assert.equal(graph.routes['/user/:handle'] && graph.routes['/user/:handle'].unreachable, 'param-pattern', '/user/:handle seeded (string-keyed)');

  // NUMERIC: exactly ONE concrete visited (census bound), linked to the pattern, others folded.
  const nuggets = Object.values(graph.routes).filter((r) => /^\/nugget\/\d+$/.test(r.url));
  const visitedNuggets = nuggets.filter((r) => !r.pending && !r.unreachable);
  assert.equal(visitedNuggets.length, 1, `exactly one /nugget concrete visited (census), got ${visitedNuggets.length}`);
  assert.equal(visitedNuggets[0].paramInstanceOf, '/nugget/:id', 'the representative is linked to /nugget/:id');
  assert.ok((visitedNuggets[0].siblings || 0) >= 1, 'the other /nugget rows folded as siblings');

  // STRING-KEYED: the structural matcher linked ONE /user concrete (alice) → /user/:handle and folded bob.
  const userInsts = Object.values(graph.routes).filter((r) => r.paramInstanceOf === '/user/:handle' && !r.pending && !r.unreachable);
  assert.equal(userInsts.length, 1, `exactly one /user/:handle instance visited (string-keyed census), got ${userInsts.length}`);
  assert.match(userInsts[0].url, /^\/user\/(alice|bob)$/, 'the representative is a string-keyed concrete of /user/:handle');

  // DENOMINATOR-COLLAPSE GUARD (bughunter MUST FIX): /user/settings is a DECLARED static sharing
  // /user/:handle's shape — it must stay its OWN collected section, NEVER be tagged a /user/:handle proxy.
  const settings = graph.routes['/user/settings'];
  assert.ok(settings && settings.declared === true, '/user/settings is a declared section');
  assert.equal(settings.paramInstanceOf, undefined, '/user/settings is NOT tagged a param proxy (stays in the denominator)');
  assert.ok(!settings.pending && !settings.unreachable, '/user/settings was genuinely visited');

  // route-coverage: both param patterns collected via a real concrete visit; proxies not counted as sections;
  // the declared /user/settings is counted as its OWN collected static section.
  const rc = routeCoverageOf(graph);
  assert.equal(rc.paramCollected, 2, `both :param patterns collected via a concrete, got ${rc.paramCollected}`);
  assert.equal(rc.collectedTotal, rc.collected + 2, 'collectedTotal folds in the 2 param patterns');
  assert.ok(
    rc.paramCollectedList.some((x) => x.pattern === '/nugget/:id') && rc.paramCollectedList.some((x) => x.pattern === '/user/:handle'),
    'both patterns are listed collected-via a concrete',
  );
  assert.ok(rc.paramCollectedList.every((x) => x.via !== '/user/settings'), '/user/settings is never a param representative');
  assert.ok(!rc.paramCollectedList.some((x) => String(x.via).includes(':')), 'the representative is a CONCRETE route, not the pattern literal');
});
