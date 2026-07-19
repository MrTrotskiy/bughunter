// Loop-control verdict for the Phase-1 /recon driver: turn the per-window instance-level
// frontier history (plus the BFS route-queue depth) into a deterministic "keep going / visit a
// queued page / done / give up" signal, so the markdown driver terminates on an HONEST
// drained-or-stalled condition instead of a blind `cap 20`. Pure over its inputs — no graph, no
// browser, and NO CLOCK.
//
// WHY WINDOW-COUNT, NOT WALL-CLOCK: the stall test keys on a WINDOW COUNT (K windows of flat
// PROGRESS), never a time interval. A timer here would be the first crack toward the
// wall-clock attribution class the project forbids (the bug that killed bughunt-agents) —
// termination, like request attribution, must be event-driven, never clock-driven.
//
// TYPED TERMINAL + CHURN-FLAT RELEASE GATE (blocker-6 Part B): DRAINED is "true zero" — an empty
// template batch AND no queued routes — and the verdict carries the full residual so the driver/report
// always see WHAT is left ({remaining, cappedRemainder, drillSkipped-via-caller, churnSkipped}). But a
// re-rendering feed (the live-target archetype) keeps minting fresh churn: frontierInstanceStats peels
// vanished rows into `churnSkipped` so the STABLE set can reach remaining===0, yet declaring DONE while
// the feed is still spawning NEW churn would be dishonest. So "release only at zero" = the stable set
// drained AND `churnSkipped` growth has FLATTENED over K windows (window count, still clock-free). While
// churn is still growing we keep going one more window rather than call it done.

export const STALL_WINDOWS = 3; // consecutive flat-progress windows before we call it stalled

