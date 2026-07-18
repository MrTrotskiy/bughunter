// Live proof of STATEFUL LOCATION-HONESTY provenance (stateful-step.mjs reveal.statePath stamping,
// Blocker-4). On a CONSTANT-URL app (every reveal is an in-page DOM injection; the URL never changes)
// the stateful walk reaches a 2-deep reveal chain A → B → X purely by ACCUMULATED in-session state, and
// now stamps each revealed control with the accumulated opener breadcrumb — restoring the DISTINCT
// locationKeys the report otherwise collapses to ONE. The breadcrumb is PROVENANCE (marked stateful:true),
// not a replay path — nothing re-fires it, so the method it was recorded under carries no replay risk.
//
// Guards (one crawl):
//   (a) REACH — A (Open outer), B (Open inner, revealed by A), X (Show info, revealed by B) are all
//       explored, none unreachable (an in-session accumulate-state walk reaches all three).
//   (b) CAUSAL ATTRIBUTION — GET /api/info is a causal edge from X (wire-before-DOM).
//   (c) CAUSAL CLEANLINESS — the /api/poll background poll is never credited (pollHits>=2 liveness).
//   (d) PROVENANCE STAMP — X's instance carries reveal.statePath (stamped by actStep's statefulProvenance
//       widen, method-agnostic: the openers fire read-over-POST so allGet is FALSE — the stamp cannot
//       come from the vacuous GET-only default).
//   (e) PROVENANCE MARKER — X's reveal is marked stateful:true (a provenance breadcrumb, not a replay path).
//   (f) 2-DEEP ACCUMULATION — X.reveal.statePath.length === 2 and its LAST hop is X's opener B (the chain
//       accumulated A then B across acts); B.reveal.statePath.length === 1.
//   (g) LOCATION HONESTY RESTORED — frontierInstanceStats(graph).locations.discovered === 3 (was 1 before
//       the fix), and A/B/X sit at three DISTINCT locationKeys.
//
// FAIL-ON-REVERT (three levers, each reds a distinct assertion):
//   LEVER 1 — statefulProvenance gate (step.mjs): drop `statefulProvenance === true ||` from the stamp
//       gate. The openers fire POST → allGet=false → stamp=false → NO reveal stamped → guard (d)
//       "X carries a reveal provenance path" reds (and (g) collapses to locations.discovered===1).
//   LEVER 2 — the stateful:true marker: in step.mjs change `{ revealPath, stateful: statefulProvenance
//       === true }` back to `{ revealPath }` → X.reveal.stateful is undefined → guard (e) reds.
//   LEVER 3 — the chain.push accumulation (stateful-step.mjs): delete `chain.push(hop)` → the chain never
//       accumulates → X.reveal.statePath=[B] (length 1, not [A,B]) → guard (f) "statePath.length===2" reds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/stateful-location-app/server.mjs';
import { crawl } from '../../lib/recon/recon-run.mjs';
import { loadGraph } from '../../lib/graph/graph-store.mjs';
import { frontierInstanceStats } from '../../lib/recon/frontier.mjs';
import { locationKey } from '../../lib/recon/location-key.mjs';

test('stateful walk stamps the accumulated 2-deep reveal breadcrumb, restoring distinct locations on a constant URL', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-stateful-loc-'));
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

  // The openers fire benign read-over-POSTs (/api/outer, /api/inner) — this test guards the reveal
  // PROVENANCE, not any write posture.
  const res = await crawl({ url, steps: 12, stateful: true });
  assert.equal(res.ok, true, 'stateful crawl completed');

  const graph = loadGraph(path.join(stateDir, 'graph.json'));
  const A = Object.values(graph.elements).find((n) => n.name === 'Open outer');
  const B = Object.values(graph.elements).find((n) => n.name === 'Open inner');
  const X = Object.values(graph.elements).find((n) => n.name === 'Show info');
  assert.ok(A && B && X, 'all three controls of the 2-deep chain were discovered');

  // (a) REACH — every control genuine coverage, none unreachable (in-session accumulation reached all).
  for (const [nm, n] of [['A', A], ['B', B], ['X', X]]) {
    assert.ok(n.explored, `${nm} was explored`);
    assert.ok(!n.unreachable, `${nm} is genuine coverage, not unreachable`);
  }

  // (b) CAUSAL ATTRIBUTION — the terminal read is a causal edge from X (wire-before-DOM).
  assert.ok(graph.requests['GET /api/info'], 'the info request node exists');
  assert.ok(
    graph.edges.some((e) => e.from === `element:${X.templateId}` && e.to === 'request:GET /api/info'),
    'GET /api/info is attributed to X',
  );

  // (c) CAUSAL CLEANLINESS — the background poll is never credited (even across a multi-act crawl).
  assert.equal(graph.requests['GET /api/poll'], undefined, 'the background poll is not a request node');
  assert.ok(!graph.edges.some((e) => e.to === 'request:GET /api/poll'), 'no control is credited the background poll');
  assert.ok(server.pollHits() >= 2, `the poll must have fired during the crawl (got ${server.pollHits()})`);

  // The reveal we assert on is the INSTANCE-level breadcrumb (requirement: "X's instance"). X is a new
  // template AND new instance, so both carry it; the instance form is the one location-key/report read.
  const xReveal = X.instances[0].reveal;
  const bReveal = B.instances[0].reveal;

  // (d) PROVENANCE STAMP — X carries a reveal path at all (LEVER 1 reds here: no stamp when the gate is off).
  assert.ok(xReveal, 'X carries a reveal provenance path (stamped by the statefulProvenance widen)');
  assert.ok(Array.isArray(xReveal.statePath), 'X.reveal.statePath is an ordered breadcrumb');

  // (e) PROVENANCE MARKER — the reveal is flagged stateful:true (LEVER 2 reds here).
  assert.equal(xReveal.stateful, true, 'X.reveal is marked stateful:true (provenance, not a replayable path)');

  // (f) 2-DEEP ACCUMULATION — the chain accumulated A then B, so X sits behind [A, B] with B its last hop.
  assert.equal(xReveal.statePath.length, 2, 'X.reveal.statePath.length === 2 (chain accumulated across acts)');
  assert.equal(
    xReveal.statePath[xReveal.statePath.length - 1].templateId, B.templateId,
    "X's reveal path's LAST hop is its opener B",
  );
  assert.equal(xReveal.statePath[0].templateId, A.templateId, "X's reveal path's FIRST hop is the outer opener A");
  assert.ok(bReveal && bReveal.statePath.length === 1 && bReveal.statePath[0].templateId === A.templateId,
    'B (1 hop deep) is behind [A]');

  // (g) LOCATION HONESTY RESTORED — three distinct locationKeys on ONE URL (was 1 before the fix; LEVER 1
  // collapses it back to 1). A at the route root, B behind [A], X behind [A, B].
  const stats = frontierInstanceStats(graph);
  assert.equal(stats.locations.discovered, 3, `locations.discovered === 3 (constant-URL app, 3 sections); got ${stats.locations.discovered}`);
  const kA = locationKey(A.route, A.instances[0].reveal?.statePath || []);
  const kB = locationKey(B.route, bReveal.statePath);
  const kX = locationKey(X.route, xReveal.statePath);
  assert.ok(kA !== kB && kB !== kX && kA !== kX, `A/B/X sit at DISTINCT locationKeys (${kA} | ${kB} | ${kX})`);
});
