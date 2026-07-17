// frontier — Phase-1 receptive-field selection over the graph. Pure, no browser.
// The loop studies only a small batch of UNEXPLORED templates per step; this module
// decides WHICH, and reports the honest discovered/explored/remaining denominator.
//
// Guards: the recon loop only ever hands out UNEXPLORED templates, capped at the
//   receptive-field size, and the frontier drains to empty as they are explored — so
//   the loop makes forward progress, terminates, and never re-clicks known controls.
//   Also guards that the denominator does NOT collapse (discovered stays constant
//   while explored rises), and that a template drained-but-never-reached counts as
//   `unreachable`, NOT genuine `explored`.
// FAIL-ON-REVERT: (a) drop the `if (node.explored) continue` filter in nextBatch — an
//   explored template reappears → deepEqual [1,3,5] fails "explored templates 2 and 4
//   must be excluded"; (b) drop the `- unreachable` in frontierStats — the unreachable
//   node inflates `explored` → the {explored:1, unreachable:1} deepEqual fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGraph, mergeSnapshot, markExplored, markUnreachable, markOpener, markInstanceExplored, markInstanceChurned } from '../../lib/graph/graph-store.mjs';
import { nextBatch, frontierStats, frontierInstanceStats, OPENER_INSTANCE_CAP, DRILL_PER_LIST } from '../../lib/recon/frontier.mjs';

// Build a graph with n distinct single-instance templates (ids 1..n), as ids.mjs
// would have minted them, then merged.
function seed(n) {
  const g = makeGraph();
  const els = [];
  for (let i = 1; i <= n; i++) {
    els.push({
      templateId: i,
      instanceId: i * 100,
      templateSelector: `button.b${i}`,
      role: 'button',
      name: `B${i}`,
      instanceKey: `#${i}`,
      instanceSelector: `button.b${i}:nth-child(${i})`,
    });
  }
  mergeSnapshot(g, '/', els);
  return g;
}

test('nextBatch returns only unexplored templates, ascending, capped at size', () => {
  const g = seed(5);
  markExplored(g, 2);
  markExplored(g, 4);
  const batch = nextBatch(g, { size: 3 });
  assert.deepEqual(
    batch.map((b) => b.templateId),
    [1, 3, 5],
    'explored templates 2 and 4 must be excluded',
  );
  for (const b of batch) {
    assert.ok(b.instance && b.instance.instanceSelector, 'each batch item carries an instance to act on');
  }
});

test('nextBatch honors the receptive-field cap', () => {
  const g = seed(10);
  assert.equal(nextBatch(g, { size: 3 }).length, 3);
  assert.equal(nextBatch(g, { size: 5 }).length, 5);
});

test('nextBatch skips templates with no addressable instance', () => {
  const g = seed(2);
  g.elements[1].instances = []; // template exists but nothing to click
  assert.deepEqual(nextBatch(g).map((b) => b.templateId), [2]);
});

test('frontier drains as templates are explored; denominator does not collapse', () => {
  const g = seed(3);
  assert.deepEqual(frontierStats(g), { discovered: 3, explored: 0, unreachable: 0, remaining: 3, routes: 1 });
  markExplored(g, 1);
  markExplored(g, 2);
  assert.deepEqual(frontierStats(g), { discovered: 3, explored: 2, unreachable: 0, remaining: 1, routes: 1 });
  markExplored(g, 3);
  assert.deepEqual(frontierStats(g), { discovered: 3, explored: 3, unreachable: 0, remaining: 0, routes: 1 });
  assert.equal(nextBatch(g).length, 0, 'empty frontier → loop terminates');
});

test('an unreachable-drained template counts as unreachable, not genuine coverage', () => {
  const g = seed(2);
  markExplored(g, 1);
  markUnreachable(g, 1, 'NO_INSTANCE'); // drained from the frontier but never actually reached
  markExplored(g, 2); // genuinely explored
  assert.deepEqual(frontierStats(g), { discovered: 2, explored: 1, unreachable: 1, remaining: 0, routes: 1 });
});

