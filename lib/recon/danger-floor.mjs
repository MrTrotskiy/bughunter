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
// COMMUNICATION / MEDIA side-effect: initiating a real-time call, livestream, or meeting is an
// IRREVERSIBLE outward side-effect that does NOT ride the abortable HTTP layer — a WebRTC/media
// negotiation rings a real person / goes live to real viewers, and the network write-firewall (which
// aborts non-GET fetch/XHR) CANNOT stop it. So this is a HARD refusal like destructive/auth/payment
// (always-consulted, never reveal-opener-exempt): the crawl MAPS such a control (honest coverage — it is
// present in the graph, flagged refused) but NEVER fires it. Tight patterns — a bare "call" is too
// ambiguous ("call to action", "recall"), so a call/meeting verb needs its medium (video/voice/audio)
// or an explicit start/join/go-live phrasing ("dial"/"hang up" are unambiguous telephony verbs). RESIDUAL
// (security review M2, honest): this is NAME-based like every floor class — an ICON-only call/go-live
// button (no accessible name) classifies 'unknown', not 'communication', and falls to the LLM judge
// (recon.md), NOT the network firewall (WebRTC is off the abortable HTTP layer). Bare "Call"/"Join now"/
// "Ring"/"Huddle"/"Share screen" are also missed by design — the Sonnet agent is the real defense here.
const COMMUNICATION = /\b(video\s?call|voice\s?call|audio\s?call|(start|make|join|host)\s?(a\s|the\s)?call|(start|join|host)\s?(a\s|the\s)?meeting|go\s?live|start\s?(a\s)?broadcast|start\s?(a\s)?stream|live\s?stream|livestream|dial|hang\s?up)\b/i;

// The curated mutation-verb vocabulary — the SINGLE home of the write/mutation word list that both
// the read-only network firewall (read-only-firewall.mjs WRITE_VERB_RE, a URL-PATH gate) and
// mutationFloor below (a control-NAME gate) share. ONE fact, two anchorings so each gate fits its
// input: a control NAME is a real token → whole-word `\bverb\b`; a URL path segment can be a compound
// like `followandunfollow` → a LEADING-boundary `\bverb` (read-only-firewall builds that from this
// string). Kept dependency-free here (danger-floor is a leaf imported by the click + navigation gates)
// so read-only-firewall imports DOWN to it, never the reverse.
export const MUTATION_VERBS = 'follow|unfollow|like|unlike|delete|remove|create|add|new|post|publish|share|submit|send|upload|update|edit|save|block|report|subscribe|unsubscribe|join|leave|invite|comment|vote|purchase|checkout|pay|transfer';
const MUTATION_NAME_RE = new RegExp(`\\b(${MUTATION_VERBS})\\b`, 'i');

// Normalize a name+route haystack so an attribute-derived label (`deleteAccount`, `logout_btn`,
// `pay-now`, `/account/delete`) exposes its words to the whole-word patterns. Extracted so dangerFloor
// AND mutationFloor share ONE transform (identical to the historical inline form — behavior-preserving).
function normalizeHay(name, route) {
  return `${name || ''} ${route || ''}`
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // split camelCase
    .replace(/[_\-/]+/g, ' ')               // split snake / kebab / path separators
    .trim();
}

// Classify from name + route. NON-EXHAUSTIVE by nature: an icon-only control (no name) → `unknown`, and
// non-English / obfuscated destructive labels are NOT caught here — the Sonnet agent's judgment
// (recon.md) is the real defense for those. A named control with no match → `safe`. This is a coarse
// backstop, never the source of truth (decisions.md).
export function dangerFloor({ name = '', route = '' } = {}) {
  const hay = normalizeHay(name, route);
  if (!hay) return 'unknown';
  if (PAYMENT.test(hay)) return 'payment';
  if (AUTH.test(hay)) return 'auth';
  if (DESTRUCTIVE.test(hay)) return 'destructive';
  if (COMMUNICATION.test(hay)) return 'communication';
  return 'safe';
}

// NAME-level mutation gate (INC read-only firewall, defense-in-depth). ADDITIVE to dangerFloor — it does
// NOT widen the always-consulted REFUSED set (that would refuse a benign `Follow`/`Like` on EVERY crawl and
// change default behavior), so it is a SEPARATE predicate a read-only-scoped caller opts into. Returns
// `mutation` for a control literally NAMED with a mutation verb (`Follow`, `Like`, `Submit`), else `safe`;
// `unknown` when there is nothing to classify — so an ICON control (no name, the exact rawcaster-incident
// class the name-floor missed) is NOT refused here and falls through to the network firewall's URL-path
// gate, which aborts the write while the causal edge still records (the map is preserved). This gate
// specifically covers the COMPLEMENT: a mutation-NAMED control firing a BENIGN-named endpoint the
// URL-path gate cannot see.
export function mutationFloor({ name = '', route = '' } = {}) {
  const hay = normalizeHay(name, route);
  if (!hay) return 'unknown';
  return MUTATION_NAME_RE.test(hay) ? 'mutation' : 'safe';
}

// The floor classes the CLICK path REFUSES. Single source of truth, imported by step.mjs (click gate).
// `communication` joins the hard-refused set: initiating a call/livestream/meeting is an irreversible
// outward side-effect off the abortable HTTP layer, so a CLICK on it is refused on EVERY crawl and is
// NEVER reveal-opener-exempt (unlike the softer mutationFloor 'mutation' class). The control is still
// mapped in the graph — refused, not hidden.
export const REFUSED = new Set(['destructive', 'auth', 'payment', 'communication']);

// The classes the NAVIGATION guard refuses (routeRefused). It EXCLUDES `communication`: navigating to a
// livestream/meeting VIEWING page (`/livestream/123`) is a READ (watching), not initiating a broadcast —
// blocking it would drop real coverage with no safety gain. Initiating a call is a CLICK, gated by the
// full REFUSED set above. destructive/auth/payment routes ARE refused (a GET /logout ends the session).
const REFUSED_NAV = new Set(['destructive', 'auth', 'payment']);

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
  return REFUSED_NAV.has(dangerFloor({ route: r }));
}
