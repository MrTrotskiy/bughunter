// relocation-memo — a run-scoped memory of which relocations have already been proven hopeless.
//
// WHY THIS EXISTS. `recoverGated` bounded its retries with `const attempted = new Set()` declared INSIDE
// the function, so the set died with every call. The driver re-entered the recovery pass on every drained
// visit to a route and cheerfully re-attempted the same targets from scratch.
//
// MEASURED, one pinned run of 675 seconds: 228 relocation attempts spread over **31 unique targets**.
// Six checkboxes were retried 18-19 times each, every attempt failing identically. 340 of those seconds —
// **50.4% of the entire run** — were spent re-purchasing failures the run had already paid for. Productive
// acts got 17%.
//
// A relocation failure is DETERMINISTIC in the way that matters: the recorded reveal path either replays
// or it does not, and nothing between two attempts on the same page changes that. So the first failure is
// the answer, and every repeat is waste.
//
// SCOPE IS THE WHOLE POINT. This must be created ONCE per run and passed down — hoisting it into the
// caller is the entire fix. Constructing it inside the pass that consults it restores the bug exactly.
//
// It is a CACHE OF FAILURES ONLY. A success is recorded for the count but never blocks a retry: a target
// that reopened once may legitimately need reopening again later, and refusing that would suppress real
// coverage. The asymmetry is deliberate — we memoize "this does not work", never "this is finished".
//
// ═══ A REOPEN IS WORTH EXACTLY WHAT THE ACT AFTER IT DELIVERS ═══════════════════════════════════════
//
// `record` used to be called with `re.ok` — the verdict of the RELOCATION, decided before the act it exists
// to enable had run. MEASURED, run state/runs/hunt1, seq 491-521: EIGHT consecutive `reopen{ok:true}` on
// template 1290 instance #1, each immediately followed by `act.failed NO_INSTANCE`. The container really
// did reopen and the target really was not in it — and the census printed `{attempted:12, succeeded:10}`,
// a 83% success rate for a mechanism that had just delivered nothing eight times running.
//
// That is the same class as the trail which recorded an act's INTENDED target rather than the element
// actually clicked and hid a wrong-control bug for seven runs: a field that reports the intention instead
// of the outcome, in a place nobody thought to doubt. `reopen` is not a goal, it is a means — the only
// evidence it worked is that the act it enabled then resolved.
//
// SO THE RECORD IS TWO-PHASE. `record` opens a PENDING entry and returns a `settle` callback; the caller
// closes it with the act's outcome. Nothing is counted `succeeded` until that happens, so a crash between
// the phases leaves the entry PENDING (disclosed in `stats`) rather than defaulting to success — an
// unresolved reading beats a flattering one. `settle` is idempotent, so a caller that closes in a `finally`
// AND on the happy path cannot double-count.
//
// A reopen whose act failed is memoized as a FAILURE, and that is deliberate rather than incidental: the
// reveal path verifiably replayed and the target verifiably was not there, which is exactly as
// deterministic as a path that would not replay at all. Without it, hunt1 bought the same empty container
// eight times.

const keyOf = (templateId, instanceKey) => `${templateId}::${instanceKey == null ? '' : instanceKey}`;

export function createRelocationMemo() {
  const failed = new Map();   // key -> the code of the first failure (kept for the trail)
  let attempted = 0;
  let refusedRepeat = 0;
  let succeeded = 0;
  let pending = 0;            // reopens opened and never settled — a crash, never a success
  let deliveredNothing = 0;   // the reopen worked and the act it enabled did not resolve

  const fail = (k, code) => { if (!failed.has(k)) failed.set(k, code || 'UNKNOWN'); };

  return {
    // Should we spend a relocation on this target? False once it has failed at least once — where "failed"
    // now includes "reopened, and the act found nothing there".
    shouldAttempt(templateId, instanceKey) {
      if (failed.has(keyOf(templateId, instanceKey))) { refusedRepeat++; return false; }
      return true;
    },
    // PHASE 1 — the reopen itself returned. A failed reopen is terminal here (no act follows it) and is
    // filed immediately; a successful one opens a PENDING entry and returns the closer for phase 2.
    // Returns null when there is nothing to settle, so `settle && settle(...)` is a safe call shape.
    record(templateId, instanceKey, ok, code = null) {
      attempted++;
      const k = keyOf(templateId, instanceKey);
      if (!ok) { fail(k, code); return null; }
      pending++;
      let settled = false;
      // PHASE 2 — what the act the reopen enabled actually did. `actOk` is the ONLY thing that promotes
      // this attempt to `succeeded`.
      return function settle(actOk, actCode = null) {
        if (settled) return;
        settled = true;
        pending--;
        if (actOk) { succeeded++; return; }
        deliveredNothing++;
        fail(k, actCode || 'REOPEN_ACT_FAILED');
      };
    },
    // Why a target is being skipped — so the trail can say "refused, already failed with X" instead of
    // going quiet, which is the defect this whole line of work exists to stop repeating.
    reasonFor(templateId, instanceKey) {
      return failed.get(keyOf(templateId, instanceKey)) || null;
    },
    // `succeeded` counts reopens whose ACT resolved. `deliveredNothing` is the class that used to hide
    // inside it, and `pending` is the honest "we opened this and never heard back" bucket — both are
    // emitted so `attempted = succeeded + deliveredNothing + reopenFailed + pending` can be checked by a
    // reader rather than assumed.
    stats() {
      return { attempted, succeeded, refusedRepeat, distinctFailed: failed.size, pending, deliveredNothing };
    },
  };
}
