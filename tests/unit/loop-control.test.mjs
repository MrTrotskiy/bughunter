// loop-control — the /recon driver's honest termination verdict. decideProgress turns the
// per-window instance-level history into continue|drained|stalled, replacing the blind `cap 20`.
// Pure: no graph, no browser, no clock.
//
// THE FIX GUARDED HERE: the stall signal keys on a MONOTONE PROGRESS value
// (progress = walked + unreachable + walkable), NOT on flat `remaining`. `remaining` sits FLAT on
// a BALANCED drain+discovery plateau (walk 3, reveal 3 → remaining unchanged), so keying the
// stall on it FALSELY terminated a still-progressing crawl. progress grows on every event, so it
// is flat ONLY on a true stall.
//
// FAIL-ON-REVERT technique: every case passes BOTH the OLD `history`/`remaining` params AND the
// new `progress`/`progressHistory` params. A literal `git checkout HEAD -- lib/recon/loop-control.mjs`
// (the remaining-based stall) ignores the new params and reads `history`+`remaining`; the
// balanced-discovery and unreachable-burn cases carry a FLAT `history`, so the reverted code
// declares them stalled → their `assert.equal(..., 'continue')` reds. The genuine-stall case
// carries no `history`, so the reverted code cannot see a stall → its `assert.equal(..., 'stalled')`
// reds too. Dropping the `recent.every(...)` all-equal check also reds the continue cases.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decideProgress, STALL_WINDOWS } from '../../lib/recon/loop-control.mjs';

// (a) THE BUG REPRO — balanced discovery. remaining is FLAT (walk N, reveal N each window), but
// the monotone progress signal climbs (10 → 16 → 22, +6/window). MUST continue, NOT stall.
// Reverting loop-control.mjs to the remaining-based stall reds this: the reverted code reads
// history [5,5] + remaining 5 → [5,5,5] all equal → 'stalled' (expected 'continue').
test('NOT stalled on a BALANCED drain+discovery plateau (remaining flat, progress climbing)', () => {
  const v = decideProgress({
    batchLen: 2,
    remaining: 5, history: [5, 5],       // OLD params: flat remaining → the remaining-based bug stalls
    progress: 22, progressHistory: [10, 16], // NEW params: strictly increasing → real forward progress
  });
  assert.equal(v.action, 'continue');
});

// (b) unreachable-tail burn: progress climbs by +1/window (unreachable+1) while remaining is held
// flat. The monotone signal moves, so it must continue. Reverting to the remaining-based stall
// reds this: history [4,4] + remaining 4 → [4,4,4] all equal → 'stalled' (expected 'continue').
test('NOT stalled on an unreachable-tail burn (progress climbing via unreachable)', () => {
  const v = decideProgress({
    batchLen: 1,
    remaining: 4, history: [4, 4],
    progress: 18, progressHistory: [16, 17],
  });
  assert.equal(v.action, 'continue');
});

// (c) GENUINE stall — progress FLAT over K windows with a non-empty batch: nothing explored,
// failed, or discovered. MUST stall. No `history` is passed, so a revert to the remaining-based
// stall cannot see a plateau (history [] + remaining → single value) → 'continue' → this reds.
test('stalled: progress flat over K windows with a non-empty batch', () => {
  // progressHistory [30,30] = prior windows; recent = [30,30] + current 30 = [30,30,30], K, all equal.
  const v = decideProgress({ batchLen: 2, remaining: 5, progress: 30, progressHistory: [30, 30] });
  assert.equal(v.action, 'stalled');
  assert.match(v.reason, /progress flat at 30/);
  assert.match(v.reason, new RegExp(`${STALL_WINDOWS} windows`));
  assert.match(v.reason, /nothing explored, failed, or discovered/);
});

// (d) insufficient history — fewer than K windows seen, even at flat progress. MUST continue.
// Reds if the `recent.length >= stallWindows` guard is dropped: [22,22] all equal → 'stalled'.
test('NOT stalled on insufficient history (fewer than K windows seen)', () => {
  const v = decideProgress({ batchLen: 2, remaining: 5, progress: 22, progressHistory: [22] });
  assert.equal(v.action, 'continue');
});

// (e1) DRAINED — an empty batch ends the crawl (unchanged). Reds if the batchLen===0 branch weakens.
test('drained: an empty batch ends the crawl', () => {
  const v = decideProgress({ batchLen: 0, remaining: 0 });
  assert.equal(v.action, 'drained');
  assert.equal(v.reason, 'frontier drained');
});

// (e2) DRAINED-with-cappedRemainder — the verdict flags beyond-cap opener siblings (unchanged).
test('drained-with-cappedRemainder: the verdict flags beyond-cap opener siblings, never a bare "done"', () => {
  const v = decideProgress({ batchLen: 0, remaining: 0, cappedRemainder: 12 });
  assert.equal(v.action, 'drained');
  assert.match(v.reason, /beyond OPENER_INSTANCE_CAP/);
  assert.match(v.reason, /12/);
  assert.equal(v.cappedRemainder, 12);
});

