// Best-effort dismissal of cookie/consent overlays after a navigation. Real public sites
// gate the whole page behind a consent banner that intercepts pointer events — every
// underlying control then fails its click (surfaced as NOT_VISIBLE or a bounded timeout),
// so recon maps almost nothing until the banner is gone.
//
// This runs BEFORE any causal window opens (cause is still `__idle__`), so the accept
// click's request is excluded by the token filter and can never forge a causal edge. It
// is bounded and false-positive-guarded: it clicks ONLY a known consent-framework accept
// button, or an accept-TEXT button that sits inside a consent-scoped container (id/class
// matching cookie|consent|gdpr|cmp|privacy). It never obeys page text — the banner is
// matched structurally, not trusted. Every dismissal is returned so the caller can log it.
//
// The curated list needs live tuning against real targets; a fully custom banner it misses
// stays honestly `NOT_VISIBLE` (no silent failure).

// Known consent-framework accept-all selectors (high precision).
export const CONSENT_SELECTORS = [
  '#onetrust-accept-btn-handler',                                  // OneTrust
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',        // Cookiebot (allow all)
  '#CybotCookiebotDialogBodyButtonAccept',                         // Cookiebot (accept)
  '.osano-cm-accept-all',                                          // Osano
  '#didomi-notice-agree-button',                                   // Didomi
  'button[data-testid="uc-accept-all-button"]',                   // Usercentrics
  '.qc-cmp2-summary-buttons button[mode="primary"]',             // Quantcast
  '#truste-consent-button',                                        // TrustArc
  '#axeptio_btn_acceptAll',                                        // Axeptio
];

// Accept phrasings the text fallback will click — ONLY inside a consent-scoped container.
export const ACCEPT_TEXT = [
  'accept all', 'accept all cookies', 'accept cookies', 'accept',
  'agree', 'i agree', 'allow all', 'allow cookies', 'allow', 'got it', 'ok',
];

// Click the first consent-accept control found and report a short label, else null.
// Everything is best-effort: any failure resolves to null, never throws to the caller.
export async function dismissOverlays(page) {
  try {
    return await page.evaluate(({ selectors, acceptText }) => {
      const clickIfLive = (el) => {
        if (!el) return false;
        // Never let a consent "accept" NAVIGATE the browser off-origin. A hostile page could
        // put a framework accept id on an <a href="http://169.254.169.254/..."> to make this
        // click follow the link OUT of scope, bypassing the SSRF/gotoGated gate (a browser
        // link-follow is not gated). Refuse to click an off-origin anchor.
        if (el.tagName === 'A' && el.href) {
          let same = false;
          try { same = new URL(el.href).origin === location.origin; } catch { same = false; }
          if (!same) return false;
        }
        const r = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        // `opacity: '0'` counts as NOT visible, matching overlay-dismiss.mjs and dom-settle.mjs. This
        // predicate existed in four copies and this was the only one omitting opacity, so a fully
        // transparent consent banner was clickable here and invisible to the blocking-overlay detector —
        // the two disagreeing about the same element, which is how "the dismiss changed nothing" ends up
        // retiring a control as unreachable. Stricter is the safe direction: a transparent element is one
        // a user cannot see, so clicking it is never the intended act.
        const visible = r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none'
          && style.opacity !== '0';
        if (!visible) return false;
        el.click();
        return true;
      };
      for (const sel of selectors) {
        let el = null;
        try { el = document.querySelector(sel); } catch { el = null; }
        if (clickIfLive(el)) return sel;
      }
      // Fallback: an accept-text button, but ONLY with a consent-scoped ancestor, to bound
      // false positives (never dismiss a real content control that says "OK").
      const re = new RegExp('^(' + acceptText.join('|') + ')$', 'i');
      const scope = /cookie|consent|gdpr|cmp|privacy/i;
      for (const el of document.querySelectorAll('button, [role=button], a[role=button]')) {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (!re.test(text)) continue;
        let anc = el, scoped = false, depth = 0;
        while (anc && depth < 8) {
          const idc = (anc.id || '') + ' ' + (anc.getAttribute && anc.getAttribute('class') || '');
          if (scope.test(idc)) { scoped = true; break; }
          anc = anc.parentElement; depth++;
        }
        if (scoped && clickIfLive(el)) return 'text:' + text.slice(0, 32);
      }
      return null;
    }, { selectors: CONSENT_SELECTORS, acceptText: ACCEPT_TEXT });
  } catch {
    return null;
  }
}
