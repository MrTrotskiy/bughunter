// GOAL 5 — the Chao2 VARIANCE SOURCE + the param-key fix that keep the completeness oracle honest.
// seededOrder re-permutes the frontier emission order DETERMINISTICALLY so ≥2 budget-capped re-crawls
// explore different subsets (identical full drains give Q1=0, a degenerate 100%). routeItemKeys must key a
// concrete `:param` instance by its PATTERN so different concretes across shuffled runs count as ONE item.
// FAIL-ON-REVERT: make seededOrder ignore the seed → same-seed/diff-seed produce identical order → the
//   "a seed permutes" assertion reds. Drop the paramInstanceOf key in routeItemKeys → /item/1 keys as
//   itself → the "concrete keys by pattern" assertion reds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededOrder } from '../../lib/recon/frontier.mjs';
import { routeItemKeys } from '../../lib/recon/completeness.mjs';

test('seededOrder: no seed is identity; a seed permutes deterministically; the set is preserved', () => {
  const ids = Array.from({ length: 24 }, (_, i) => i + 1);
  assert.deepEqual(seededOrder(ids, undefined), ids, 'no seed → ascending order UNCHANGED (byte-identical crawl)');
  assert.deepEqual(seededOrder(ids, ''), ids, 'empty seed → unchanged');

  const a1 = seededOrder(ids, 'alpha');
  const a2 = seededOrder(ids, 'alpha');
  assert.deepEqual(a1, a2, 'same seed → SAME permutation (deterministic, reproducible/resumable)');
  assert.notDeepEqual(a1, ids, 'a seed actually PERMUTES the order (variance for Chao2)');
  assert.deepEqual([...a1].sort((x, y) => x - y), ids, 'the permutation preserves the SET (no item added/dropped)');

  const b = seededOrder(ids, 'beta');
  assert.notDeepEqual(a1, b, 'a DIFFERENT seed → a different order (so re-crawls genuinely differ)');
  // The input array is not mutated (returns a copy).
  assert.deepEqual(ids, Array.from({ length: 24 }, (_, i) => i + 1), 'seededOrder does not mutate its input');
});

test('routeItemKeys: a concrete :param instance keys by its PATTERN, not the concrete route', () => {
  const graph = { routes: {
    '/dashboard': { url: '/dashboard' },
    '/item/:id': { url: '/item/:id', unreachable: 'param-pattern' }, // pattern excluded (a denominator, not a detection)
    '/item/1': { url: '/item/1', paramInstanceOf: '/item/:id' },   // run A's concrete
    '/pending/x': { url: '/pending/x', pending: true },                   // not visited → excluded
  } };
  const keys = routeItemKeys(graph);
  assert.ok(keys.has('/dashboard'), 'a static visited route keys by itself');
  assert.ok(keys.has('/item/:id'), 'the concrete /item/1 keys by its PATTERN /item/:id (cross-run stable)');
  assert.ok(!keys.has('/item/1'), 'the concrete route key is NOT emitted (would inflate Q1 across shuffled runs)');
  assert.ok(!keys.has('/pending/x'), 'a pending (unvisited) route is not a detection');
  assert.equal(keys.size, 2, 'exactly dashboard + the item pattern');
});
