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
// IRREVERSIBLE outward side-effect — a WebRTC/media negotiation rings a real person / goes live to real
// viewers, and unlike a stray HTTP write there is nothing downstream that could undo it. So this is a
// HARD refusal like destructive/auth/payment: outside explore-all the crawl MAPS such a control (honest
// coverage — it is present in the graph, flagged refused) but NEVER fires it. Tight patterns — a bare "call" is too
// ambiguous ("call to action", "recall"), so a call/meeting verb needs its medium (video/voice/audio)
// or an explicit start/join/go-live phrasing ("dial"/"hang up" are unambiguous telephony verbs). RESIDUAL
// (security review M2, honest): this is NAME-based like every floor class — an ICON-only call/go-live
// button (no accessible name) classifies 'unknown', not 'communication', and falls to the LLM judge
// (recon.md). Bare "Call"/"Join now"/"Ring"/"Huddle"/"Share screen" are also missed by design — the
// Sonnet agent is the real defense here.
const COMMUNICATION = /\b(video\s?call|voice\s?call|audio\s?call|(start|make|join|host)\s?(a\s|the\s)?call|(start|join|host)\s?(a\s|the\s)?meeting|go\s?live|start\s?(a\s)?broadcast|start\s?(a\s)?stream|live\s?stream|livestream|dial|hang\s?up)\b/i;

// OUTWARD-FACING acts — the ones that LEAVE THE SYSTEM and reach a person or a third party. This class is
// refused on every tier, including dev, and that is the whole point of it: an environment label vouches
// that the application's OWN DATA are fixtures, it does NOT vouch that the outgoing integrations are
// sandboxed. A dev stand is routinely wired to a real SMTP, a real Stripe, a real SMS gateway — the mail
// arrives at a real inbox whichever environment sent it. This is exactly why Stripe ships test keys and
// Twilio ships test credentials: the safe thing is a non-delivering credential, and a crawler cannot verify
// it has one. So the refusal stands until the operator attests, per channel, that the channel is sandboxed.
//
// TWO GROUPS, and both were live gaps:
//   - MODERATION acts against a PERSON (report / abuse / block / flag). `explore-policy` classified these as
//     FOREIGN_ADDITIVE — "creates nothing of theirs to lose" — which is true of a like and false of a
//     report: a complaint reaches a moderator and is not undone by anything downstream. Measured: the
//     crawler clicked "Report Abuse" and "Block User" dozens of times across three runs and nothing reached
//     a real person ONLY because the confirmation modals were never completed. That accidental protection
//     is being removed on purpose by the work this guard precedes.
//   - EGRESS by channel (email / sms / push / external invite). `communication` already covered real-time
//     calls for exactly this reason ("an irreversible outward side-effect — nothing downstream can undo it
//     after the fact"); mail and SMS are the same argument and were simply never written down.
//
// DELIBERATELY NOT HERE: an in-app message. A direct message is a row in the app's own database, it is one
// of the six user flows the operator wants exercised, and folding it into this class would block the flow
// while protecting nobody. "Send Message" is internal; "Email this to a friend" is not.
const OUTWARD = /\b(report\s?(abuse|user|post|content)?|abuse|block\s?(user|account)?|unblock|flag\s?(as)?\s?(spam|abuse|inappropriate)?|send\s?(an?\s)?(email|e-mail|sms|text\s?message)|email\s?(this|to|invite)|invite\s?by\s?(email|sms)|resend\s?(invite|invitation|email)|notify\s?(by\s?)?(email|sms)|share\s?by\s?email)\b/i;

// Does this act leave the system and reach a person or a third party? Refused on EVERY tier — see above.
export function isOutwardFacing({ name = '', route = '' } = {}) {
  return OUTWARD.test(normalizeHay(name, route));
}

// The curated mutation-verb vocabulary — the SINGLE home of the write/mutation word list. A control
// NAME is a real token, so mutationFloor below anchors it whole-word (`\bverb\b`). Kept dependency-free
// here: danger-floor is a leaf, imported by the click + navigation gates, and imports nothing back.
export const MUTATION_VERBS = 'follow|unfollow|like|unlike|delete|remove|create|add|new|post|publish|share|submit|send|upload|update|edit|save|block|report|subscribe|unsubscribe|join|leave|invite|comment|vote|purchase|checkout|pay|transfer';
const MUTATION_NAME_RE = new RegExp(`\\b(${MUTATION_VERBS})\\b`, 'i');

// Normalize a name+route haystack so an attribute-derived label (`deleteAccount`, `logout_btn`,
// `pay-now`, `/account/delete`) exposes its words to the whole-word patterns. Extracted so dangerFloor
// AND mutationFloor share ONE transform (identical to the historical inline form — behavior-preserving).
function normalizeHay(name, route, authored) {
  return `${name || ''} ${route || ''} ${authored || ''}`
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2') // split camelCase
    .replace(/[_\-/]+/g, ' ')               // split snake / kebab / path separators
    .trim();
}

