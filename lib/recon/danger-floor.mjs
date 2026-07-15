// A deterministic SAFETY BACKSTOP for recon — NOT the judge. The LLM does the rich
// danger call; this coarse regex floor exists only so observe.mjs can REFUSE to let a
// mis-judging agent fire the obvious destructive / auth / payment controls. It is a
// net, never the source of truth (decisions.md "LLM belongs in the walk" — brittle
// thresholds were a documented source of the old project's fragility).
//
// Classifies from control name + route only. No match on a real control → "safe";
// nothing to classify at all (empty name AND route) → "unknown". Enforcement (in
// observe) refuses an ACTED observation only when the floor is destructive/auth/payment.

const DESTRUCTIVE = /\b(delete|remove|destroy|drop|erase|trash|discard|wipe|purge|reset|deactivate|terminate|revoke|unpublish|close account)\b/i;
const AUTH = /\b(log\s?out|sign\s?out|sign\s?off|log\s?off)\b/i;
const PAYMENT = /\b(pay|checkout|purchase|buy|subscribe|place\s?order|billing|send\s?money|transfer|wire|donate|order\s?now)\b/i;

// Classify from name + route. The haystack is normalized so `deleteAccount`,
// `logout_btn`, `pay-now` and `/account/delete` expose their words to the whole-word
// patterns. NON-EXHAUSTIVE by nature: an icon-only control (no name) → `unknown`, and
// non-English / obfuscated destructive labels are NOT caught here — the Sonnet agent's
// judgment (recon.md) is the real defense for those. A named control with no match →
// `safe`. This is a coarse backstop, never the source of truth (decisions.md).
export function dangerFloor({ name = '', route = '' } = {}) {
  const hay = `${name || ''} ${route || ''}`
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // split camelCase
    .replace(/[_\-/]+/g, ' ')               // split snake / kebab / path separators
    .trim();
  if (!hay) return 'unknown';
  if (PAYMENT.test(hay)) return 'payment';
  if (AUTH.test(hay)) return 'auth';
  if (DESTRUCTIVE.test(hay)) return 'destructive';
  return 'safe';
}

// The floor classes the fire path (and route guard) REFUSE. Single source of truth,
// imported by step.mjs (click gate) and recon-run.mjs (navigation gate).
export const REFUSED = new Set(['destructive', 'auth', 'payment']);

// Route-level refusal. The click gate (step.mjs) only sees a control's NAME, so a GET
// `/logout` route reached by NAVIGATION (persistentStep re-navigates to a control's own
// route) would log an authenticated session out with no click the name-floor ever sees.
// Classifying the route path alone closes that authed-only hole.
export function routeRefused(route) {
  // Percent-decode first (defense-in-depth): a browser normally canonicalizes a navigated
  // url so node.route is already decoded, but decoding here means a `/log%6fut` that slipped
  // through un-normalized still classifies as auth rather than a bland `log%6fut` token.
  let r = route || '';
  try { r = decodeURIComponent(r); } catch { /* malformed escape — fall back to the raw route */ }
  return REFUSED.has(dangerFloor({ route: r }));
}
