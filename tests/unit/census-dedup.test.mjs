// The refusal census must be SUMMABLE across a run, or its own numbers inflate.
//
// WHY THIS TEST EXISTS. `census()` reports why the picker rejected every candidate on a dry scan. On a busy
// route that scan runs many times over the same controls, so a consumer adding the events together counts
// the same instance once per scan. That already happened once and reached the operator: I reported "360
// absent controls" from eleven censuses of the SAME ~37 instances, a tenfold inflation.
//
// The fix was `seen` — a CALLER-OWNED set carried across the run, so each row records whether this is the
// first time that instance was refused. It was written into the module and then NOT threaded from the call
// site in stateful-loop.mjs, which is worse than not having it: the trail carried a `firstTimeReasons`
// field that looked deduplicated and was not. Measured on a 948-act run, 107 censuses inspected 1957
// candidates and reported `repeats: 0` — impossible for a page scanned twenty-two times, and the tell that
// the set was missing.
//
// FAIL-ON-REVERT: drop `{ seen }` at the stateful-loop call site (or pass a fresh Set per scan) → the second
// scan reports its repeats as first-time again → "the second scan adds nothing new" reds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { census } from '../../lib/recon/pick-diagnose.mjs';

// A page stub: nothing matches, so every candidate diagnoses the same way. The point here is the BOOKKEEPING.
const page = { evaluate: async () => ({ matched: 0, visible: 0 }) };
const rejected = () => ([
  { node: { templateId: 1 }, instanceKey: '#a', name: 'Alpha', instance: { instanceSelector: '.a' } },
  { node: { templateId: 1 }, instanceKey: '#b', name: 'Beta', instance: { instanceSelector: '.b' } },
]);

test('a repeated scan of the same candidates adds nothing new', async () => {
  const seen = new Set();
  const first = await census(page, rejected(), { seen });
  const second = await census(page, rejected(), { seen });

  assert.equal(first.repeats, 0, 'the first scan is all new');
  const firstTotal = Object.values(first.firstTimeReasons).reduce((a, b) => a + b, 0);
  assert.equal(firstTotal, 2, 'both candidates are first-time on the first scan');

  assert.equal(second.repeats, 2, 'the second scan is entirely repeats');
  const secondTotal = Object.values(second.firstTimeReasons).reduce((a, b) => a + b, 0);
  assert.equal(secondTotal, 0,
    'nothing is first-time the second time — this is what makes the field summable across a run');
});

test('the per-scan `reasons` view still reports what THIS scan saw', async () => {
  const seen = new Set();
  await census(page, rejected(), { seen });
  const second = await census(page, rejected(), { seen });
  const total = Object.values(second.reasons).reduce((a, b) => a + b, 0);
  assert.equal(total, 2,
    'the raw per-scan view is unchanged — deduplication belongs to the summable field, not to the observation');
});

test('without a seen set every scan looks new — the degenerate case the trail exhibited', async () => {
  const a = await census(page, rejected());
  const b = await census(page, rejected());
  assert.equal(a.repeats, 0);
  assert.equal(b.repeats, 0, 'no set means no memory: this is exactly the shape that inflated the number');
});