// Classify from name + route. NON-EXHAUSTIVE by nature: an icon-only control (no name) → `unknown`, and
// non-English / obfuscated destructive labels are NOT caught here — the Sonnet agent's judgment
// (recon.md) is the real defense for those. A named control with no match → `safe`. This is a coarse
// backstop, never the source of truth (decisions.md).
// THE ICON-ONLY LOGOUT. Measured on run goal1: the sidebar's logout control is an ICON button with an
// EMPTY accessible name, so the name-only haystack was blank, `dangerFloor` returned `unknown`, the gate
// passed it, and the crawl clicked it at act 220 — 124 of the run's remaining 174 navigations then landed
// on /login and collected nothing. 70% of the run was spent logged out while the ledger kept printing
// coverage. The AUTHORED IDENTIFIER was right there the whole time: an icon-only logout control (its authored test id names it).
// So the haystack now includes it, and `normalizeHay` (which already splits kebab/snake/camel) turns that
// into "sidebar logout icon button" where the existing whole-word AUTH pattern matches.
// This does NOT make the floor exhaustive — an unnamed, unlabelled icon is still `unknown`, and the agent's
// judgment remains the real defense (see the header). It closes the case where the author DID say what the
// control is and we were not reading it.
export function dangerFloor({ name = '', route = '', authored = '' } = {}) {
  const hay = normalizeHay(name, route, authored);
  if (!hay) return 'unknown';
  if (PAYMENT.test(hay)) return 'payment';
  if (AUTH.test(hay)) return 'auth';
  if (DESTRUCTIVE.test(hay)) return 'destructive';
  if (COMMUNICATION.test(hay)) return 'communication';
  return 'safe';
}

// NAME-level mutation CLASSIFIER. ADDITIVE to dangerFloor and deliberately NOT part of the REFUSED set —
// it gates nothing on its own (that would refuse a benign `Follow`/`Like` on every crawl). Returns
// `mutation` for a control literally NAMED with a mutation verb (`Follow`, `Like`, `Submit`), else `safe`;
// `unknown` when there is nothing to classify — so an ICON control (no name) reads `unknown`, honestly,
// rather than being asserted safe. Available to any caller that wants to LABEL a control's write-ness;
// the LLM judge (recon.md) is what actually decides.
export function mutationFloor({ name = '', route = '' } = {}) {
  const hay = normalizeHay(name, route);
  if (!hay) return 'unknown';
  return MUTATION_NAME_RE.test(hay) ? 'mutation' : 'safe';
}

// ACCOUNT-DELETION — a destructive action scoped to the ACCOUNT ITSELF (a SUBSET of destructive: the
// DESTRUCTIVE regex already catches "close account"/"deactivate"/"delete account"). Carved out as its OWN
// predicate because under EXPLORE-ALL it has a DIFFERENT condition than an ordinary destructive act:
// deleting an account is allowed ONLY when THIS run created that account (the operator's explicit rule — a
// disposable account the agent made is fair game; a pre-existing persistent test account is NOT deleted).
// explore-policy gates it on a run-created-account signal, NOT on the ownsTarget item marker (an account
// page has no post-card marker). A plain "Delete post" is destructive-but-NOT-account-deletion.
// Match an account NOUN and a DESTROY verb co-occurring in the haystack, in EITHER order — so both a
// "Delete account" NAME and an "/account/delete" ROUTE (noun-before-verb) classify. Over-matching here is
// the SAFE direction (an extra control needs the run-created signal), never the reverse.
const ACCOUNT_NOUN = /\b(account|profile|membership)\b/i;
const ACCOUNT_DESTROY = /\b(close|delete|deactivate|remove|terminate|cancel)\b/i;
export function isAccountDeletion({ name = '', route = '' } = {}) {
  const hay = normalizeHay(name, route);
  return ACCOUNT_NOUN.test(hay) && ACCOUNT_DESTROY.test(hay);
}

// OWNERSHIP-REQUIRED — verbs that MODIFY or DESTROY an EXISTING item, i.e. the acts whose safety depends on
// WHOSE item it is (the HUNT-<runId> marker in the target's DOM — hunt-gate.ownsTarget). Create/add/post/
// compose/comment/like are ADDITIVE (new content or a reaction) and do NOT need ownership — they never
// destroy another user's data. Fail-safe by design: an ambiguous "save" is treated as ownership-required.
// The union of the two halves split out below; kept as the whole-set predicate.
const OWNERSHIP_REQUIRED_RE = /\b(edit|update|save|change|modify|rename|delete|remove|destroy|discard|erase|trash|wipe|purge|drop|archive|unpublish|deactivate|terminate|revoke|reset)\b/i;
export function requiresOwnership({ name = '', route = '' } = {}) {
  return OWNERSHIP_REQUIRED_RE.test(normalizeHay(name, route));
}