// decideProgress({ batchLen, remaining, cappedRemainder, progress, progressHistory, stallWindows,
//                  pendingRoutes, churnSkipped, churnHistory }) → verdict.
//   progress        — THIS window's monotone progress signal = walked + unreachable + walkable.
//   progressHistory — the PRIOR windows' `progress` values, oldest→newest, NOT including this window.
//   remaining/cappedRemainder — carried through into the verdict for reporting; NOT the stall signal.
//   pendingRoutes   — INC.1b: BFS route-frontier pages queued but not yet snapshot-visited (default 0,
//                     backward-compatible — a caller passing none behaves exactly as before).
//   churnSkipped    — THIS window's frontierInstanceStats.churnSkipped (feed rows re-rendered away).
//   churnHistory    — the PRIOR windows' `churnSkipped`, oldest→newest, NOT including this window
//                     (mirrors progressHistory). Drives the churn-flat release gate on the drained branch.
// Returns { action:'visit-route'|'drained'|'stalled'|'continue', reason, remaining, cappedRemainder, churnSkipped }.
export function decideProgress({
  batchLen,
  remaining,
  cappedRemainder = 0,
  progress,
  progressHistory = [],
  stallWindows = STALL_WINDOWS,
  pendingRoutes = 0,
  churnSkipped = 0,
  churnHistory = [],
} = {}) {
  // VISIT-ROUTE (INC.1b whole-site reach): the TEMPLATE frontier is empty, but the BFS route queue
  // still holds pages the harvest discovered — a page beyond the element cap (a wide nav's 9th tab)
  // may carry controls nobody has seen. The driver must visit ONE route (snapshot-only, edge-free —
  // route-cli.mjs) and re-emit, NOT declare the crawl drained. Precedes the drained branch so
  // 'drained' means BOTH the template frontier AND the route queue are empty (the honest whole-site
  // terminal). A route visit adds walkable templates → progress grows → the stall logic never
  // false-fires on it.
  if (batchLen === 0 && pendingRoutes > 0) {
    return {
      action: 'visit-route',
      reason: `template frontier empty; ${pendingRoutes} route(s) queued to visit`,
      remaining, cappedRemainder, pendingRoutes, churnSkipped,
    };
  }
  // DRAINED (typed terminal): the frontier handed out nothing this window AND no route is queued — the
  // STABLE control set is drained. NB: cappedRemainder > 0 means the run is NOT absolutely complete —
  // opener siblings beyond OPENER_INSTANCE_CAP were flagged (counted) but never walked, so the verdict
  // must SAY so and never read a bare "done".
  if (batchLen === 0) {
    // CHURN-FLAT RELEASE GATE: a re-rendering feed peels vanished rows into churnSkipped so the stable
    // set can drain — but do NOT declare DONE while the feed is still spawning fresh churn. recentChurn =
    // the last (K-1) prior windows' churnSkipped + this window's; churn is "still growing" iff we have a
    // full K-window run AND it is NOT flat (strictly all-equal). Conservative when history is thin: with
    // churnSkipped>0 but < K windows seen, keep going one more window; with churnSkipped===0 (no churn at
    // all) drain immediately. This is a WINDOW COUNT, never a clock — same discipline as the stall test.
    if (churnSkipped > 0) {
      const recentChurn = [...churnHistory.slice(-(stallWindows - 1)), churnSkipped];
      const churnFlat = recentChurn.length >= stallWindows && recentChurn.every((c) => c === recentChurn[0]);
      if (!churnFlat) {
        return {
          action: 'continue',
          reason: `stable set drained; churn still growing (${churnSkipped}) — feed not yet stable`,
          remaining, cappedRemainder, churnSkipped,
        };
      }
    }
    let reason = cappedRemainder > 0
      ? `frontier drained within cap; ${cappedRemainder} opener instance(s) beyond OPENER_INSTANCE_CAP flagged (not walked)`
      : 'frontier drained';
    if (churnSkipped > 0) reason += `; ${churnSkipped} feed row(s) churnSkipped (re-rendered away, flattened)`;
    return { action: 'drained', reason, remaining, cappedRemainder, churnSkipped };
  }

  // STALLED: batch still non-empty, but the MONOTONE PROGRESS signal has not moved for K windows.
  // recent = the last (K-1) prior windows' `progress` + this window's `progress`; stalled iff we
  // have a full K-window run AND every value in it is equal.
  //
  // WHY PROGRESS, NOT `remaining`: `remaining = walkable − walked − unreachable` (frontier.mjs),
  // so it sits FLAT on a BALANCED plateau — a window that walks 3 controls (walked+3) whose acts
  // reveal 3 new instances (walkable+3) leaves `remaining` UNCHANGED even though 6 real events
  // happened and the crawl made genuine forward progress. Keying the stall on flat `remaining`
  // (the prior bug) FALSELY declared that healthy drain+discovery crawl stalled and terminated it.
  // `progress = walked + unreachable + walkable` instead grows on EVERY event: +1 on an explore
  // (walked), +1 on a failed act (unreachable), +1 on a discovery (walkable) — so it is flat ONLY
  // when nothing was explored, failed, OR discovered, the true stall. It grows on balanced
  // discovery (walked+3, walkable+3 → +6) and on an unreachable-tail burn (unreachable+1 → +1), so
  // NEITHER false-stalls. (A panel-reach REOPEN can transiently DIP progress by un-draining an
  // instance; a dip breaks flatness and merely RESETS stall accumulation — safe/conservative,
  // never a false stall.) K is a WINDOW COUNT, never a wall-clock interval.
  const recent = [...progressHistory.slice(-(stallWindows - 1)), progress];
  if (batchLen > 0 && recent.length >= stallWindows && recent.every((p) => p === recent[0])) {
    return {
      action: 'stalled',
      reason: `progress flat at ${progress} over ${stallWindows} windows — nothing explored, failed, or discovered`,
      remaining,
      cappedRemainder,
      churnSkipped,
    };
  }

  // CONTINUE: still work to hand out, and progress is (or may yet be) happening.
  return { action: 'continue', reason: `${remaining} instance(s) remaining`, remaining, cappedRemainder, churnSkipped };
}
