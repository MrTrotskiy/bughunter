// TWO PROSE-PARSERS OVER THE SAME FAILURE STRINGS MUST NOT DRIFT.
//
// `failure-hints.mjs` claims to be "THE SINGLE SOURCE OF TRUTH" for the failure taxonomy, but
// `refusal-codes.mjs` independently regexes the SAME failure prose into a COARSER census vocabulary
// (gate-refused / timeout / cannot-resolve / …) for the coverage ledger. Two free-floating parsers over one
// input decay exactly the way the taxonomy file was written to prevent: one gains a class, the other keeps
// dumping it in a junk bucket, and nobody notices.
//
// This test is the PIN. `refusal-codes.CENSUS_BUCKET_OF` declares how each fine taxonomy code rolls up into
// a coarse census bucket; the assertions below force that declaration to stay TOTAL over the taxonomy and
// to AGREE with `classifyMessage` on real prose. Adding a class to failure-hints reds TOTALITY (a decision
// is forced here); changing a classifyMessage regex reds AGREEMENT; renaming a census bucket reds VALIDITY.
//
// Guards: failure-hints.CLASSES and refusal-codes cannot silently diverge.
// FAIL-ON-REVERT:
//   - add a CLASSES entry to failure-hints.mjs without a CENSUS_BUCKET_OF row → "TOTALITY" reds naming it;
//   - narrow the gate-refused pattern back to `/refusing to fire/` → the ROUTE_REFUSED / OUTWARD_REFUSED /
//     FOREIGN_DESTROY / ACCOUNT_PROTECTED agreement rows red (the whole reason the pattern was widened);
//   - point a CENSUS_BUCKET_OF value at a bucket refusal-codes does not emit → "VALIDITY" reds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CLASSES } from '../../lib/debug/failure-hints.mjs';
import { classifyMessage, KNOWN_CODES, CENSUS_BUCKET_OF } from '../../lib/recon/refusal-codes.mjs';

// One canonical prose message per taxonomy code — the shape each class's writer actually emits, copied from
// the failure-hints fixtures. The AGREEMENT assertion runs `classifyMessage` over these, so a canonical
// message must be present for every class (asserted below) — a new class cannot skip the check.
const CANON = {
  REVEAL_FIREWALL: 'reveal step 76 fired a firewall-refused request POST /x/addview (off-origin)',
  REVEAL_HOP_MISSING: 'reveal step selector div > button not present',
  REVEAL_NAVIGATED: 'reveal step changed route to /profile/xxx — no longer stay-on-page',
  REVEAL_REFUSED: 'reveal step 3 is a danger route',
  REVEAL_UNWALKABLE: 'reveal path is cyclic',
  NOT_VISIBLE: 'instance #upload is present but not visible in the current viewport',
  DISABLED: 'instance #save is visible but disabled — it cannot be operated in this state',
  DANGER_REFUSED: 'refusing to fire a destructive control "Delete" (template 12)',
  ROUTE_REFUSED: 'refusing to navigate to a danger route /logout',
  OUTWARD_REFUSED: 'reaches a person or a third party outside the app — refused on every tier — "Report content"',
  FOREIGN_DESTROY: "refusing to destroy another user's content (irreversible)",
  ACCOUNT_PROTECTED: 'refusing to delete an account this run did not create',
  OFF_ORIGIN: 'off-origin link to https://example.com',
  NO_INSTANCE: 'cannot resolve instance body:nth-child(2) > div',
  NO_TEMPLATE: 'no such template in the graph',
  ALIAS_COLLISION: 'alias collision: two instances resolved to one node',
  CLICK_TIMEOUT: 'elementHandle.click: Timeout 5000ms exceeded',
  DETACHED: 'elementHandle.click: Element is not attached to the DOM',
  // Code-driven fallbacks: their raw message is arbitrary and the prose shim recognises none of it.
  POST_CLICK_FAILED: 'the click reached the server but the step then failed',
  ACT_FAILED: 'the act did not complete',
};

const VALID_BUCKETS = new Set([...KNOWN_CODES, 'unreachable-unclassified']);
const taxonomyCodes = CLASSES.map((c) => c.code);

test('TOTALITY: every failure-hints taxonomy class has a census rollup — adding a class forces the decision', () => {
  const missing = taxonomyCodes.filter((code) => !(code in CENSUS_BUCKET_OF));
  assert.deepEqual(missing, [],
    `these failure-hints CLASSES have no CENSUS_BUCKET_OF row: ${missing.join(', ')}. `
    + 'Add each to refusal-codes.CENSUS_BUCKET_OF — decide which coarse census bucket it rolls into '
    + '(and, if the shim should recognise its prose, add a REASON_PATTERNS branch too).');
});

test('NO STALE KEYS: every rollup row names a real taxonomy class', () => {
  const known = new Set(taxonomyCodes);
  const stale = Object.keys(CENSUS_BUCKET_OF).filter((code) => !known.has(code));
  assert.deepEqual(stale, [], `CENSUS_BUCKET_OF names codes that are no longer failure-hints classes: ${stale.join(', ')}`);
});

test('VALIDITY: every rollup targets a bucket refusal-codes actually emits', () => {
  for (const [code, bucket] of Object.entries(CENSUS_BUCKET_OF)) {
    assert.ok(VALID_BUCKETS.has(bucket),
      `${code} rolls up to "${bucket}", which is not a census bucket (KNOWN_CODES ∪ unreachable-unclassified)`);
  }
});

test('EVERY class has a canonical message, so the agreement check covers all of them', () => {
  const missing = taxonomyCodes.filter((code) => !(code in CANON));
  assert.deepEqual(missing, [], `add a canonical prose sample for: ${missing.join(', ')}`);
});

test('AGREEMENT: the coarse parser lands each canonical message in the bucket the rollup declares', () => {
  // This is the anti-drift teeth. Where the two parsers see the same prose they must agree — so a widened
  // (or narrowed) classifyMessage regex, or a wrong rollup value, is caught here rather than in a run.
  for (const code of taxonomyCodes) {
    const got = classifyMessage(CANON[code]).code;
    assert.equal(got, CENSUS_BUCKET_OF[code],
      `${code}: classifyMessage("${CANON[code]}") → "${got}", but CENSUS_BUCKET_OF says "${CENSUS_BUCKET_OF[code]}"`);
  }
});

test('the widened refusal family all lands in one policy bucket (the drift the widening fixed)', () => {
  // Before the widen, only "refusing to fire" reached gate-refused; the route / outward / foreign / account
  // refusals fell into unreachable-unclassified/script — a policy decision blamed on our own machinery.
  for (const code of ['DANGER_REFUSED', 'ROUTE_REFUSED', 'OUTWARD_REFUSED', 'FOREIGN_DESTROY', 'ACCOUNT_PROTECTED']) {
    const { code: bucket, owner } = classifyMessage(CANON[code]);
    assert.equal(bucket, 'gate-refused', `${code} is a deliberate refusal — it belongs in gate-refused`);
    assert.equal(owner, 'policy', `${code} is owned by policy, not charged to the script`);
  }
});