// EXPLORE-ALL SPLIT (operator rule, 2026-07-18): on ANOTHER user's content the two halves of
// requiresOwnership have DIFFERENT fates — an EDIT is permitted provided the original is captured and
// restored (restore-journal.mjs), a DESTROY is the one act that can never be undone and stays refused.
// So the single OWNERSHIP_REQUIRED_RE above is split into its two halves here. They are deliberately
// DISJOINT, and their union is a SUBSET of OWNERSHIP_REQUIRED_RE (never wider), so no caller of the
// original predicate changes behavior. `reset`/`revert` sit in DESTROYS: a reset discards prior state
// with nothing to capture beforehand, so it is not restorable.
const DESTROYS_RE = /\b(delete|remove|destroy|discard|erase|trash|wipe|purge|drop|archive|unpublish|deactivate|terminate|revoke|reset)\b/i;
const EDITS_RE = /\b(edit|update|save|change|modify|rename)\b/i;

// True iff the control DESTROYS an existing item (irreversible — no restore is possible).
export function destroysContent({ name = '', route = '' } = {}) {
  return DESTROYS_RE.test(normalizeHay(name, route));
}

// True iff the control MODIFIES an existing item in place (reversible — the prior value can be captured
// and written back). On non-owned content this is what the restore journal brackets.
export function editsContent({ name = '', route = '' } = {}) {
  const hay = normalizeHay(name, route);
  return EDITS_RE.test(hay) && !DESTROYS_RE.test(hay);   // a "save changes / delete" combo reads as destroy
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

// DISMISS CONTROLS — the close/cancel of an overlay. Not a danger class: dismissing is harmless. It is
// classified here because THREE separate decisions depend on recognizing it, and they must agree:
//   1. stateful-step  — a dismiss hop must never enter a reveal path (a path through "cancel" closes the
//                       very overlay its target lives in; measured live on tpl 933 "Group Name").
//   2. reveal-replay  — such a path, if one was already recorded, must be refused rather than walked.
//   3. stateful-loop  — a dismiss must be acted LAST, after the overlay's own contents are drained.
// Anchored (^…$) on purpose: "Close" is a dismiss, "Close Account" is not, and a substring match would
// classify the second as the first.
const DISMISS_RE = /^(close|cancel|dismiss|back|done|ok|x|×|✕|✖)$/i;
// A modal's real close control often has no accessible name of its own, so the name synthesizer falls back
// to the container's whole text content and produces a BLOB: the live close button of the Create Event
// modal is role=generic named "closeSchedule a Meeting EventMeeting TitleEvent TypePublicDateTime…". The
// anchored pattern cannot match that, so the control ranked as an ordinary freshly-revealed candidate and
// was picked FIRST — the pass meant to drain the modal closed it instead (live: seq 66 opened, seq 67 shut
// it, seq 69 could no longer resolve a field inside). A blob is only treated as a dismiss when it STARTS
// with a dismiss verb and is long enough to be a container's concatenated text rather than a real label.
// No `i` flag and no `\b`, both deliberate. The blob is CONCATENATED text with no separator
// ("closeSchedule a Meeting Event…"), so `\b` never fires between "close" and "Schedule"; the boundary that
// does hold is "the verb is not continued by a lowercase letter", which admits the camel seam and the plain
// space while still rejecting "closet…" and "Cancellation…". Under `i` the lookahead would exclude uppercase
// too and defeat the camel case, so the verb alternatives spell out both leading cases instead.
const DISMISS_PREFIX_RE = /^(?:[Cc]lose|[Cc]ancel|[Dd]ismiss)(?![a-z])/;
const BLOB_MIN = 40;
export function isDismissControl({ name = '' } = {}) {
  const n = String(name).trim();
  if (DISMISS_RE.test(n)) return true;
  return n.length >= BLOB_MIN && DISMISS_PREFIX_RE.test(n);
}

// The AUTHOR's own label for a control, from wherever the snapshot recorded it: the classified `testid`,
// the instanceKey when the instance was keyed by one (`data-testid:<logout id>`), or a
// testid-based locator value. Read-only over the graph, never an identity input — it exists so the danger
// floor can see what the author called a control when the ACCESSIBLE NAME is empty, which on an icon-only
// button is the normal case rather than the exception.
export function authoredIdOf(node, instance) {
  const parts = [];
  const push = (v) => { if (typeof v === 'string' && v && !parts.includes(v)) parts.push(v); };
  push(node && node.testid);
  push(instance && instance.testid);
  const key = instance && instance.instanceKey;
  // instanceKey for a testid-keyed instance is "<attr>:<value>" — take the value side only, so the
  // attribute name itself never contributes words to the haystack.
  if (typeof key === 'string' && /^data-(testid|test-id|test|cy|qa|automation-id|pw):/.test(key)) {
    push(key.slice(key.indexOf(':') + 1));
  }
  const loc = node && node.locator;
  if (loc && typeof loc === 'object' && typeof loc.value === 'string' && /test|cy|qa|pw/.test(String(loc.kind || ''))) {
    push(loc.value);
  }
  return parts.join(' ');
}
