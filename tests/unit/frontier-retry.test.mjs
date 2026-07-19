// RETRY WHAT WE NEVER MANAGED TO ASK.
//
// THE MEASURED FAILURE. An act that throws still marks its instance explored, so the element leaves the
// frontier having taught us nothing and can never be handed out again. Run probe8: 15 elements sat at L1
// REACHED whose every recorded row was a transient block — one failed attempt retired each of them
// permanently. They were not unreachable; nobody ever tried a second time.
//
// The distinction the predicate rests on is the same one `TRANSIENT_BLOCKS` draws: a row that records the
// element ANSWERING (any verdict) or a TERMINAL fact about it (readonly, policy) is knowledge and drains.
// A row that records only our failure to ask is not, and re-opens.
//
// FAIL-ON-REVERT (one lever per direction, because this predicate can be wrong both ways):
//   (a) drop `&& !retryable(node)` from instanceDrained → "a transiently-failed element is handed out
//       again" goes red, restoring the retire-on-first-failure behaviour that stranded the 15.
//   (b) drop the `TRANSIENT_BLOCKS.has(...)` test so every blocked row counts as retryable → "a policy
//       refusal is never re-walked" goes red, and the loop would re-fire refused controls forever.
//   (c) drop the MAX_RETRY_ROWS bound → "a persistently failing element is eventually left alone" goes
//       red, and the budget drains into the one element that never works.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nextBatch, frontierStats } from '../../lib/recon/frontier.mjs';

const graphWith = (probes) => ({
  elements: {
    1: {
      role: 'button', name: 'Create', route: '/dashboard', explored: true, probes,
      instances: [{ instanceKey: '#1', instanceSelector: '#a', explored: true }],
    },
  },
});

test('an element we never managed to ask is handed out again', () => {
  const batch = nextBatch(graphWith([{ kind: 'click', blocked: 'ACT_FAILED' }]), { size: 5 });
  assert.equal(batch.length, 1, 'the act threw, so nothing was learned and the element is still owed');
  assert.equal(batch[0].templateId, 1);

  // Same for the other transient shapes — the container vanished, or we landed on another instance's node.
  for (const code of ['NO_INSTANCE', 'NOT_VISIBLE', 'CONTAINER_CLOSED', 'ALIAS_COLLISION']) {
    assert.equal(nextBatch(graphWith([{ kind: 'click', blocked: code }]), { size: 5 }).length, 1,
      `${code} is a failure to measure, not a measurement`);
  }
});

test('an element that ANSWERED, or is terminally blocked, stays drained', () => {
  // The whole point of the ladder is that a recorded outcome is knowledge — re-walking it would spend the
  // budget re-learning what we know. `inert` counts here too: it is a poor answer, but it IS an answer.
  assert.equal(nextBatch(graphWith([{ kind: 'click', verdict: 'read' }]), { size: 5 }).length, 0,
    'a control that answered is not re-walked');
  assert.equal(nextBatch(graphWith([{ kind: 'click', verdict: 'inert' }]), { size: 5 }).length, 0,
    'an inert outcome is still an outcome — the retry is for failures to ASK, not for poor answers');

  // (b) A policy refusal is permanent. Re-walking it would re-fire a control we decided never to fire.
  // Pinned to codes the crawler ACTUALLY emits. An earlier draft asserted on `POLICY_OUTWARD`, which
  // nothing in lib/ emits — so the lever moved mechanically while leaving the codes with teeth unguarded.
  // If DANGER_FLOOR or FOREIGN_DESTROY ever slipped into TRANSIENT_BLOCKS the loop would re-fire refused
  // controls forever, and a test pinned to a dead string would have stayed green through it.
  for (const code of ['DANGER_FLOOR', 'FOREIGN_DESTROY', 'ACCOUNT_PROTECTED', 'POST_CLICK_FAILED']) {
    assert.equal(nextBatch(graphWith([{ kind: 'click', blocked: code }]), { size: 5 }).length, 0,
      `${code} is terminal — re-walking it would re-fire a control we decided not to fire`);
  }
  assert.equal(nextBatch(graphWith([{ kind: 'fill-valid', blocked: 'NOT_FILLABLE' }]), { size: 5 }).length, 0,
    'a fact about the field is knowledge, not a failed attempt');

  // A MIXED history drains too: one transient failure alongside a real answer is not "never asked".
  assert.equal(nextBatch(graphWith([
    { kind: 'click', blocked: 'ACT_FAILED' },
    { kind: 'click', verdict: 'reveal' },
  ]), { size: 5 }).length, 0, 'it eventually answered — the earlier failure is history, not an obligation');
});

test('a persistently failing element is eventually left alone', () => {
  // (c) Without a bound this is an infinite re-walk: the element fails, re-enters the frontier, fails again.
  // Three recorded failures is enough to call it honestly unreachable and spend the budget elsewhere.
  const thrice = [
    { kind: 'click', blocked: 'ACT_FAILED' },
    { kind: 'click', blocked: 'ACT_FAILED' },
    { kind: 'click', blocked: 'ACT_FAILED' },
  ];
  assert.equal(nextBatch(graphWith(thrice), { size: 5 }).length, 0,
    'after three failed attempts it stops consuming the budget');
  assert.equal(nextBatch(graphWith(thrice.slice(0, 2)), { size: 5 }).length, 1,
    'but two attempts still leave one more worth trying');
});

// THE FOUR READERS MUST AGREE. `nextBatch` hands an instance out; `frontierStats.remaining` decides whether
// the controller reports the crawl finished. When only the first knew about `retryable`, the controller
// printed "everything reachable is collected" while the frontier was still yielding work — the same
// disagreement this file's own header warns about, in the opposite direction.
//
// FAIL-ON-REVERT: restore the inlined predicate at frontier.mjs:183 → `remaining` reads 0 while nextBatch
// yields 1, and this goes red.
test('a retryable element is counted as remaining, not silently reported done', () => {
  const g = graphWith([{ kind: 'click', blocked: 'ACT_FAILED' }]);
  assert.equal(nextBatch(g, { size: 5 }).length, 1, 'the frontier still hands it out');
  assert.equal(frontierStats(g).remaining, 1,
    'so the controller must not read the crawl as drained — a false "done" is the worst honest-coverage failure');

  const answered = graphWith([{ kind: 'click', verdict: 'read' }]);
  assert.equal(frontierStats(answered).remaining, 0, 'and an element that answered really is done');
});

// A POST-CLICK failure is NOT retryable, because the control already FIRED. Retrying re-fires it, and under
// explore-all that is a duplicated real write on the operator's stand.
// FAIL-ON-REVERT: add 'POST_CLICK_FAILED' to TRANSIENT_BLOCKS → this goes red.
test('a control that already fired is never fired again by the retry', () => {
  assert.equal(nextBatch(graphWith([{ kind: 'click', blocked: 'POST_CLICK_FAILED' }]), { size: 5 }).length, 0,
    'the click happened; only the observation failed, and a second click is a second mutation');
});
