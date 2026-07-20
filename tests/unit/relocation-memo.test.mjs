// A relocation that has already failed may not be bought again.
//
// WHY THIS TEST EXISTS. `recoverGated` declared its `attempted` set INSIDE itself, so the set died with
// every call and each drained visit re-attempted the same hopeless targets from zero. Measured on one
// 675-second pinned run: 228 relocation attempts over **31 unique targets**, six of them retried 18-19
// times with identical results, **340 seconds — 50.4% of the run** — spent re-buying known failures.
// Productive acts got 17% of the run.
//
// The memo is a run-scoped cache of FAILURES ONLY. That asymmetry is the design and is tested here: a
// success must never block a later legitimate reopen of the same target, or the fix would delete real
// coverage while claiming to save time.
//
// A REOPEN IS WORTH WHAT THE ACT AFTER IT DELIVERS, and the memo used to record the wrong one of the two.
// `record` was called with `re.ok` — the relocation's own verdict, decided BEFORE the act it exists to
// enable had run. MEASURED, run state/runs/hunt1 seq 491-521: EIGHT consecutive `reopen{ok:true}` on
// template 1290 instance #1, each immediately followed by `act.failed NO_INSTANCE`, and a census reading
// `{attempted:12, succeeded:10}` — an 83% success rate for a mechanism that had just delivered nothing
// eight times running. Same class as the trail that recorded an act's INTENDED target rather than the
// element actually clicked and hid a wrong-control bug for seven runs.
//
// FAIL-ON-REVERT: make `record(…, ok=true)` count `succeeded++` on the spot and return nothing (the
//   single-phase shape) → "a reopen whose act found nothing is NOT a successful reopen" reds, and so does
//   "the same empty container must not be bought twice".
// FAIL-ON-REVERT: have the returned `settle` default to success when called with no argument, or count
//   `succeeded` at phase 1 → "an unsettled reopen reads as unresolved, never as success" reds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRelocationMemo } from '../../lib/recon/relocation-memo.mjs';

test('a failed target is refused on every later attempt', () => {
  const memo = createRelocationMemo();
  assert.equal(memo.shouldAttempt(608, 'checkbox-location'), true, 'first attempt must be allowed');
  memo.record(608, 'checkbox-location', false, 'REOPEN_HOP_STALE');

  // The exact shape of the measured waste: the same target asked for again and again.
  for (let i = 0; i < 18; i++) {
    assert.equal(memo.shouldAttempt(608, 'checkbox-location'), false, `repeat ${i + 2} was allowed through`);
  }
  const s = memo.stats();
  assert.equal(s.attempted, 1, 'only the one real attempt should be counted');
  assert.equal(s.refusedRepeat, 18);
  assert.equal(s.distinctFailed, 1);
});

test('a SUCCESSFUL relocation is not memoized — the same target may be reopened again', () => {
  // The asymmetry that keeps this from deleting coverage. A container legitimately needs re-entering
  // once per member; memoizing success would strand every member after the first.
  // "Successful" now means the ACT the reopen enabled resolved — phase 2, not phase 1.
  const memo = createRelocationMemo();
  memo.record(35, 'column-config-trigger', true)(true);
  assert.equal(memo.shouldAttempt(35, 'column-config-trigger'), true, 'a success must not block a later reopen');
  memo.record(35, 'column-config-trigger', true)(true);
  assert.equal(memo.shouldAttempt(35, 'column-config-trigger'), true);
  assert.equal(memo.stats().succeeded, 2);
  assert.equal(memo.stats().refusedRepeat, 0);
  assert.equal(memo.stats().pending, 0, 'both entries were settled');
});

// ── THE REOPEN THAT DELIVERED NOTHING ───────────────────────────────────────────────────────────────

test('a reopen whose act found nothing is NOT counted a success — the hunt1 shape', () => {
  // Verbatim from state/runs/hunt1: reopen ok (REOPEN_OK, hops 1, rung in-place), then act.failed
  // NO_INSTANCE. The container really reopened; the control really was not in it.
  const memo = createRelocationMemo();
  const settle = memo.record(1290, '#1', true, 'REOPEN_OK');
  assert.equal(memo.stats().succeeded, 0, 'phase 1 alone proves nothing — the act has not run yet');
  assert.equal(memo.stats().pending, 1, 'the entry is open, and says so');

  settle(false, 'REOPEN_ACT_NO_INSTANCE');

  const s = memo.stats();
  assert.equal(
    s.succeeded, 0,
    'a reopen whose act found nothing is NOT a successful reopen — hunt1 recorded 8 of these as successes and printed a 83% success rate',
  );
  assert.equal(s.deliveredNothing, 1, 'the class that used to hide inside `succeeded` is counted on its own');
  assert.equal(s.pending, 0, 'and the entry is closed');
  assert.equal(s.attempted, 1, 'the attempt is still counted — nothing leaves the books');
});

