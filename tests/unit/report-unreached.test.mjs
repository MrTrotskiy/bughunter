// report --unreached — the fail-reason histogram (the go/no-go artifact). Pure classifier
// (buildUnreached) over a constructed graph + a synthetic act.failed trail, plus the two
// trail readers (readActFailed / latestRunId) and the report() end-to-end wiring. No browser.
//
// Guards: (1) every NOT-fully-exercised control lands in the RIGHT fail-reason bucket, and the
//   trail's GRANULAR code OVERRIDES the graph's coarse reason (the precedence that makes the
//   histogram diagnostic instead of "everything is unreachable-coldstart"); (2) a danger-floor
//   skipped control is surfaced as NOT covered even though it reads `explored`; (3) the honest
//   flags — routeCollapse:'split-by-location', the graduated location count, and the
//   no-invented-never-discovered note (now naming undiscovered locations too) — are emitted, never a
//   fabricated split/count; (4) the trail readers parse only act.failed and pick the most recent run;
//   (5) report() renders the block with the budget/location tag; (6) computing locations NEVER enters
//   graph identity (no node/edge gains a locationKey, no mutation, diffIdentity ok).
// FAIL-ON-REVERT (a): drop the trail-code precedence in unreached.mjs (bucket by the coarse
//   graph reason, ignoring lastCode) → template 5 buckets 'not-visible' not 'REVEAL_STALE' →
//   the `buckets['REVEAL_STALE'] === 1` assertion reds.
// FAIL-ON-REVERT (b): remove the danger-floor branch (treat explored+!unreachable as covered)
//   → 'danger-floor' bucket disappears, uncovered drops to 3 → the bucket + count reds.
// FAIL-ON-REVERT (c): readActFailed drops the `kind !== 'act.failed'` filter → returns 3 rows
//   not 1 → reds; latestRunId returns names[0] (min) → returns the older run → reds.
// FAIL-ON-REVERT (d): drop the location tag in renderUnreached → the unexplored line loses
//   '[budget — discovered locations: N]' → the text assertion reds; revert routeCollapse to
//   'pending-INC.3' → the split-by-location assertion reds.
// FAIL-ON-REVERT (e): store the computed locationKey on any node/edge → the identity-proof test's
//   "no locationKey field" / JSON-unchanged assertions red (locationKey must stay reporting-only).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  makeGraph, mergeSnapshot, markExplored, markUnreachable, recordSemantics, markOpener, saveGraph,
} from '../../lib/graph/graph-store.mjs';
import { frontierInstanceStats } from '../../lib/recon/frontier.mjs';
import { buildUnreached, renderUnreached } from '../../lib/recon/unreached.mjs';
import { diffIdentity } from '../../lib/graph/identity-diff.mjs';
import { readActFailed, latestRunId, runDir } from '../../lib/debug/trace.mjs';
import { report } from '../../lib/recon/report.mjs';

// One element descriptor for mergeSnapshot (template + one instance).
function el(templateId, i = 0) {
  const key = `#${i + 1}`;
  return {
    templateId, instanceId: templateId * 100 + i,
    templateSelector: `button.t${templateId}`, role: 'button', name: `T${templateId}`,
    instanceKey: key, instanceSelector: `button.t${templateId}${key}`, visible: true,
  };
}

// A graph with one template of EACH class the histogram must distinguish.
function classGraph() {
  const g = makeGraph();
  // covered — genuinely explored + acted (real coverage; must not appear in any bucket).
  mergeSnapshot(g, '/', [el(3)]);
  markExplored(g, 3);
  recordSemantics(g, 3, { purpose: 'save', danger: 'safe', effect: 'request', acted: true });
  // unreachable WITH a matching trail code (granular code must override the coarse reason).
  mergeSnapshot(g, '/', [el(5)]);
  markExplored(g, 5);
  markUnreachable(g, 5, 'not-visible');
  // unreachable with ONLY the coarse graph reason, no trail event.
  mergeSnapshot(g, '/', [el(7)]);
  markExplored(g, 7);
  markUnreachable(g, 7, 'unreachable-coldstart');
  // unexplored — the frontier never drained it.
  mergeSnapshot(g, '/', [el(9)]);
  // danger-skipped — observed but the danger-floor refused to fire (acted:false + danger set).
  mergeSnapshot(g, '/', [el(11)]);
  markExplored(g, 11);
  recordSemantics(g, 11, { purpose: 'delete account', danger: 'destructive', effect: 'none', acted: false });
  // opener with 10 instances (> OPENER_INSTANCE_CAP 8) → nonzero cappedRemainder.
  mergeSnapshot(g, '/', Array.from({ length: 10 }, (_, i) => el(13, i)));
  markOpener(g, 13);
  markExplored(g, 13);
  recordSemantics(g, 13, { purpose: 'nav', danger: 'safe', effect: 'reveal', acted: true });
  return g;
}

