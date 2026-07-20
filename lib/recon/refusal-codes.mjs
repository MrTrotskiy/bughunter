// refusal-codes — turn the graph's free-text `unreachable` message into a countable code + an owner.
//
// WHY THIS IS A SEPARATE MODULE. `node.unreachable` / `inst.unreachable` hold PROSE: "refusing to fire a
// destructive control \"Reset\" (template 88)", "elementHandle.click: Timeout 5000ms exceeded", "cannot
// resolve instance body:nth-child(2) > div…". Prose written for a human cannot be summed, so nobody could
// answer "how many controls did the safety gate decline this run" without grepping. That is a log defect
// in its own right, and this file is the MIGRATION SHIM that makes the existing trail countable.
//
// IT IS NOT THE DESTINATION. The real fix is for each writer to record a code at the point of failure, the
// way Heritrix assigns one fetch status per URI (-4 "HTTP timeout", -5001 "Blocked by user setting",
// -5000 "out of scope upon reexamination"). Until the writers are converted, an unrecognised message must
// stay LOUD rather than be absorbed: axe-core's `incomplete` and Heritrix's -60 are both honest and both
// unactionable, and a catch-all that grows quietly destroys the value of the whole scheme.
//
// OWNERSHIP IS PART OF THE CODE, not a lookup bolted on later. OpenTelemetry's GenAI conventions make the
// same distinction structurally: a tool refusing is `error.type` on an execute_tool span, a judgement going
// wrong belongs to the agent span. Here the owner travels with the code so a reader cannot re-derive it
// from the code's NAME and get it wrong — which is exactly the bug this file was extracted after fixing.

//   policy — a deliberate refusal; working as designed, and it must still be counted
//   app    — the application made it impossible
//   script — our own machinery failed, or the message is one we have not mapped yet
//
// THE REFUSAL FAMILY IS ONE BUCKET. danger-floor and explore-policy refuse with SEVEN different verbs, not
// just "refusing to fire": the route-level gate says "refusing to NAVIGATE to a danger route", the foreign
// rail "refusing to DESTROY another user's content", the account rail "refusing to DELETE an account this
// run did not create", the outward rail "reaches a person or a third party outside the app". Reading only
// "refusing to fire" charged all of those to `unreachable-unclassified`/`script` — a policy decision blamed
// on our own machinery — while `failure-hints.mjs` classified each richly. They are all `gate-refused` /
// `policy`; the pattern below now catches the whole family, and `refusal-codes-reconcile.test.mjs` pins the
// two parsers so they cannot drift apart again.
const REASON_PATTERNS = [
  [/refusing to (?:fire|click|navigate|destroy|delete)|reaches a person or a third party/i, 'gate-refused', 'policy'],
  [/Timeout .*exceeded|Timeout \d+ms/i, 'timeout', 'app'],
  [/not attached to the DOM/i, 'detached', 'app'],
  [/cannot resolve|NO_INSTANCE/i, 'cannot-resolve', 'script'],
  [/REVEAL_CYCLE/i, 'reveal-cycle', 'script'],
  [/DISABLED/i, 'disabled', 'app'],
  [/SESSION LOST/i, 'session-lost', 'app'],
];

// classifyMessage(msg) → { code, owner }. An unmapped message lands in `unreachable-unclassified`, whose
// name is deliberately ugly: a rising count there means the shim has drifted from the writers.
export function classifyMessage(msg) {
  for (const [re, code, owner] of REASON_PATTERNS) if (re.test(msg)) return { code, owner };
  return { code: 'unreachable-unclassified', owner: 'script' };
}

export const KNOWN_CODES = REASON_PATTERNS.map(([, code]) => code);

// ═══ THE RECONCILIATION WITH failure-hints.CLASSES ══════════════════════════════════════════════════
//
// failure-hints.mjs is "THE SINGLE SOURCE OF TRUTH" for the FINE failure taxonomy (18 classes, keyed off
// trail codes); this shim is the COARSE census over the graph's free-text `unreachable` prose (7 buckets).
// Two prose-parsers over the same strings WILL drift unless something pins them. This table is that pin: it
// declares which coarse census bucket each fine taxonomy code rolls into, and `refusal-codes-reconcile`
// asserts it is TOTAL over CLASSES (add a class to failure-hints → a decision is FORCED here) and that,
// where the two parsers overlap on real prose, they AGREE. The granularities genuinely differ — the shim
// cannot see a reveal-path break, an off-origin skip, or a not-visible control from prose alone — so those
// map honestly to the `unreachable-unclassified` bucket rather than a fabricated finer one. `CLASSES` is
// deliberately NOT imported (no runtime coupling / cycle); the test cross-checks the two.
export const CENSUS_BUCKET_OF = {
  REVEAL_FIREWALL: 'unreachable-unclassified',
  REVEAL_HOP_MISSING: 'unreachable-unclassified',
  REVEAL_NAVIGATED: 'unreachable-unclassified',
  REVEAL_REFUSED: 'unreachable-unclassified',
  REVEAL_UNWALKABLE: 'unreachable-unclassified',
  NOT_VISIBLE: 'unreachable-unclassified',
  DISABLED: 'disabled',
  DANGER_REFUSED: 'gate-refused',
  ROUTE_REFUSED: 'gate-refused',
  OUTWARD_REFUSED: 'gate-refused',
  FOREIGN_DESTROY: 'gate-refused',
  ACCOUNT_PROTECTED: 'gate-refused',
  OFF_ORIGIN: 'unreachable-unclassified',
  NO_INSTANCE: 'cannot-resolve',
  NO_TEMPLATE: 'unreachable-unclassified',
  ALIAS_COLLISION: 'unreachable-unclassified',
  CLICK_TIMEOUT: 'timeout',
  DETACHED: 'detached',
  // The recordFail fallback codes are CODE-driven in failure-hints (they classify off the stamped trail
  // code, not prose), so this prose shim has no stable signature for them: their raw message is an arbitrary
  // Playwright error. They roll into the honest junk bucket — the census cannot bucket them from prose.
  POST_CLICK_FAILED: 'unreachable-unclassified',
  ACT_FAILED: 'unreachable-unclassified',
};