// Guards: instance-level coverage honesty — an opener with N instances is N addressable controls,
//   not one. frontierInstanceStats reports the honest instance-level frontier (walkable/walked/
//   remaining) that, unlike template `frontierStats`, never reads "done" while nextBatch still yields
//   opener siblings; and opener instances BEYOND OPENER_INSTANCE_CAP are counted in `cappedRemainder`
//   — the un-walked remainder is FLAGGED, never silently hidden (the "coverage never hidden" invariant).
// FAIL-ON-REVERT: make `cappedRemainder` always 0 (drop the `insts.length - CAP` term) → the
//   "2 beyond-cap flagged" assertion goes red; make the opener `limit` 1 (template-level) → walkable
//   reads 2 not CAP+1 and the walked/remaining assertions go red.
test('frontierInstanceStats: opener siblings + beyond-cap remainder are honest, not hidden', () => {
  const g = makeGraph();
  const N = OPENER_INSTANCE_CAP + 2; // 2 instances beyond the cap
  const els = [];
  for (let i = 1; i <= N; i++) els.push({
    templateId: 1, instanceId: 100 + i, templateSelector: 'button.nav', role: 'button',
    name: 'Nav', instanceKey: `#${i}`, instanceSelector: `button.nav:nth-child(${i})`,
  });
  els.push({ templateId: 2, instanceId: 200, templateSelector: 'button.x', role: 'button', name: 'X', instanceKey: '#1', instanceSelector: 'button.x' });
  mergeSnapshot(g, '/', els);
  markOpener(g, 1);

  const before = frontierInstanceStats(g);
  assert.equal(before.walkable, OPENER_INSTANCE_CAP + 1, 'opener contributes CAP walkable + the 1 plain template');
  assert.equal(before.cappedRemainder, 2, 'the 2 opener instances beyond the CAP are flagged, not hidden');
  assert.equal(before.walked, 0, 'nothing walked yet');
  assert.equal(before.remaining, OPENER_INSTANCE_CAP + 1, 'remaining = walkable while nothing is drained');

  markInstanceExplored(g, 1, '#1');
  markInstanceExplored(g, 1, '#2');
  markInstanceExplored(g, 1, '#3');
  markInstanceExplored(g, 2, '#1');
  const after = frontierInstanceStats(g);
  assert.equal(after.walked, 4, '3 opener siblings + the plain control walked');
  assert.equal(after.remaining, OPENER_INSTANCE_CAP + 1 - 4, 'remaining drops per walked INSTANCE (not template-count)');
  assert.equal(after.cappedRemainder, 2, 'the beyond-cap remainder is unchanged by walking within the cap');
});

