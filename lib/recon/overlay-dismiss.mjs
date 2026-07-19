// overlay-dismiss — the MID-WALK app-modal/overlay closer. DISTINCT from overlays.mjs (the
// BEFORE-snapshot cookie/consent accept sweep): this one closes an APP modal/dialog that an EARLIER
// act opened. On a modal-heavy app the stateful walk STAYS on the page, so an act that opens a
// full-screen backdrop modal leaves it up, and every sibling control behind it then click-TIMES-OUT
// (obscured, NOT hidden — Playwright still reports it visible) → mass unreachable → premature drain.
// The operator's model is: study the modal, then CLOSE it, then continue on the page. This is the
// closer that restores the base page.
//
// CAUSAL DISCIPLINE: run ONLY under __idle__ (the caller resets the cause + tracker verdicts around
// it, and actStep already reset the cause on its click-timeout throw). Escape and a curated
// close-affordance click are idle-time UI ops — they fire no measured request, forge no causal edge,
// and never open a causal window (no beginCause here). It NEVER navigates: an off-origin anchor is
// refused (mirroring overlays.mjs), and it clicks ONLY overlay/dialog-class close controls + known
// backdrops, never a general nav — so it cannot destroy page state it was not meant to.
//
// Returns whether it ACTUALLY dismissed something (the blocking-overlay signature dropped). The
// caller bounds a dismiss→retry to a real close and treats "dismiss changed nothing" as drained, so
// no infinite loop: nothing to close → false → the control is honestly unreachable / the route drained.

// Curated close affordances — a modal's OWN close control (high precision).
const CLOSE_SELECTORS = [
  '[aria-label="Close" i]',
  '[data-dismiss="modal"]',
  '[data-dismiss]',
  'button.close',
  '.modal-close',
  '.ant-modal-close',
  '.close-modal',
  '.dialog-close',
];

// Known BACKDROP classes (click-outside-to-close). Safe to click — they ARE the overlay mask.
const BACKDROP_SELECTORS = ['.ant-modal-wrap', '.modal-backdrop', '.ant-modal-mask'];

// Overlay/dialog classes that count toward the "is a blocking overlay present" signature.
const OVERLAY_SELECTORS = [
  '[role="dialog"]', '[aria-modal="true"]', '.modal', '.ant-modal', '.ant-modal-wrap',
  '.ant-modal-mask', '.modal-backdrop', '.MuiDialog-root', '.MuiModal-root', '.ReactModal__Overlay',
];

// Count visible blocking overlays: curated overlay classes PLUS a generic full-screen fixed high-z
// backdrop the curated list may miss. Purely a CHANGE-DETECTOR (before vs after) — dismissal itself
// only ever touches Escape / curated close / known backdrops, never a generic-detected element.
function signatureScript(overlaySelectors) {
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  };
  const seen = new Set();
  let count = 0;
  for (const el of document.querySelectorAll(overlaySelectors.join(','))) {
    if (seen.has(el)) continue;
    seen.add(el);
    if (isVisible(el)) count++;
  }
  // Generic full-screen fixed/absolute high-z backdrop (bounded scan).
  let scanned = 0;
  for (const el of document.querySelectorAll('body *')) {
    if (++scanned > 3000) break;
    if (seen.has(el)) continue;
    const st = getComputedStyle(el);
    if (st.position !== 'fixed' && st.position !== 'absolute') continue;
    const z = parseInt(st.zIndex, 10);
    if (!(z >= 1000)) continue;
    const r = el.getBoundingClientRect();
    if (r.width >= window.innerWidth * 0.9 && r.height >= window.innerHeight * 0.9 && isVisible(el)) {
      seen.add(el);
      count++;
    }
  }
  return count;
}

// Click the first visible curated close affordance, else a known backdrop. Refuses an off-origin
// anchor (a browser link-follow is not SSRF-gated) and clicks only visible overlay-class controls.
function clickCloseScript({ closeSelectors, backdropSelectors }) {
  const isVisible = (el) => {
    const r = el.getBoundingClientRect();
    const st = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
  };
  const clickIfSafe = (el) => {
    if (!el) return false;
    if (el.tagName === 'A' && el.href) {
      let same = false;
      try { same = new URL(el.href).origin === location.origin; } catch { same = false; }
      if (!same) return false;
    }
    if (!isVisible(el)) return false;
    el.click();
    return true;
  };
  for (const sel of closeSelectors) {
    let el = null;
    try { el = document.querySelector(sel); } catch { el = null; }
    if (clickIfSafe(el)) return true;
  }
  for (const sel of backdropSelectors) {
    let el = null;
    try { el = document.querySelector(sel); } catch { el = null; }
    if (clickIfSafe(el)) return true;
  }
  return false;
}

