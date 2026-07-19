// OUTCOME OBSERVABLES — what the page tells us after an interaction, read deterministically.
//
// WHY THIS EXISTS. Until now the crawler could see only two things after an act: which requests it caused
// and which elements appeared. Everything else was inferred, and the inference that mattered most —
// "the form was refused by validation" — had no evidence behind it at all. It was asserted for six runs and
// then measured to be flatly wrong: the submit had never been clicked, so nothing was ever validated.
// A verdict nothing can contradict is not a verdict.
//
// So: REFUSED and INERT must be distinguishable from evidence. An act that fired no request because the
// page rejected it is a completely different fact from an act that fired no request because the control
// does nothing — the first is a working form we failed to satisfy, the second is dead weight in the
// denominator. Same observable surface also carries the success signal.
//
// THREE TIERS, most-standard first, and the order is deliberate: a tier that is silent costs nothing, and a
// target that answers on tier 1 needs no framework knowledge at all.
//   tier 1 — the HTML constraint validation API (WHATWG): `validity` flags + `validationMessage`. Spec-
//            defined, framework-independent, needs no selectors.
//   tier 2 — ARIA: `[aria-invalid=true]` plus the text of `aria-errormessage`/`aria-describedby`. Also
//            spec-defined, and what a screen reader would announce.
//   tier 3 — framework markup (`.ant-form-item-explain-error`). Target-specific and openly so; it exists
//            because tier 1 and 2 are silent on React-controlled inputs, which is the common case.
//
// MEASURED ON THE LIVE TARGET, and the result is why the success channel is here too: submitting the Create
// Event form completely empty produced NO tier-1, NO tier-2 and NO tier-3 output — and a 201. The only
// signal of any kind was a live region reading "Event was successfully created". On that app the toast is
// the whole oracle, so `liveRegions` is not a nicety.
//
// READ-ONLY and side-effect free: one `page.evaluate` plus buffered listener reads. It opens no causal
// window and must be called OUTSIDE one, like every other observation.

// Console / pageerror / dialog are page-LIFETIME signals, so they are buffered by an attached listener
// rather than polled. `attachPageSignals` is idempotent per page — attaching twice would double every
// entry, and a page is reused across acts.
const SIGNALS = new WeakMap();

export function attachPageSignals(page) {
  if (SIGNALS.has(page)) return SIGNALS.get(page);
  const buf = { console: [], pageErrors: [], dialogs: [] };
  const cap = (arr, v, max = 100) => { arr.push(v); if (arr.length > max) arr.shift(); };
  page.on('console', (m) => {
    const type = m.type();
    if (type !== 'error' && type !== 'warning') return;   // info/log is noise at this volume
    cap(buf.console, { type, text: String(m.text()).slice(0, 200) });
  });
  page.on('pageerror', (e) => cap(buf.pageErrors, String(e?.message || e).slice(0, 200)));
  // A dialog BLOCKS every subsequent command until it is handled, so it must be dismissed, not merely
  // observed — an unhandled confirm() freezes the whole crawl. Recorded first, then dismissed.
  page.on('dialog', async (d) => {
    cap(buf.dialogs, { type: d.type(), message: String(d.message()).slice(0, 200) });
    await d.dismiss().catch(() => {});
  });
  SIGNALS.set(page, buf);
  return buf;
}

// Take and CLEAR the buffered signals — each act owns the signals raised during it, so they must not
// accumulate across acts and be re-reported.
export function drainPageSignals(page) {
  const buf = SIGNALS.get(page);
  if (!buf) return { console: [], pageErrors: [], dialogs: [] };
  const out = { console: buf.console.slice(), pageErrors: buf.pageErrors.slice(), dialogs: buf.dialogs.slice() };
  buf.console.length = 0; buf.pageErrors.length = 0; buf.dialogs.length = 0;
  return out;
}