test('buildUnreached: fail-reason buckets, trail-code precedence, honest flags', () => {
  const g = classGraph();
  // Two act.failed for template 5 — the LATEST (REVEAL_STALE) must win over the earlier one.
  const actFailed = [
    { templateId: 5, instance: null, code: 'NOT_VISIBLE', message: 'hidden' },
    { templateId: 5, instance: null, code: 'REVEAL_STALE', message: 'stale reveal path' },
  ];
  const instanceStats = frontierInstanceStats(g);
  const rep = buildUnreached(g, actFailed, instanceStats, 'r-fixture');

  // Bucket distribution — one of each uncovered class, covered templates absent.
  assert.equal(rep.buckets['danger-floor'], 1, 'the danger-floor-skipped control is its own bucket');
  assert.equal(rep.buckets['REVEAL_STALE'], 1, 'the granular trail code overrides the coarse reason');
  assert.equal(rep.buckets['not-visible'], undefined, 'the coarse reason is NOT used when a trail code exists');
  assert.equal(rep.buckets['unreachable-coldstart'], 1, 'a trail-less control buckets by its coarse reason');
  assert.equal(rep.buckets['unexplored'], 1, 'a never-drained control buckets as unexplored');

  assert.equal(rep.discovered, 6, 'every discovered template is counted');
  assert.equal(rep.uncovered, 4, 'uncovered is the sum of bucket counts (danger-floor NOT covered)');
  // Covered = discovered - uncovered = templates 3 and 13 only.
  assert.equal(rep.discovered - rep.uncovered, 2, 'only the genuinely acted templates count as covered');

  // Honest flags — the location split is now REAL for the discovered set.
  assert.equal(rep.routeCollapse, 'split-by-location', 'the pending-INC.3 placeholder is retired for discovered locations');
  assert.ok(rep.locations && rep.locations.discovered >= 1, 'the discovered-location count rides the report');
  assert.equal(rep.cappedRemainder, 2, 'opener instances beyond the cap are surfaced');
  assert.ok(rep.instanceCoverage && rep.instanceCoverage.cappedRemainder === 2, 'instance coverage carries the remainder');
  assert.equal(rep.runId, 'r-fixture', 'the run id rides the report');
  assert.ok(/never-discovered/.test(rep.note), 'the note names the uncountable never-discovered gap');
  assert.ok(/undiscovered/.test(rep.note), 'the note extends to undiscovered POST-nav locations, not overclaiming completeness');
  assert.ok(!('neverDiscovered' in rep) && !('undiscovered' in rep), 'no fabricated never-discovered count is invented');
});

test('trail readers: readActFailed parses act.failed, latestRunId picks the largest run', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bughunter-unr-tr-'));
  const prevDir = process.env.BUGHUNTER_STATE_DIR;
  process.env.BUGHUNTER_STATE_DIR = dir;
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevDir === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevDir;
  });

  const older = 'r-20260716120000-aaaa';
  const newer = 'r-20260716130000-bbbb';
  mkdirSync(runDir(older), { recursive: true });
  mkdirSync(runDir(newer), { recursive: true });
  // Mixed events in the newer run — only the act.failed line must be returned.
  const lines = [
    { seq: 0, ts: 1, kind: 'route', payload: { route: '/' } },
    { seq: 1, ts: 2, kind: 'act.failed', payload: { templateId: 5, instance: '#2', code: 'REVEAL_STALE', message: 'stale' } },
    { seq: 2, ts: 3, kind: 'act', payload: { templateId: 3 } },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n';
  writeFileSync(path.join(runDir(newer), 'events.ndjson'), lines);

  assert.equal(latestRunId(), newer, 'latestRunId returns the lexicographically-largest (most recent) run');

  const failed = readActFailed(newer);
  assert.equal(failed.length, 1, 'only act.failed events are returned, not route/act');
  assert.deepEqual(failed[0], { templateId: 5, instance: '#2', code: 'REVEAL_STALE', message: 'stale' }, 'the granular code + context is parsed');
});

