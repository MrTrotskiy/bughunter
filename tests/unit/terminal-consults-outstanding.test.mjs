// The controller may not declare an application collected while elements still OWE probes.
//
// WHY THIS TEST EXISTS. `frontierStats.remaining` counts templates the frontier can still EMIT;
// `outstandingOf` counts obligations elements still OWE. They diverge exactly when an element has been
// touched but not STUDIED — the normal mid-crawl condition since the probe battery landed. The terminal
// predicate consulted only the first, so a graph with remaining=0 / pending=0 and 133 owed obligations
// would have been announced as "everything reachable is collected".
//
// docs/GOAL.md: done means the obligation list is empty "with nothing hidden in an uncounted bucket".
//
// FAIL-ON-REVERT: drop the `owed === 0` term from `isDrained` (collect-loop.mjs) and the first case here
// goes red — the controller reports drained while a field still owes fill-valid.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDrained } from '../../lib/recon/collect-loop.mjs';
import { outstandingOf } from '../../lib/recon/outstanding.mjs';

// A graph whose frontier is empty but whose one field has been touched once and still owes the rest of
// its battery. This is the shape the old predicate called "collected".
const graphWithOwedWork = () => ({
  elements: {
    7: {
      type: 'element', templateId: 7, role: 'textbox', name: 'Email', route: '/signup',
      explored: true,
      fieldFacts: { required: true, maxLength: 50 },
      probes: [{ kind: 'fill-valid', verdict: 'write', instanceKey: 'k1' }],
      instances: [{ instanceKey: 'k1', explored: true }],
    },
  },
  routes: { '/signup': { visited: true } },
  edges: [], requests: {},
});

test('the terminal refuses to fire while an element still owes a probe', () => {
  const graph = graphWithOwedWork();
  const owed = outstandingOf(graph).outstanding;
  assert.ok(owed > 0, 'fixture must actually owe something, else the test proves nothing');

  // The frontier is empty and no page is queued — everything the OLD predicate looked at says "done".
  const stats = { f: { remaining: 0 }, r: { pending: 0 }, owed };
  assert.equal(isDrained(stats), false, 'declared collected while an element still owes a probe');
});

test('the terminal fires once nothing is owed', () => {
  assert.equal(isDrained({ f: { remaining: 0 }, r: { pending: 0 }, owed: 0 }), true);
});

test('an owed obligation cannot be masked by an empty frontier alone', () => {
  // Guards the specific conflation: remaining===0 is about what can be EMITTED, never about what is KNOWN.
  assert.equal(isDrained({ f: { remaining: 0 }, r: { pending: 0 }, owed: 1 }), false);
  assert.equal(isDrained({ f: { remaining: 5 }, r: { pending: 0 }, owed: 0 }), false);
  assert.equal(isDrained({ f: { remaining: 0 }, r: { pending: 3 }, owed: 0 }), false);
});
