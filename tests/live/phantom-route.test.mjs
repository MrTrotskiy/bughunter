// Live proof of the GOAL-1 HONEST DENOMINATOR (phantom-route detection) on a constant-URL 200-everywhere
// SPA. The route-manifest seeds a denominator that INCLUDES dead routes (client-redirect + client-404);
// counting them collapses "95%" into an unreachable target. This drives the phantom-route fixture through
// the SAME edge-free discovery path recon-run/route-cli use (harvest → probeNotFound → seed) and asserts
// every phantom is RELABELLED out of the collectable base — never dropped, never collapsing the denominator.
//
// Guards:
//   (Q1a) LATE client-redirect — /legacy replaceState('/dashboard') 200ms AFTER the page settles is caught
//         by visitRoute's BOUNDED routeKey poll → unreachable:'redirect'. A single post-settle read (the
//         pre-poll behavior) fires before the 200ms hop and MISSES it — only the poll catches it.
//   (Q1b) FAST client-redirect — /old-home replaceState('/') during first render is caught by the pre-settle
//         read (the poll is only the LATE-class fix, not a blanket window).
//   (Q2a) CLIENT-404 — /groups + /settings/privacy render the shared Not-Found shell; their contentSig equals
//         the negative-control probe sig (graph.notFoundSig from probeNotFound), so route-coverage labels
//         them client-404 and drops them from the collectable base.
//   (Q2b) NEGATIVE CONTROL — /inbox is a REAL content-starved section (own <h1>, ZERO controls): a DISTINCT
//         contentSig, so it STAYS visited-but-empty, never mislabelled client-404. This is the case a naive
//         "N empty routes share a sig → collapse" dedup fails and the probe-anchor passes.
//   (HONEST) the collectable base = declared − redirect − client-404 (the 4 real sections), collected = 3;
//         all 8 declared sections stay counted (relabelled, never a silent collapse).
//   (EDGE-FREE) discovery + the probe forge ZERO causal edges (attribution stays token+initiator).
//
// FAIL-ON-REVERT:
//   (Q1a) replace the visitRoute poll with a single post-settle read → /legacy snapshots visited-but-empty
//         (the "Loading…" h1) under /legacy → "/legacy LATE redirect caught" reds.
//   (Q2a) neuter probeNotFound (leave graph.notFoundSig unset) OR the empty-only sig match in route-coverage
//         → /groups is NOT client-404 → the clientNotFound assertion reds.
//   (Q2b) widen the dedup to collapse ANY shared-sig empties (cluster mode) → /inbox could be mislabelled →
//         but its DISTINCT sig keeps it visited-empty; drop the contentSig write in visitRoute → /groups
//         loses its sig → not client-404 → the collectable count reds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/phantom-route-app/server.mjs';
import { makeGraph } from '../../lib/graph/graph-store.mjs';
import { makeLedger } from '../../lib/graph/ids.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { waitSettled } from '../../lib/browser/causal.mjs';
import { snapshotStep } from '../../lib/recon/step.mjs';
import { harvestRoutes, seedRoutes, probeNotFound } from '../../lib/recon/route-frontier.mjs';
import { routeCoverageOf } from '../../lib/recon/route-coverage.mjs';

test('phantom-route: late+fast redirects relabelled, client-404 detected via probe, /inbox spared, edge-free', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-phantom-'));
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

  // The edge-free discovery path ONLY (no act, no reconLoop): baseline snapshot → harvest the nav links →
  // fingerprint the Not-Found shell → BFS-seed every discovered route. Any edge that appears came from
  // discovery itself (a causal window visitRoute/probeNotFound must never open).
  await gotoGated(page, url);
  await waitSettled(page);
  await snapshotStep(page, graph, ledger, '/');
  await harvestRoutes(page, graph, origin);
  await probeNotFound(page, graph, origin);
  await seedRoutes(page, graph, ledger, { origin });

  assert.ok(graph.notFoundSig, 'the negative-control probe fingerprinted the Not-Found shell (graph.notFoundSig set)');

  // (Q1) both redirects are relabelled unreachable, not counted as visited sections.
  assert.equal(graph.routes['/legacy'] && graph.routes['/legacy'].unreachable, 'redirect', '/legacy LATE redirect (200ms post-settle) caught by the bounded poll');
  assert.equal(graph.routes['/old-home'] && graph.routes['/old-home'].unreachable, 'redirect', '/old-home FAST redirect caught pre-settle');

  // (Q2a) the two dead routes render the shared Not-Found shell → their sig matches the probe.
  assert.equal(graph.routes['/groups'] && graph.routes['/groups'].contentSig, graph.notFoundSig, '/groups renders the Not-Found shell (contentSig === probe sig)');
  assert.equal(graph.routes['/settings/privacy'] && graph.routes['/settings/privacy'].contentSig, graph.notFoundSig, '/settings/privacy contentSig === probe sig');
  // (Q2b) the real content-starved section has a DISTINCT sig — the negative-control that the cluster approach would false-collapse.
  const inbox = graph.routes['/inbox'];
  assert.ok(inbox && inbox.contentSig && inbox.contentSig !== graph.notFoundSig, '/inbox (real, content-starved) has a DISTINCT contentSig, not the Not-Found sig');

  // Report-time buckets: client-404 relabelled OUT of collectable; /inbox stays a real visited-but-empty.
  const rc = routeCoverageOf(graph);
  assert.equal(rc.clientNotFound404, 2, `exactly the two dead routes are client-404, got ${rc.clientNotFound404}`);
  assert.ok(rc.clientNotFound.includes('/groups') && rc.clientNotFound.includes('/settings/privacy'), 'both dead routes are in the client-404 list');
  assert.ok(rc.visitedEmpty.includes('/inbox'), '/inbox stays visited-but-empty (real, distinct sig)');
  assert.ok(!rc.clientNotFound.includes('/inbox'), '/inbox is NOT mislabelled client-404 (the guard the cluster approach fails)');
  assert.equal(rc.collected, 3, `the 3 real sections with own content are collected (/ /dashboard /reports), got ${rc.collected}`);
  assert.equal(rc.declared, 8, 'all 8 declared sections stay counted — the denominator is relabelled, never collapsed');
  assert.equal(rc.collectable, 4, `collectable = declared(8) − redirect(2) − client-404(2) = 4 (3 collected + /inbox empty), got ${rc.collectable}`);

  // (EDGE-FREE) snapshot-only discovery + the negative-control probe open no causal window.
  assert.equal(graph.edges.length, 0, `discovery + probe forge ZERO causal edges, got ${graph.edges.length}`);
});