test('report --unreached: end-to-end JSON + text render over the graph and trail', (t) => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bughunter-unr-e2e-'));
  const prevDir = process.env.BUGHUNTER_STATE_DIR;
  const prevRun = process.env.BUGHUNTER_RUN_ID;
  process.env.BUGHUNTER_STATE_DIR = dir;
  delete process.env.BUGHUNTER_RUN_ID; // the env source must not shadow the explicit --run
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prevDir === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevDir;
    if (prevRun === undefined) delete process.env.BUGHUNTER_RUN_ID; else process.env.BUGHUNTER_RUN_ID = prevRun;
  });

  const g = makeGraph();
  mergeSnapshot(g, '/', [el(3)]); // unexplored — carries the route-collapse tag
  mergeSnapshot(g, '/', [el(5)]); // unreachable + a granular trail code
  markExplored(g, 5);
  markUnreachable(g, 5, 'not-visible');
  saveGraph(path.join(dir, 'graph.json'), g);

  const runId = 'r-20260716140000-cccc';
  mkdirSync(runDir(runId), { recursive: true });
  writeFileSync(path.join(runDir(runId), 'events.ndjson'),
    JSON.stringify({ seq: 0, ts: 1, kind: 'act.failed', payload: { templateId: 5, instance: null, code: 'REVEAL_TOO_DEEP', message: 'depth cap' } }) + '\n');

  const json = report({ unreached: true, json: true, run: runId });
  assert.equal(json.discovered, 2, 'both templates discovered');
  assert.equal(json.uncovered, 2, 'both are uncovered');
  assert.equal(json.buckets['unexplored'], 1, 'the unexplored bucket');
  assert.equal(json.buckets['REVEAL_TOO_DEEP'], 1, 'the trail code flows through report() end-to-end');
  assert.equal(json.routeCollapse, 'split-by-location', 'the graduated honesty flag survives the wiring');
  assert.ok(json.locations && json.locations.discovered >= 1, 'the discovered-location count survives the wiring');
  assert.equal(json.runId, runId, 'the resolved --run id rides the report');

  const text = report({ unreached: true, json: false, run: runId });
  assert.ok(text.includes('Unreached analysis'), 'the header is present');
  assert.ok(text.includes(runId), 'the header names the run');
  assert.ok(text.includes('2 of 2 uncovered'), 'the header carries uncovered/discovered');
  const unexploredLine = text.split('\n').find((l) => l.trim().startsWith('unexplored'));
  assert.ok(unexploredLine && /\[budget — discovered locations: \d+\]/.test(unexploredLine), 'the budget/location tag rides the unexplored line');
  assert.ok(text.split('\n').some((l) => l.includes('REVEAL_TOO_DEEP : 1')), 'the granular bucket is rendered');
  assert.ok(text.split('\n').some((l) => l.startsWith('Instances:') && l.includes('beyond-cap (flagged)')), 'the instance-level line is rendered');
  assert.ok(text.split('\n').some((l) => l.startsWith('Locations:') && l.includes('discovered')), 'the discovered-locations line is rendered');
  assert.ok(/never-discovered/.test(text), 'the honest note is rendered');
});

// A synthetic single-URL-SPA graph: THREE controls all under route '/' but in three distinct
// LOCATIONS — one baseline (root, no reveal), two behind DIFFERENT opener paths. This is exactly the
// route-collapse case: routeKey gives one entry, the reveal paths give three sections.
function threeLocationGraph() {
  const g = makeGraph();
  // Baseline control — root location '/'.
  mergeSnapshot(g, '/', [el(1)]);
  // Control behind opener path P1 (template 10) — location '/|10:#1'.
  mergeSnapshot(g, '/', [el(2)], { revealPath: [{ templateId: 10, instanceKey: '#1' }] });
  // Control behind a DIFFERENT opener path P2 (template 20) — location '/|20:#1'.
  mergeSnapshot(g, '/', [el(3)], { revealPath: [{ templateId: 20, instanceKey: '#1' }] });
  return g;
}

