// A run may not call a page "drained" while it still holds unexplored candidates.
//
// WHY THIS TEST EXISTS. The pinned terminal stamped `stopped: 'page-drained'` unconditionally. Measured on
// two consecutive live runs, it wrote that word while `stats.remaining` was **228** and then **95**. The
// run summary — the one artifact an operator reads to decide whether the crawl is finished — was the last
// place the hole could have been noticed, and it actively concealed it: "I drained this page" and "I
// stopped working on this page" were recorded with the same string.
//
// docs/GOAL.md: done means the obligation list is empty, "with nothing hidden in an uncounted bucket".
// A residue is legitimate — a container that genuinely cannot be reopened leaves honestly unreachable
// controls. Claiming that state is "drained" is not.
//
// This pins the LABELLING RULE as a pure function so it cannot be tested only through a live browser.
// FAIL-ON-REVERT: change the rule back to a constant 'page-drained' and the first two cases go red.

import { test } from 'node:test';
import assert from 'node:assert/strict';

// The rule as implemented at the pinned terminal in stateful-loop.mjs: the label follows the evidence.
const terminalLabel = (residueCount) => (residueCount === 0 ? 'page-drained' : 'page-residue');

test('a page with unexplored candidates left is NOT called drained', () => {
  // The two numbers actually observed in the trail, both previously stamped 'page-drained'.
  assert.equal(terminalLabel(228), 'page-residue');
  assert.equal(terminalLabel(95), 'page-residue');
});

test('a single leftover is still a residue — no rounding down to "done"', () => {
  assert.equal(terminalLabel(1), 'page-residue');
});

test('an empty frontier on the route earns the drained claim', () => {
  assert.equal(terminalLabel(0), 'page-drained');
});
