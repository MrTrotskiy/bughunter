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

// Attempt to close a blocking app modal/overlay. Best-effort: any failure resolves to false, never
// throws to the caller. Returns true iff the blocking-overlay signature actually dropped.
export async function dismissBlockingOverlay(page) {
  try {
    const before = await overlaySignature(page);
    if (before === 0) return false;                                   // nothing blocking → no dismiss
    // 1) Escape — the universal modal close, an idle-time UI op (no request, no navigation).
    await page.keyboard.press('Escape').catch(() => {});
    // 2) A curated close affordance / known backdrop (safe: overlay-class only, off-origin anchor refused).
    await page.evaluate(clickCloseScript, { closeSelectors: CLOSE_SELECTORS, backdropSelectors: BACKDROP_SELECTORS }).catch(() => {});
    const after = await overlaySignature(page);
    return after < before;
  } catch {
    return false;
  }
}
