// DOM SETTLE — wait until the page stops CHANGING, which is the only "ready" signal that covers a reveal.
//
// THE MEASURED FAILURE, and it was invisible because it looked like a finding. Run probe10: 17 of the 25
// elements stuck at L2 were `role=generic` divs verdicted `inert` — led by `more_horiz` and `expand_less`,
// AntD overflow and collapse triggers, which are about the last controls on a page that are genuinely dead.
// Measured live on the target: 925 DOM nodes and 0 dropdowns before the click; 925 and 0 IMMEDIATELY after;
// 942 and 2 after 700ms. The control opened a 17-node menu every time and we recorded it as dead surface,
// because the post-act snapshot ran before the menu existed.
//
// WHY THE TWO SIGNALS WE ALREADY HAD BOTH MISS IT:
//   - `waitSettled` waits for the NETWORK. An AntD dropdown mounts from state already in the client and
//     issues no request at all, so it returns instantly and truthfully.
//   - `settleAnimations` waits for `document.getAnimations()` to quiesce. Measured on the same click, it
//     returned `true` after ONE millisecond with zero dropdowns present: at that instant nothing is
//     animating yet, because the element that will animate has not mounted. Asking "is anything animating"
//     the moment before anything mounts is a question that always answers no. That module's own header
//     warns it is an AntD-shaped proxy and should not be promoted to a general predicate; this is that
//     warning coming true, and the reason this is a separate mechanism rather than a longer timeout there.
//
// WHAT THIS ASKS INSTEAD: has the DOM stopped changing? A reveal is a mutation by definition, whatever
// causes it — transition, rAF, timeout, or a framework scheduler — so a mutation-quiet predicate covers all
// of them and depends on no framework. It is a POLL rather than a MutationObserver deliberately: an observer
// would have to be installed inside the page, and everything this project injects into a page has to be
// argued against the causal-attribution invariant. A poll reads and mutates nothing.
//
// COST is bounded and paid only when something is happening: the fingerprint is cheap, quiet pages settle
// on the second sample, and the deadline caps the worst case.

// A structural digest — element count plus a shallow tag histogram. Deliberately text-free and
// attribute-free, exactly like `contentSig` and `domFingerprint`: a live feed rewrites its text constantly,
// and a text-sensitive digest would report "still changing" forever on any page with a clock or a counter.
const DIGEST = () => {
  const els = document.querySelectorAll('*');
  const counts = Object.create(null);
  for (const el of els) {
    const t = el.tagName;
    counts[t] = (counts[t] || 0) + 1;
  }
  // Visible overlay/portal containers are counted separately: a menu that mounts hidden and then becomes
  // visible is a change worth waiting through, and tag counts alone would already be stable by then.
  let shown = 0;
  for (const el of document.querySelectorAll('[role="menu"],[role="dialog"],[role="listbox"],.ant-dropdown,.ant-modal,.ant-popover,.ant-select-dropdown')) {
    const st = getComputedStyle(el);
    if (st.display !== 'none' && st.visibility !== 'hidden' && st.opacity !== '0') shown++;
  }
  return `${els.length}:${shown}:${Object.keys(counts).sort().map((k) => `${k}${counts[k]}`).join(',')}`;
};

// Poll until the digest repeats, or the deadline passes.
//
// Three-valued for the same reason `settleAnimations` is: `true` settled, `false` still changing at the
// deadline (a spinner, an infinite feed), `null` could not ask (the page navigated, the context died).
// Collapsing `null` into `true` would make "quiet" and "no answer" indistinguishable.
// `minWait` is the floor, and it is the load-bearing parameter rather than a safety margin. A page that is
// quiet because nothing will happen and a page that is quiet because the menu mounts in 400ms are
// INDISTINGUISHABLE from the DOM alone — the only way to tell them apart is to wait long enough for the
// second one to reveal itself. Without the floor this predicate concluded "settled" after two stable
// samples (~240ms) and returned before a 400ms mount, which is the very failure it was written to fix; the
// test caught that in the first implementation. The cost is bounded and paid per act, and it buys the
// difference between recording a reveal and recording dead surface.
export async function settleDom(page, { timeout = 1500, interval = 120, stableFor = 2, minWait = 550 } = {}) {
  if (!page) return null;
  const started = Date.now();
  const deadline = started + timeout;
  let last = null;
  let stable = 0;
  try {
    while (Date.now() < deadline) {
      const digest = await page.evaluate(DIGEST);
      if (digest === last) stable++;
      else { stable = 0; last = digest; }
      // Quiet AND past the floor: nothing more is coming that we are willing to wait for.
      if (stable >= stableFor && Date.now() - started >= minWait) return true;
      await page.waitForTimeout(interval);
    }
  } catch {
    return null;
  }
  return false;
}