// Guards: the LOCATION DENOMINATOR — the honest "how many sections did we discover" number a
//   single-URL SPA hides under one routeKey. Two controls under the SAME route but reached via
//   DIFFERENT reveal.statePath are two locations; a baseline (reveal-less) control is the root
//   location → 3 distinct locations. locationKey never touches identity (see the identity-proof test
//   in report-unreached.test.mjs), only this tally.
// FAIL-ON-REVERT: count instances instead of DISTINCT locationKeys (drop the Set) → the two
//   different-statePath controls under one route would count the root location twice / miscount → the
//   `locations.discovered === 3` assertion reds; key on `route` alone (ignore statePath) → the two
//   POST-nav sections collapse to 1 with the root → discovered reads 1, reds.
test('frontierInstanceStats: locations.discovered counts DISTINCT reveal-path sections, not routeKeys', () => {
  const g = makeGraph();
  // Baseline control — no reveal → the route's ROOT location ('/').
  mergeSnapshot(g, '/', [{
    templateId: 1, instanceId: 100, templateSelector: 'button.base', role: 'button',
    name: 'Base', instanceKey: '#1', instanceSelector: 'button.base',
  }]);
  // Control B behind opener path P1 (template 10) — location '/|10:#1'.
  mergeSnapshot(g, '/', [{
    templateId: 2, instanceId: 200, templateSelector: 'button.b', role: 'button',
    name: 'B', instanceKey: '#1', instanceSelector: 'button.b',
  }], { revealPath: [{ templateId: 10, instanceKey: '#1' }] });
  // Control C behind a DIFFERENT opener path P2 (template 20) — location '/|20:#1'.
  mergeSnapshot(g, '/', [{
    templateId: 3, instanceId: 300, templateSelector: 'button.c', role: 'button',
    name: 'C', instanceKey: '#1', instanceSelector: 'button.c',
  }], { revealPath: [{ templateId: 20, instanceKey: '#1' }] });

  const stats = frontierInstanceStats(g);
  assert.equal(stats.locations.discovered, 3, 'root + two distinct reveal-path sections = 3 locations under ONE routeKey');
  // The location tally is ADDITIVE — every pre-existing instance-frontier field is unchanged.
  assert.equal(stats.walkable, 3, 'three single-instance templates are walkable');
  assert.equal(stats.cappedRemainder, 0, 'no opener → no beyond-cap remainder');
});

// Build a NON-opener template whose n instances all live in a LIST ROW (node.listRow), as
// mergeSnapshot would flag from dom-snapshot's per-element inRow. A 50-row data list = 50 instances
// of ONE template; the frontier drills the representative (instance[0]) and must COUNT the rest.
function listRowTemplate(g, templateId, n, { inRow = true } = {}) {
  const els = [];
  for (let i = 1; i <= n; i++) els.push({
    templateId, instanceId: templateId * 1000 + i, templateSelector: `li.row button.edit${templateId}`,
    role: 'button', name: 'Edit', instanceKey: `#${i}`,
    instanceSelector: `li.row:nth-child(${i}) button.edit${templateId}`, inRow,
  });
  mergeSnapshot(g, '/', els);
}

// Guards: DRILL_PER_LIST honesty — a 50-row data list is 50 instances of ONE non-opener template.
//   nextBatch hands out only instance[0] (the representative), so the other 49 rows are NEITHER
//   walked NOR counted anywhere pre-increment — they silently vanish from the honest denominator.
//   frontierInstanceStats now counts them in `drillSkipped` (the non-opener analog of cappedRemainder:
//   counted, flagged, never walked), while `walkable`/`remaining` stay the DRILL_PER_LIST=1 representative.
// FAIL-ON-REVERT: drop the `else if (node.listRow) drillSkipped += ...` accumulation in
//   frontierInstanceStats → the 49 rows are un-counted → `drillSkipped === 49` reads 0, reds.
test('frontierInstanceStats: a 50-row non-opener list flags 49 drill-skipped, walks 1 representative', () => {
  const g = makeGraph();
  listRowTemplate(g, 1, 50);
  const s = frontierInstanceStats(g);
  assert.equal(s.drillSkipped, 50 - DRILL_PER_LIST, 'the 49 non-representative rows are counted+flagged, not hidden');
  assert.equal(s.walkable, DRILL_PER_LIST, 'only the representative row (instance[0]) is walkable — nextBatch unchanged');
  assert.equal(s.remaining, DRILL_PER_LIST, 'remaining is the representative alone (nothing drained yet), unchanged by the flag');
  assert.equal(s.cappedRemainder, 0, 'a non-opener list uses drillSkipped, never cappedRemainder');
});