const overlaySignature = (page) => page.evaluate(signatureScript, OVERLAY_SELECTORS);

// WILL A CLICK ON THIS ELEMENT BE INTERCEPTED? Asked of the page directly, via the same hit-test the
// browser itself uses, so it needs no curated selector list and works on any framework's overlay.
//
// WHY THIS EXISTS. The dismiss above ran only AFTER a click had already failed, so the ordinary cost of an
// open modal was a 5s timeout per obscured control — and when the dismiss then failed to change anything,
// the control was written off. Measured in run probe7: 17 of 48 acts died this way, every one of them on
// `ant-modal-wrap ... intercepts pointer events`. That is a third of the run spent waiting to be told
// something the page would have answered instantly if asked.
//
// A target INSIDE the overlay is not obscured — it is the thing the modal is showing, and dismissing would
// destroy exactly the state we want to study. `contains` covers that case, so studying a modal's own
// contents keeps working unchanged.
export async function clickIntercepted(page, handle) {
  if (!handle) return false;
  try {
    return await handle.evaluate((el) => {
      const r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0)) return false;
      const x = r.left + r.width / 2;
      const y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) return false;
      const top = document.elementFromPoint(x, y);
      if (!top) return false;
      // `<html>` / `<body>` receiving the hit is ALWAYS an interception, never a wrapper acting on the
      // element's behalf. This is the Radix/shadcn shape: an open dialog sets `pointer-events: none` on the
      // body, every descendant inherits it, and `elementFromPoint` falls all the way through to the root.
      // The first version of this check allowed any ancestor — and since `<html>` contains everything, it
      // swallowed exactly the case Playwright reports verbatim as `<html …> intercepts pointer events`.
      const tag = top.tagName;
      if (tag === 'HTML' || tag === 'BODY') return true;
      // Otherwise the hit is ours if the topmost element is the target, inside it, or a wrapper around it
      // (a label around its input receives the click on the input's behalf — that is not interception).
      return !(top === el || el.contains(top) || top.contains(el));
    });
  } catch {
    return false;
  }
}

// Attempt to close a blocking app modal/overlay. Best-effort: any failure resolves to false, never
// throws to the caller. Returns true iff the blocking-overlay signature actually dropped.
// `handle` — when given, the element whose click is blocked. Passing it makes the decision to dismiss, and
// the verdict on whether dismissing WORKED, rest on the browser's own hit-test rather than on a curated
// selector list.
//
// THE GENERALISATION FAILURE THIS FIXES, measured the first time this tool met a second application.
// `overlaySignature` counts elements matching a curated list of overlay classes, most of them AntD's. The
// new target is Radix/shadcn, where an open dialog sets `pointer-events: none` on the BODY — so nothing in
// the curated list matches, the signature reads 0, and this function returned early WITHOUT EVEN PRESSING
// ESCAPE, which is the one close affordance that would have worked. Result: 55 of 59 failed acts in the
// first crawl, every one reporting `<html> intercepts pointer events`.
//
// The hit-test (`clickIntercepted`) had already detected the block correctly. The curated signature — an
// older, framework-shaped mechanism — was what discarded that knowledge. So when the caller supplies the
// blocked handle, the hit-test governs both ends and the selector list is demoted to what it is good at:
// deciding what to CLICK in order to close, not deciding whether anything is blocking.
export async function dismissBlockingOverlay(page, handle = null) {
  try {
    const blockedBefore = handle ? await clickIntercepted(page, handle) : false;
    const before = await overlaySignature(page);
    // Nothing on either signal → genuinely nothing to close.
    if (before === 0 && !blockedBefore) return false;
    // 1) Escape — the universal modal close, an idle-time UI op (no request, no navigation). Radix, MUI,
    //    HeadlessUI and AntD all honour it; it is tried FIRST precisely because it needs no selector.
    await page.keyboard.press('Escape').catch(() => {});
    // 2) A curated close affordance / known backdrop (safe: overlay-class only, off-origin anchor refused).
    await page.evaluate(clickCloseScript, { closeSelectors: CLOSE_SELECTORS, backdropSelectors: BACKDROP_SELECTORS }).catch(() => {});
    // The honest verdict: if we know which element was blocked, "did it work" means "can it be clicked now".
    if (blockedBefore) return !(await clickIntercepted(page, handle));
    const after = await overlaySignature(page);
    return after < before;
  } catch {
    return false;
  }
}
