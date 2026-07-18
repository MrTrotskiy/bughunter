// ANIMATION SETTLE — the half of "is this page ready" that `waitSettled` does not cover.
//
// `waitSettled` waits for the NETWORK to go quiet. Playwright's actionability has a separate criterion:
// an element is "stable" only once its bounding box has been unchanged for two consecutive animation
// frames. An AntD modal or dropdown animates in over ~200-300ms, so a replayed click sequence — open a
// container, immediately click inside it — lands squarely in the transition, and the failure surfaces as
// `element is not stable` inside a click timeout, entangled in the same error string as an occlusion
// failure and indistinguishable from it after the fact.
//
// This exists for DIAGNOSTIC DETERMINISM more than for correctness: Playwright's own 5s click timeout will
// usually outlast a 300ms transition on its own. What it buys is an unambiguous failure signal — without
// it, a failed reopen hop cannot be told apart from a still-animating one, and the whole point of the
// reopen probe is a decisive answer.
//
// SCOPE, stated honestly: this is a PROXY tuned for AntD, not a general stability predicate. Playwright
// checks one ELEMENT's bounding box over two frames; `document.getAnimations()` is document-global and sees
// only WAAPI/CSS animations. So it can read busy because of an unrelated sidebar animation, and it can read
// settled through a requestAnimationFrame-driven JS animation that registers no Animation object at all.
// AntD and rc-motion use CSS transitions, which it does see — that is why it is useful here and why it
// should not be promoted to a general primitive.
//
// The finite-`iterations` filter is an OPTIMISATION, not a correctness property: what actually bounds this
// is the deadline. Without the filter an infinite spinner would simply burn the full timeout on every hop.
// Do not "improve" the filter believing correctness rests on it.
//
// Three-valued on purpose: true = settled, false = still animating at the deadline, null = could not ask
// (the page navigated, the context died). Collapsing null into true would make "no animations" and "no
// answer" indistinguishable — self-defeating for a module whose entire reason to exist is an unambiguous
// diagnostic signal.

export async function settleAnimations(page, { timeout = 600, interval = 50 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let failed = false;
    const busy = await page.evaluate(() => {
      if (typeof document.getAnimations !== 'function') return 0;
      return document.getAnimations()
        .filter((a) => a.playState === 'running')
        .filter((a) => {
          // Skip infinite animations (spinners): they never settle and are not what a click waits on.
          const t = a.effect && typeof a.effect.getTiming === 'function' ? a.effect.getTiming() : null;
          return !t || Number.isFinite(t.iterations);
        }).length;
    }).catch(() => { failed = true; return 0; });
    if (failed) return null;
    if (!busy) return true;
    if (Date.now() >= deadline) return false;
    await page.waitForTimeout(interval);
  }
}