// Guards: the flag is SCOPED — a non-listRow non-opener template (a lone control, no list-row ancestor)
//   contributes ZERO drillSkipped, so the increment never mis-counts an ordinary multi-instance template.
// FAIL-ON-REVERT: drop the `node.listRow` guard (accumulate for every non-opener) → a non-listRow
//   template's extra instances leak into drillSkipped → `drillSkipped === 0` reds.
test('frontierInstanceStats: a non-listRow non-opener template contributes 0 drillSkipped', () => {
  const g = makeGraph();
  listRowTemplate(g, 1, 50, { inRow: false }); // present-but-not-in-a-row → node.listRow stays unset
  const s = frontierInstanceStats(g);
  assert.equal(s.drillSkipped, 0, 'a non-listRow template drills nothing extra — unchanged behavior');
  assert.equal(s.walkable, 1, 'still only instance[0] walkable (non-opener)');
});

// Guards: opener vs list-row are MUTUALLY EXCLUSIVE — a list-row template that IS a proven opener uses
//   cappedRemainder (its siblings ARE walked up to the CAP), NOT drillSkipped. The `else if` ordering
//   ensures an opener never double-counts its beyond-cap remainder as drill-skipped.
// FAIL-ON-REVERT: change the `else if` to a plain `if` (accumulate drillSkipped for openers too) →
//   an opener list's beyond-cap rows land in BOTH buckets → `drillSkipped === 0` reds.
test('frontierInstanceStats: an opener list uses cappedRemainder, not drillSkipped', () => {
  const g = makeGraph();
  const N = OPENER_INSTANCE_CAP + 2;
  listRowTemplate(g, 1, N); // a list-row template …
  markOpener(g, 1);          // … that ALSO opens (its instances reveal controls)
  const s = frontierInstanceStats(g);
  assert.equal(s.cappedRemainder, 2, 'an opener beyond the CAP is counted in cappedRemainder');
  assert.equal(s.drillSkipped, 0, 'an opener is NOT double-counted as drill-skipped');
});

// Guards (blocker-6 Part B): the churnSkipped PEEL — a re-rendering feed's vanished representative
//   (markInstanceChurned, UNEXPLORED by design) is peeled OUT of walkable/remaining and QUANTIFIED in
//   churnSkipped, so the STABLE control set can reach remaining===0 while the churn is counted, never
//   hidden and never conflated into `unreachable`. The arithmetic invariant `remaining = walkable −
//   walked − unreachable` still holds because churned instances never enter `walkable`.
// FAIL-ON-REVERT: remove the `if (inst.churned) { churnSkipped++; continue; }` peel in
//   frontierInstanceStats → the churned (unexplored) representative re-enters `walkable` → it counts as
//   un-walked → `remaining === 1` (not 0) → the "remaining === 0" assertion reds, and churnSkipped reads 0.
test('frontierInstanceStats: a churned feed representative is peeled into churnSkipped, letting the stable set drain', () => {
  const g = makeGraph();
  // A stable single-instance control (walked) + a NON-opener list-row feed of 4 rows whose representative
  // (instance[0]) churned away UNEXPLORED (markInstanceChurned does not mark it explored, by design).
  const stable = { templateId: 1, instanceId: 100, templateSelector: 'button#stable', role: 'button', name: 'Show', instanceKey: '#1', instanceSelector: 'button#stable' };
  mergeSnapshot(g, '/', [stable]);
  markInstanceExplored(g, 1, '#1');       // the stable control is genuine coverage
  listRowTemplate(g, 2, 4);               // feed: instances "#1".."#4" of one list-row template
  markInstanceChurned(g, 2, '#1');        // its representative re-rendered away (unexplored churn)

  const s = frontierInstanceStats(g);
  assert.equal(s.churnSkipped, 1, 'the vanished representative is counted in churnSkipped');
  assert.equal(s.remaining, 0, 'the STABLE set drains to remaining===0 — the peeled churn never blocks it');
  assert.equal(s.walked, 1, 'only the stable control counts as walked (the churned row is NOT inflated into walked)');
  assert.equal(s.drillSkipped, 3, 'the other 3 feed rows are the usual DRILL_PER_LIST remainder (churn is separate)');
});
