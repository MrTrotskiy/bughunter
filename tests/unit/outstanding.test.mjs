// THE SCRIPT MUST BE ABLE TO SAY WHAT IS LEFT — by name, not as a percentage.
//
// docs/GOAL.md: "The script must be able to answer, at any moment: total / studied / outstanding, and the
// outstanding number must fall." It could COMPUTE that — probeStatus has known what each element owes for
// a while — and printed none of it. The operator saw a coverage percentage and had no way to ask "what
// exactly is left, and why is that one not done". "23 outstanding" does not distinguish a run stuck on one
// unreachable modal from one spread thin across the app; the NAMES do.
//
// Guards: an element with unmet obligations is listed with what it owes; a fully-answered one is counted
//   studied and not listed; a terminally-blocked one is counted separately (it is not owed work, and it is
//   not understanding either); never-touched elements sort to the top, because they are the honest queue.
// FAIL-ON-REVERT: make `outstandingOf` skip elements whose obligations are unmet (report only totals) →
//   "what each element owes is named" reds, and the queue collapses back into a number.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { outstandingOf, renderOutstanding } from '../../lib/recon/outstanding.mjs';

const graph = () => ({
  elements: {
    1: { role: 'textbox', name: 'Title', route: '/f', fieldFacts: { kind: 'text', required: true, maxLength: 50 },
         probes: [{ kind: 'fill-valid', verdict: 'read' }] },                       // owes overflow + empty
    2: { role: 'textbox', name: 'Done', route: '/f', fieldFacts: { kind: 'text' },
         probes: [{ kind: 'fill-valid', verdict: 'read' }] },                       // fully answered
    3: { role: 'textbox', name: 'Fresh', route: '/g', fieldFacts: { kind: 'text', required: true }, probes: [] },
    4: { role: 'button', name: 'Chrome', route: '/f', widgetInternal: true, probes: [] },   // not an obligation
  },
});

test('the queue names what each element still owes', () => {
  const s = outstandingOf(graph());
  assert.equal(s.total, 3, 'widget chrome is not counted as an obligation');
  assert.equal(s.studied, 1, 'only the fully-answered field counts as studied');
  assert.equal(s.outstanding, 2);

  const title = s.rows.find((r) => r.name === 'Title');
  assert.deepEqual(title.owed, ['fill-overflow', 'fill-empty'],
    'what it owes is NAMED — "still owed" without the names cannot be acted on');
  assert.equal(title.tries, 1);

  // Never-touched sorts above partly-probed: it is the honest front of the queue.
  assert.equal(s.rows[0].name, 'Fresh', 'never-touched first');
});

test('the rendered queue leads with total / studied / outstanding', () => {
  const text = renderOutstanding(graph());
  assert.match(text, /1\/3 studied/, 'the three numbers GOAL.md demands, in one line');
  assert.match(text, /2 still owed/);
  assert.match(text, /owes: fill-overflow, fill-empty/, 'and the queue itself, not just a count');
});

test('an empty queue says so plainly', () => {
  const done = { elements: { 1: { role: 'textbox', name: 'X', route: '/f', fieldFacts: { kind: 'text' }, probes: [{ kind: 'fill-valid', verdict: 'read' }] } } };
  assert.match(renderOutstanding(done), /nothing owed/);
});
