// THE KNOWLEDGE LADDER — coverage that cannot be earned by clicking.
//
// `explored` was set immediately after one act returned, before the outcome was inspected, and the
// frontier's drain predicate read that flag. So "explored" meant "clicked once, did not throw", and
// coverage counted those. One measured run: 279 acts, 27% caused any request, 43% wholly inert, 21 of 32
// submit-like controls clicked with zero fields filled, 0 of 6 user flows completed — while the coverage
// percentage climbed. The number was measuring effort and being read as understanding.
//
// Phase 1's actual job is to turn a black box into a white one: for every control what it is and does, for
// every field what it accepts and refuses. That is a claim about knowledge, so the metric has to be one.
//
// Guards: a rung above L1 requires recorded probe evidence; a click alone can never reach L3; `rejected`
//   exists as a verdict distinct from `inert`; BLOCKED stays counted and listed instead of silently
//   leaving the denominator; the three headline numbers are not blended.
// FAIL-ON-REVERT (one lever per direction):
//   (a) make `levelOf` return L3 whenever `node.explored` is set → "a click alone is not understanding"
//       fails — this is precisely the old behaviour, so the test is the guard against reverting to it.
//   (b) make `verdictOf` return 'inert' when no requests fired regardless of refusal → "a refused act is
//       not inert" fails, restoring the inference that was wrong for six runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batteryFor, verdictOf, probeStatus, levelOf, knowledgeStats } from '../../lib/recon/knowledge.mjs';

test('a click alone is not understanding', () => {
  const node = { role: 'button', name: 'Create', explored: true };
  assert.equal(levelOf(node, []), 'L1',
    'a control that was clicked once and recorded nothing sits at REACHED, not understood');

  // One recorded probe earns EXERCISED. Still not understanding — the battery is not complete.
  const one = [{ kind: 'click', verdict: 'read' }];
  assert.equal(levelOf(node, one), 'L3',
    'a button owes only a click, so one recorded outcome completes its battery');

  // A field owes more, and one probe is nowhere near enough.
  const field = { role: 'textbox', name: 'Title', fieldFacts: { maxLength: 50, required: true } };
  assert.deepEqual(batteryFor(field), ['fill-valid', 'fill-overflow', 'fill-empty'],
    'a field owes a probe per DECLARED constraint — a blind battery would have nothing to check against');
  assert.equal(levelOf(field, [{ kind: 'fill-valid', verdict: 'write' }]), 'L2',
    'one of three owed probes is EXERCISED, not CHARACTERIZED');
  const full = [
    { kind: 'fill-valid', verdict: 'write' },
    { kind: 'fill-overflow', verdict: 'rejected' },
    { kind: 'fill-empty', verdict: 'rejected' },
  ];
  assert.equal(levelOf(field, full), 'L3', 'the complete battery earns CHARACTERIZED');
});

test('a refused act is not inert — the distinction that did not exist', () => {
  assert.equal(verdictOf({ requests: [], refused: true }), 'rejected',
    'the page said no: a working control we failed to satisfy');
  assert.equal(verdictOf({ requests: [], refused: false }), 'inert',
    'the page said nothing: dead weight in the denominator');
  assert.equal(verdictOf({ requests: [{ class: 'write' }] }), 'write');
  assert.equal(verdictOf({ requests: [{ class: 'read' }] }), 'read');
  assert.equal(verdictOf({ requests: [], revealed: 3 }), 'reveal');
  assert.equal(verdictOf({ requests: [{ class: 'write' }], navigated: true }), 'navigate',
    'navigation is the more specific fact when both happened');
  assert.equal(verdictOf({ error: 'timeout' }), 'error');
  // The success channel stands alone: on the live target a form answered on no validation tier at all and
  // announced itself only through a toast.
  assert.equal(verdictOf({ requests: [], succeeded: true }), 'write',
    'an announced success is a write even when the request ledger is empty');
});

test('blocked stays in the denominator, named', () => {
  const node = { role: 'button', name: 'Video Call' };
  const probes = [{ kind: 'click', blocked: 'POLICY_OUTWARD' }];
  assert.equal(levelOf(node, probes), 'L-1', 'a control we may not probe is BLOCKED, not understood');

  const st = probeStatus(node, probes);
  assert.deepEqual(st.blocked, [{ kind: 'click', code: 'POLICY_OUTWARD' }], 'the reason is kept, not discarded');
  assert.equal(st.terminal, 'EXHAUSTED', 'nothing left to try, and nothing was learned');

  const graph = {
    elements: {
      1: { role: 'button', name: 'Video Call', probes },
      2: { role: 'button', name: 'Refresh', probes: [{ kind: 'click', verdict: 'read' }] },
      3: { role: 'button', name: 'Chrome', widgetInternal: true, probes: [] },
    },
  };
  const stats = knowledgeStats(graph);
  assert.equal(stats.obligations, 2, 'widget chrome is not an obligation (INC.6f), the other two are');
  assert.equal(stats.understood, 1, 'only the one with a complete battery counts');
  assert.equal(stats.knowledgePct, 50);
  assert.deepEqual(stats.blocked, [{ templateId: 1, name: 'Video Call', code: 'POLICY_OUTWARD' }],
    'the blocked control is LISTED by name and reason — never a silent subtraction');
});

test('a partially blocked element still owes what remains', () => {
  const field = { role: 'textbox', name: 'Title', fieldFacts: { maxLength: 50, required: true } };
  const probes = [
    { kind: 'fill-valid', verdict: 'write' },
    { kind: 'fill-overflow', blocked: 'NO_INSTANCE' },
  ];
  assert.equal(levelOf(field, probes), 'L2',
    'one probe blocked does not write the element off — fill-empty is still owed');
  const st = probeStatus(field, probes);
  assert.deepEqual(st.outstanding, ['fill-empty']);
  assert.equal(st.terminal, null, 'not terminal while anything is still attemptable');
});

test('CONFIRMED needs the outcome seen twice, or a write read back', () => {
  const node = { role: 'button', name: 'Post' };
  assert.equal(levelOf(node, [{ kind: 'click', verdict: 'write' }]), 'L3',
    'a single observation of a control is characterisation, not confirmation');
  assert.equal(levelOf(node, [{ kind: 'click', verdict: 'write' }, { kind: 'click', verdict: 'write' }]), 'L4',
    'reproduced twice the same way');
  assert.equal(levelOf(node, [{ kind: 'click', verdict: 'write', confirmedByReadBack: true }]), 'L4',
    'or verified by reading the created thing back');
});