test('buildUnreached: locations graduated — 3 discovered locations, split-by-location, budget/Locations render', () => {
  const g = threeLocationGraph();
  const instanceStats = frontierInstanceStats(g);
  assert.equal(instanceStats.locations.discovered, 3, 'root + two reveal-path sections = 3 locations under one routeKey');

  const rep = buildUnreached(g, [], instanceStats, 'r-loc');
  assert.equal(rep.locations.discovered, 3, 'buildUnreached threads the discovered-location count through');
  assert.equal(rep.routeCollapse, 'split-by-location', 'pending-INC.3 is retired for the discovered set');
  assert.equal(rep.buckets['unexplored'], 3, 'all three are honest budget (never drained), not a route-collapse ambiguity');
  assert.ok(/undiscovered/.test(rep.note) && /never-discovered/.test(rep.note), 'the note still guards the undiscovered/never-discovered set');

  const text = renderUnreached(rep);
  const unexploredLine = text.split('\n').find((l) => l.trim().startsWith('unexplored'));
  assert.ok(unexploredLine && unexploredLine.includes('[budget — discovered locations: 3]'), 'the unexplored line carries the discovered-location budget tag');
  assert.ok(text.split('\n').some((l) => l === 'Locations: 3 discovered'), 'a Locations line reports the discovered count');
});

// Guards (INVARIANT #2, the reference's death trap): locationKey is a FRONTIER/REPORTING hint DERIVED
//   from the already-captured reveal path — it must NEVER enter graph identity. Computing it (via
//   frontierInstanceStats + buildUnreached) must not mutate the graph, must not add a locationKey field
//   to any node/instance/edge, and diffIdentity(before, after) must report ZERO churn/dropped edges.
// FAIL-ON-REVERT: store the computed key on a node (e.g. `node.locationKey = …`) or an edge in the
//   location pass → the JSON-unchanged assertion reds AND the "no locationKey field" walk reds; make
//   the pass drop/re-key an edge → diffIdentity's `ok`/droppedEdges assertion reds.
test('identity proof: computing locations churns ZERO ids/edges and stores no locationKey on the graph', () => {
  const g = threeLocationGraph();
  // A causal edge so the identity diff has real edge structure to protect.
  g.edges.push({ from: 'element:1', to: 'request:GET /api/x', type: 'triggers', provenance: 'causal' });

  const before = JSON.stringify(g);
  const beforePair = { ledger: null, graph: JSON.parse(before) };

  // The whole location pipeline — the only new consumers of the reveal path.
  const instanceStats = frontierInstanceStats(g);
  buildUnreached(g, [], instanceStats, 'r-id');
  assert.equal(instanceStats.locations.discovered, 3, 'the pipeline actually ran (not a vacuous no-op)');

  // 1. No mutation — the location pass is pure-read over the graph.
  assert.equal(JSON.stringify(g), before, 'computing locations did not mutate the graph');

  // 2. No node/instance/edge gained a locationKey field (structural — even a future stored key reds).
  for (const node of Object.values(g.elements)) {
    assert.ok(!('locationKey' in node), 'no template node stores a locationKey');
    for (const inst of node.instances || []) assert.ok(!('locationKey' in inst), 'no instance stores a locationKey');
  }
  for (const e of g.edges) assert.ok(!('locationKey' in e), 'no edge stores a locationKey');

  // 3. diffIdentity: before vs after the location pass → zero churn / zero dropped edges.
  const d = diffIdentity(beforePair, { ledger: null, graph: g });
  assert.ok(d.ok, 'diffIdentity reports no identity churn from the location pass');
  assert.equal(d.churnedTemplates.length, 0, 'no template re-keyed');
  assert.equal(d.churnedInstances.length, 0, 'no instance re-keyed');
  assert.equal(d.droppedEdges.length, 0, 'no edge dropped');
  assert.equal(d.addedEdges, 0, 'no edge added by the location pass');
});
