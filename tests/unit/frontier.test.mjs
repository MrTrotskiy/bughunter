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
import { makeGraph, mergeSnapshot, markExplored, markUnreachable } from '../../lib/graph/graph-store.mjs';
import { nextBatch, frontierStats } from '../../lib/recon/frontier.mjs';

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