test('the same empty container must not be bought twice', () => {
  // The behavioural half. hunt1 spent EIGHT reopen+act pairs on template 1290 because a reopen recorded
  // as a success never memoizes, so `shouldAttempt` kept saying yes to a container proven empty.
  const memo = createRelocationMemo();
  memo.record(1290, '#1', true, 'REOPEN_OK')(false, 'REOPEN_ACT_NO_INSTANCE');

  for (let i = 0; i < 7; i++) {
    assert.equal(
      memo.shouldAttempt(1290, '#1'), false,
      `repeat ${i + 2} was allowed through — hunt1 bought this same empty container 8 times`,
    );
  }
  assert.equal(
    memo.reasonFor(1290, '#1'), 'REOPEN_ACT_NO_INSTANCE',
    'and the trail can say WHY: the reopen worked, the act did not — a different diagnosis from a path that would not replay',
  );
  assert.equal(memo.stats().refusedRepeat, 7);
});

test('an unsettled reopen reads as unresolved, never as success', () => {
  // The crash-safety direction. If the act path throws between the two phases, the entry must stay open —
  // a pending reading is honest, a defaulted success is the very lie this shape exists to remove.
  const memo = createRelocationMemo();
  memo.record(77, '#3', true, 'REOPEN_OK');   // settle never called

  const s = memo.stats();
  assert.equal(s.succeeded, 0, 'an unsettled reopen reads as unresolved, never as success');
  assert.equal(s.pending, 1, 'and it is DISCLOSED as pending rather than quietly dropped');
  assert.equal(s.attempted, 1);
  assert.equal(memo.shouldAttempt(77, '#3'), true, 'an unknown outcome does not block a retry — only a proven failure does');
});

test('settle is idempotent — a caller that closes twice cannot double-count', () => {
  // `recoverGated` settles inside a `finally`; a future caller settling on the happy path too must not
  // inflate the census. Counting a thing twice is how the last three headline numbers got inflated.
  const memo = createRelocationMemo();
  const settle = memo.record(5, '#1', true);
  settle(true);
  settle(true);
  settle(false, 'LATE');
  assert.equal(memo.stats().succeeded, 1, 'one attempt, one outcome');
  assert.equal(memo.stats().pending, 0);
  assert.equal(memo.shouldAttempt(5, '#1'), true, 'and the late failure did not retroactively memoize a settled success');
});

test('a FAILED reopen needs no settling — there was no act to judge', () => {
  const memo = createRelocationMemo();
  assert.equal(memo.record(608, 'checkbox-location', false, 'REOPEN_HOP_STALE'), null, 'nothing to close');
  assert.equal(memo.stats().pending, 0, 'a failed reopen opens no pending entry');
  assert.equal(memo.shouldAttempt(608, 'checkbox-location'), false);
});

test('targets are distinguished by INSTANCE, not just template', () => {
  // 11 checkboxes share one template; refusing them all because one failed would silently drop ten
  // reachable controls — the same denominator lie the honest-coverage rule exists to prevent.
  const memo = createRelocationMemo();
  memo.record(608, 'checkbox-location', false, 'REOPEN_HOP_STALE');
  assert.equal(memo.shouldAttempt(608, 'checkbox-location'), false);
  assert.equal(memo.shouldAttempt(608, 'checkbox-manager'), true, 'a sibling instance must still be tried');
  assert.equal(memo.shouldAttempt(609, 'checkbox-location'), true, 'a different template must still be tried');
});

test('the first failure code is kept, so the trail can say WHY a target is skipped', () => {
  const memo = createRelocationMemo();
  memo.record(798, 'sidebar-nav-child', false, 'REOPEN_HOP_STALE');
  memo.record(798, 'sidebar-nav-child', false, 'REOPEN_UNVERIFIED');
  assert.equal(memo.reasonFor(798, 'sidebar-nav-child'), 'REOPEN_HOP_STALE', 'the FIRST diagnosis is the honest one');
  assert.equal(memo.reasonFor(1, 'never-seen'), null);
});