// The DOM-side readout. `scope` narrows to a container (a modal) when one is open, so a validation error
// in an unrelated background form is never credited to this act.
export async function readOutcome(page, { scope = null, seen = [] } = {}) {
  const dom = await page.evaluate(([sel, seen]) => {
    const root = (sel && document.querySelector(sel)) || document;
    const sig = (el) => (el.getAttribute('placeholder') || el.getAttribute('aria-label') || el.id
      || (el.className && String(el.className).split(/\s+/)[0]) || el.tagName).slice(0, 40);
    const text = (el) => (el && el.innerText ? el.innerText.trim().slice(0, 160) : '');

    // TIER 1 — WHATWG constraint validation. `willValidate` is false for disabled / readonly / barred
    // controls, so they raise no phantom obligation.
    //
    // `:user-invalid`, NOT `checkValidity()` alone. An empty required field is invalid the instant the page
    // loads, before anyone has touched anything — so `checkValidity()` would report a refusal on a page
    // that has said nothing, which is the exact false inference this module exists to remove. `:user-invalid`
    // matches only after the user has interacted or a submit has been attempted, i.e. only once the page
    // has actually pushed back. Where the pseudo-class is unsupported the reader falls back and the flags
    // still ride, so nothing is lost on an older engine — it is only less precise about WHEN.
    const userInvalid = (el) => { try { return el.matches(':user-invalid'); } catch { return !el.checkValidity(); } };
    const validity = [];
    for (const el of root.querySelectorAll('input,textarea,select')) {
      if (!el.willValidate || el.checkValidity() || !userInvalid(el)) continue;
      const v = el.validity;
      const flags = ['valueMissing', 'typeMismatch', 'patternMismatch', 'tooLong', 'tooShort',
        'rangeUnderflow', 'rangeOverflow', 'stepMismatch', 'badInput', 'customError'].filter((k) => v[k]);
      validity.push({ field: sig(el), flags, message: String(el.validationMessage || '').slice(0, 160) });
    }

    // TIER 2 — ARIA.
    const ariaInvalid = [...root.querySelectorAll('[aria-invalid="true"]')].map((el) => {
      const id = el.getAttribute('aria-errormessage') || el.getAttribute('aria-describedby');
      return { field: sig(el), message: text(id && document.getElementById(id)) };
    });

    // TIER 3 — framework markup. Named and target-specific by design; fails silent, never loud.
    const frameworkErrors = [...root.querySelectorAll('.ant-form-item-explain-error,.ant-form-item-has-error .ant-form-item-explain,[class*="error-message"]')]
      .map(text).filter(Boolean);

    // SUCCESS / FAILURE ANNOUNCEMENTS. On a target with no validation at all this is the only channel, and
    // it carries both outcomes — the class distinguishes them where the framework marks it.
    //
    // SCOPED AND DE-CONTAMINATED, and this is not a nicety. An AntD notification lives on screen for about
    // 4.5 seconds, so a toast raised by one act is still there when the next act reads — and it was being
    // credited to that next act. Measured: one "An error occurred" was recorded as the outcome of THREE
    // separate acts, promoting each to `rejected`. That is a verdict assigned by a time window, which is
    // precisely the reasoning the causal invariant forbids on the request channel, reappearing on the
    // outcome channel. So a caller passes the texts it saw BEFORE the act (`seen`) and only announcements
    // that were not already there are returned.
    const liveRegions = [...root.querySelectorAll('[role=alert],[role=status],[aria-live],.ant-message-notice,.ant-notification-notice')]
      .map((el) => ({ text: text(el), tone: /success/i.test(el.className) ? 'success' : /error|fail/i.test(el.className) ? 'error' : null }))
      .filter((x) => x.text && !(seen || []).includes(x.text));

    return {
      validity, ariaInvalid, frameworkErrors, liveRegions,
      containerOpen: !!document.querySelector('.ant-modal-wrap:not([style*="display: none"]),[role=dialog]'),
    };
  }, [scope, seen]).catch(() => null);

  const signals = drainPageSignals(page);
  return dom ? { ...dom, ...signals } : { validity: [], ariaInvalid: [], frameworkErrors: [], liveRegions: [], containerOpen: false, ...signals };
}

