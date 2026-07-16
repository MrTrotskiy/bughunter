// Loop-control verdict for the Phase-1 /recon driver: turn the per-window instance-level
// frontier history into a deterministic "keep going / done / give up" signal, so the markdown
// driver terminates on an HONEST drained-or-stalled condition instead of a blind `cap 20`.
// Pure over its inputs — no graph, no browser, and NO CLOCK.
//
// WHY WINDOW-COUNT, NOT WALL-CLOCK: the stall test keys on a WINDOW COUNT (K windows of flat
// PROGRESS), never a time interval. A timer here would be the first crack toward the
// wall-clock attribution class the project forbids (the bug that killed bughunt-agents) —
// termination, like request attribution, must be event-driven, never clock-driven.

export const STALL_WINDOWS = 3; // consecutive flat-progress windows before we call it stalled

// decideProgress({ batchLen, remaining, cappedRemainder, progress, progressHistory, stallWindows }) → verdict.
//   progress        — THIS window's monotone progress signal = walked + unreachable + walkable.
//   progressHistory — the PRIOR windows' `progress` values, oldest→newest, NOT including this window.
//   remaining/cappedRemainder — carried through into the verdict for reporting; NOT the stall signal.
// Returns { action:'drained'|'stalled'|'continue', reason, remaining, cappedRemainder }.
export function decideProgress({
  batchLen,
  remaining,
  cappedRemainder = 0,
  progress,
  progressHistory = [],
  stallWindows = STALL_WINDOWS,
} = {}) {
  // DRAINED: the frontier handed out nothing this window — no instance left to walk.
  // NB: cappedRemainder > 0 means the run is NOT absolutely complete — opener siblings beyond
  // OPENER_INSTANCE_CAP were flagged (counted) but never walked, so the verdict must SAY so and
  // never read a bare "done".
  if (batchLen === 0) {
    const reason = cappedRemainder > 0
      ? `frontier drained within cap; ${cappedRemainder} opener instance(s) beyond OPENER_INSTANCE_CAP flagged (not walked)`
      : 'frontier drained';
    return { action: 'drained', reason, remaining, cappedRemainder };
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
    };
  }

  // CONTINUE: still work to hand out, and progress is (or may yet be) happening.
  return { action: 'continue', reason: `${remaining} instance(s) remaining`, remaining, cappedRemainder };
}
