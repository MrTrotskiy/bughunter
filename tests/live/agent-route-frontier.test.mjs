// Live proof of the AGENT-PATH BFS URL route-frontier (Increment 1b): whole-site route collection
// works on the path the OPERATOR runs (/recon, Sonnet-driven), not only the node-loop (recon-run).
// The recon subagent keeps ACTING (whats-new); the /recon DRIVER navigates queued routes via
// route-cli. This drives those exact agent-path primitives against the wide-nav fixture (reused from
// INC.1a) over the shared daemon, so ~N attaches share ONE browser process.
//
// Guards (INC.1b agent path):
//   (1) BASELINE HARVEST — whats-new's baseline snapshot harvests the home page's a[href] into the
//       route frontier, so frontier-cli --emit reports pendingRoutes > 0 (the queue the driver drains).
//   (2) DRIVER REACH     — route-cli --visit-next snapshot-visits a page BEYOND the element cap (/p9,
//       the 9th of 12 one-template nav instances), so only-p9 (a control living ONLY on /p9) is
//       discovered and becomes a reachable frontier candidate — coverage no single control click reaches.
//   (3) EDGE-FREE (CAUSAL) — the agent-path route drive (baseline + N route-cli visits) forges ZERO
//       CAUSAL edges: discovery navigates, it never acts / opens a causal window / addTrigger. Structural
//       page→page `nav` edges (the baseline a[href] harvest, non-causal) are excluded from the count.
//
// FAIL-ON-REVERT:
//   (1)/(2) remove the whats-new baseline harvestRoutes call → pendingRoutes stays 0 → route-cli's
//       queue is empty → /p9 is never visited → only-p9 never discovered → the pendingRoutes and
//       "only-p9 discovered" assertions red.
//   (3) make visitRoute open a causal window / addTrigger → discovery forges a CAUSAL (non-nav) edge →
//       causalEdges.length>0.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start, startExternal } from '../fixtures/wide-nav-app/server.mjs';
import { start as startSession, stop as stopSession } from '../../lib/recon/recon-session.mjs';
import { run as whatsNew } from '../../lib/recon/whats-new.mjs';
import { run as routeVisitNext } from '../../lib/recon/route-cli.mjs';
import { emit } from '../../lib/recon/frontier-cli.mjs';
import { loadGraph, toUrlPattern } from '../../lib/graph/graph-store.mjs';

test('agent-path route-frontier: baseline harvests routes, route-cli reaches a beyond-cap page, edge-free', async (t) => {
  const ext = await startExternal(0);
  const externalOrigin = `http://127.0.0.1:${ext.address().port}`;
  const main = await start(0, { externalOrigin });
  const url = `http://127.0.0.1:${main.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-agentroute-'));
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  const prevState = process.env.BUGHUNTER_STATE_DIR;
  process.env.PW_ALLOW_PRIVATE = '1';
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  // Shared daemon so baseline + every route-cli visit connect to ONE browser process (fast, and the
  // realistic /recon path) rather than cold-launching a chromium per call.
  await startSession();
  t.after(async () => {
    await stopSession();
    main.close();
    ext.close();
    rmSync(stateDir, { recursive: true, force: true });
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
    if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState;
  });

  const graphPath = path.join(stateDir, 'graph.json');

  // (1) BASELINE — whats-new snapshots the home page AND harvests its a[href] into the route queue.
  await whatsNew({ url });
  const e1 = emit();
  assert.ok(e1.pendingRoutes > 0, `baseline harvest must queue pending routes, got ${e1.pendingRoutes}`);
  assert.ok(e1.routeFrontierStats, 'emit surfaces routeFrontierStats for the driver');
  assert.equal(e1.routeFrontierStats.pending, e1.pendingRoutes, 'pendingRoutes mirrors routeFrontierStats.pending');

  // (2) DRIVER DRAINS THE ROUTE QUEUE — route-cli --visit-next, one page per call, until empty. /p9
  // (the 9th of 12 one-template nav instances) is beyond the element frontier's non-opener limit, so
  // it is reachable ONLY by the route frontier snapshot-visiting it.
  let guard = 0;
  for (;;) {
    const r = await routeVisitNext({ url });
    if (r.routeStats.pending === 0) break;
    if (++guard > 60) throw new Error('route queue did not drain within the guard bound');
  }

  const graph = loadGraph(graphPath);

  // /p9 was snapshot-visited (not pending, not unreachable) by the driver.
  const p9 = graph.routes['/p9'];
  assert.ok(p9 && !p9.pending && !p9.unreachable, 'the driver snapshot-visited /p9 (a beyond-cap nav route)');

  // only-p9 lives ONLY on /p9 → discovered because route-cli visited /p9. It is a genuine, reachable
  // frontier candidate (has an instance, not unreachable, not yet explored — an act would explore it;
  // route-cli only DISCOVERS, never acts, per Explored ⟺ observed).
  const onlyP9 = Object.values(graph.elements).find((n) => n.name === 'Only P9');
  assert.ok(onlyP9, 'only-p9 discovered via route-cli visiting /p9 (beyond the element cap)');
  assert.equal(onlyP9.route, '/p9', 'only-p9 attributed to /p9');
  assert.ok(onlyP9.instances.length >= 1, 'only-p9 has an addressable instance');
  assert.ok(!onlyP9.unreachable, 'only-p9 is a reachable coverage candidate, not unreachable');
  assert.ok(!onlyP9.explored, 'route-cli discovers but never explores — only an act explores');

  // Census bound carried onto the agent path: the 50 /item links fold to ONE visited representative.
  const itemRoutes = Object.values(graph.routes).filter((r) => !r.pending && toUrlPattern(r.url) === '/item/:param');
  assert.equal(itemRoutes.length, 1, `exactly one representative /item route visited, got ${itemRoutes.length}`);

  // (3) EDGE-FREE (CAUSAL) — the whole agent-path route drive forged ZERO CAUSAL edges (baseline did not
  // act; route-cli is snapshot-only). Discovery must never forge a phantom ATTRIBUTION edge (the
  // predecessor's bug). Structural page→page `nav` edges from the baseline a[href] harvest (nav-links.mjs
  // — provenance:'href', no beginCause/addTrigger/causal window) are non-causal and EXPECTED here, so they
  // are excluded: the invariant guarded is "discovery credits no request to a control", not "adds no edge".
  const causalEdges = graph.edges.filter((e) => e.type !== 'nav');
  assert.equal(causalEdges.length, 0, `agent-path route discovery forges ZERO causal edges, got ${causalEdges.length} (nav edges excluded)`);
});