// Did the page REFUSE this interaction? Evidence-only — never inferred from "no request happened", which
// is the inference that was wrong for six runs. Refusal requires the page to have SAID something.
export function wasRefused(outcome) {
  if (!outcome) return false;
  return outcome.validity.length > 0
    || outcome.ariaInvalid.length > 0
    || outcome.frameworkErrors.length > 0
    || outcome.liveRegions.some((r) => r.tone === 'error');
}

// Did the page ANNOUNCE success? A 2xx on a mutating endpoint is the stronger signal and belongs to the
// caller's request ledger; this is the UI half, and on a target with no validation it is all there is.
export function announcedSuccess(outcome) {
  if (!outcome) return false;
  return outcome.liveRegions.some((r) => r.tone === 'success'
    || /success|created|saved|updated|sent|added|posted/i.test(r.text));
}

// The announcement texts currently on screen. A caller reads this BEFORE an act and passes it back as
// `seen`, so a stale toast from an earlier act cannot be credited to this one.
export async function liveRegionTexts(page, { scope = null } = {}) {
  return page.evaluate((sel) => {
    const root = (sel && document.querySelector(sel)) || document;
    return [...root.querySelectorAll('[role=alert],[role=status],[aria-live],.ant-message-notice,.ant-notification-notice')]
      .map((el) => (el.innerText || '').trim().slice(0, 160)).filter(Boolean);
  }, scope).catch(() => []);
}

// A STRUCTURAL FINGERPRINT of the page — the observable that works when nothing has a name.
//
// Measured on the live target: between 83% and 99% of controls carry NO accessible name. The dashboard has
// 227 elements and two named links. So every name-based mechanism in this project is half-blind here — the
// danger floor refused nothing across 33 openers, `looksLikeSubmit` recognises 14 controls out of hundreds,
// 23 of 59 fields have no label, and a third of all templates are a bare `div` with a click handler.
//
// Behaviour is what remains. A control that fires no request and reveals no new template can still CHANGE
// THE PAGE — a tab switching panels, an accordion expanding, a filter narrowing a list, a toggle flipping a
// price. Measured: 32 of 99 `inert` rows were exactly that class, scored identically to genuinely dead
// surface. This tells them apart, and it costs ZERO extra acts because it rides inside the observation
// window that already exists.
//
// TEXT-FREE AND ATTRIBUTE-FREE, deliberately, matching `contentSig`: a live feed rewrites its text
// constantly, so a text-sensitive digest would report a change on every single act and mean nothing. The
// digest counts STRUCTURE — tag path shapes and how many of each — so a panel swap registers and a clock
// tick does not.
export async function domFingerprint(page, { scope = null } = {}) {
  return page.evaluate((sel) => {
    const root = (sel && document.querySelector(sel)) || document.body;
    const counts = new Map();
    const walk = (el, depth) => {
      if (depth > 12) return;
      for (const c of el.children) {
        const vis = c.getBoundingClientRect();
        if (vis.width === 0 && vis.height === 0) continue;      // invisible subtrees are not a change
        const key = `${c.tagName}:${depth}`;
        counts.set(key, (counts.get(key) || 0) + 1);
        walk(c, depth + 1);
      }
    };
    walk(root, 0);
    let h = 2166136261 >>> 0;
    for (const k of [...counts.keys()].sort()) {
      const s = `${k}=${counts.get(k)}`;
      for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    }
    return { sig: h.toString(16), nodes: [...counts.values()].reduce((a, b) => a + b, 0) };
  }, scope).catch(() => null);
}

// Did the page's STRUCTURE change across the act? Null-safe: an unreadable fingerprint on either side
// reports "unknown" rather than inventing a change or an absence of one.
export function domChanged(before, after) {
  if (!before || !after) return null;
  return before.sig !== after.sig ? { changed: true, nodesBefore: before.nodes, nodesAfter: after.nodes } : { changed: false };
}
