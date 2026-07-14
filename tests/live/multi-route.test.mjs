// Live proof that Phase-1 recon crawls MORE THAN ONE same-origin page, attributes each
// page's controls to the route it landed on, and NEVER fires an off-origin link. This is
// the "run on any site, collect more than the entry page" capability. A real crawl over a
// two-page fixture + an off-origin trap server.
//
// Guards (three mechanisms, one crawl):
//   (1) MULTI-ROUTE REACH — a control that exists only on /products (Filter) is reached
//       and genuinely explored, which requires the step to re-navigate to the template's
//       OWN route, not the entry page.
//   (2) ROUTE ATTRIBUTION — Filter's node.route is /products (where the act landed), not /
//       (where the crawl started); revealed controls merge under routeKey(page.url()).
//   (3) ORIGIN SCOPING — the off-origin link is never clicked, so the partner server gets
//       ZERO hits; it is recorded (explored), never fired.
// FAIL-ON-REVERT:
//   (1) revert persistentStep to navigate to the run origin instead of target.route →
//       Filter's instance never resolves on / → NO_INSTANCE → node.unreachable set →
//       "Filter genuinely explored" fails.
//   (2) merge the after-snapshot under a fixed baseline route again (drop landedRoute in
//       actStep) → /products controls land under / → graph has no '/products' route →
//       "graph mapped /products" fails.
//   (3) drop the off-origin href check in actStep → the ext link is clicked → the browser
//       navigates to the partner server → extHits() >= 1 → "off-origin link never fired" fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start, startExternal } from '../fixtures/multi-route-app/server.mjs';
import { crawl } from '../../lib/recon/recon-run.mjs';
import { loadGraph } from '../../lib/graph/graph-store.mjs';

test('recon crawls multiple same-origin routes and never fires an off-origin link', async (t) => {
  const ext = await startExternal(0);
  const externalOrigin = `http://127.0.0.1:${ext.address().port}`;
  const main = await start(0, { externalOrigin });
  const url = `http://127.0.0.1:${main.address().port}/`;

  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-multiroute-'));
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  const prevState = process.env.BUGHUNTER_STATE_DIR;
  process.env.PW_ALLOW_PRIVATE = '1';
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  t.after(() => {
    main.close();
    ext.close();
    rmSync(stateDir, { recursive: true, force: true });
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
    if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState;
  });

  const res = await crawl({ url, steps: 10 });
  assert.equal(res.ok, true, 'crawl completed');
  assert.ok(res.stats.routes >= 2, `at least two routes mapped, got ${res.stats.routes}`);

  const graph = loadGraph(path.join(stateDir, 'graph.json'));

  // (1)+(2): a /products-only control is discovered UNDER /products and genuinely explored.
  const filter = Object.values(graph.elements).find((n) => n.name === 'Filter results');
  assert.ok(filter, 'the /products-only Filter control was discovered');
  assert.equal(filter.route, '/products', 'Filter is attributed to /products, not the entry route');
  assert.ok(filter.explored, 'Filter was explored (reached by navigating to its own route)');
  assert.ok(!filter.unreachable, 'Filter is genuine coverage, not unreachable');
  assert.ok(graph.routes['/products'], 'the graph mapped the /products route');

  // (3): the off-origin link was recorded but NEVER clicked — the partner server saw nothing.
  assert.equal(ext.extHits(), 0, 'the off-origin link must never be fired');
});