// (f) VISIT-ROUTE (INC.1b) — an EMPTY template batch with routes still QUEUED must drain the BFS
// route frontier (route-cli --visit-next), NOT declare the crawl drained. 'drained' is reserved for
// BOTH frontiers empty. Backward-compat: no pendingRoutes (default 0) → an empty batch is 'drained'
// exactly as before.
// Guards: the agent-path route drain — an empty template frontier with pending routes yields a
//   'visit-route' verdict so the /recon driver visits queued pages instead of stopping early.
// FAIL-ON-REVERT: remove the `batchLen === 0 && pendingRoutes > 0` visit-route branch in
//   loop-control.mjs → an empty batch with routes pending falls through to 'drained' →
//   "empty batch + pending routes must visit-route, not drain" reds.
test('visit-route: empty batch with routes pending drains the route queue, not the crawl', () => {
  const queued = decideProgress({ batchLen: 0, remaining: 0, pendingRoutes: 3 });
  assert.equal(queued.action, 'visit-route', 'empty batch + pending routes must visit-route, not drain');
  assert.equal(queued.pendingRoutes, 3);
  assert.match(queued.reason, /3 route\(s\) queued/);

  // pendingRoutes === 0 → the honest whole-site terminal: BOTH frontiers empty → drained (unchanged).
  const done = decideProgress({ batchLen: 0, remaining: 0, pendingRoutes: 0 });
  assert.equal(done.action, 'drained');
  assert.equal(done.reason, 'frontier drained');
});

// (g) TYPED TERMINAL — CHURN-FLAT RELEASE GATE (blocker-6 Part B). On a re-rendering feed the stable set
// can drain (empty batch) while `churnSkipped` keeps GROWING as fresh rows vanish. Declaring DONE then
// would be dishonest — the feed is still spawning churn. So DRAINED releases only when the stable set is
// drained AND churnSkipped has FLATTENED over K windows. churnSkipped rides through EVERY verdict for the
// driver/report. K is a window count, never a clock.
// Guards: the release gate — an empty template batch with churnSkipped STILL GROWING yields 'continue'
//   (one more window), and only flattened churn releases 'drained'; and the residual is carried through.
// FAIL-ON-REVERT: remove the churn-flat gate in loop-control.mjs (the `if (churnSkipped > 0) { … !churnFlat
//   → continue }` block in the batchLen===0 branch) → the growing-churn case falls straight through to
//   'drained' → "churn still growing must NOT drain" reds.
test('typed terminal: growing churn does NOT release drained; flat churn does', () => {
  // Growing churn over a full K-window run ([3,6] prior + 9 now) with the stable set drained → NOT done.
  const growing = decideProgress({ batchLen: 0, remaining: 0, churnSkipped: 9, churnHistory: [3, 6] });
  assert.notEqual(growing.action, 'drained', 'churn still growing must NOT drain (feed not yet stable)');
  assert.equal(growing.action, 'continue');
  assert.match(growing.reason, /churn still growing \(9\)/);
  assert.equal(growing.churnSkipped, 9, 'churnSkipped is carried into the verdict');

  // Flat churn over a full K-window run ([9,9] prior + 9 now), stable set drained → DONE (feed stabilized).
  const flat = decideProgress({ batchLen: 0, remaining: 0, churnSkipped: 9, churnHistory: [9, 9] });
  assert.equal(flat.action, 'drained', 'flattened churn releases drained');
  assert.match(flat.reason, /9 feed row\(s\) churnSkipped/);
  assert.equal(flat.churnSkipped, 9);
});

// (h) CONSERVATIVE with thin history / no churn. With churnSkipped>0 but fewer than K windows seen we
// keep going one more window (cannot yet confirm flat); with NO churn at all we drain immediately (the
// unchanged terminal). Reds if the `churnSkipped > 0` guard is dropped (no-churn would spuriously continue)
// or the `recentChurn.length >= stallWindows` full-window guard is dropped (thin history would drain).
test('typed terminal: thin churn history continues one more window; zero churn drains immediately', () => {
  const thin = decideProgress({ batchLen: 0, remaining: 0, churnSkipped: 5, churnHistory: [] });
  assert.equal(thin.action, 'continue', 'churn present but < K windows of history → one more window');

  const noChurn = decideProgress({ batchLen: 0, remaining: 0, churnSkipped: 0, churnHistory: [] });
  assert.equal(noChurn.action, 'drained', 'no churn → drain immediately (unchanged terminal)');
  assert.equal(noChurn.reason, 'frontier drained');
  assert.equal(noChurn.churnSkipped, 0);
});
