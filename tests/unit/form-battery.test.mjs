// A FORM IS STUDIED INCREMENTALLY, NOT SUBMITTED ONCE.
//
// docs/GOAL.md, the operator's standing requirement: submit the form EMPTY and see what is sent and what
// comes back; fill ONE required field and submit; then the second; then the third. Each submit is a
// DIFFERENT QUESTION. Filling everything and submitting once answers the happy path only — it cannot say
// which field is genuinely required, whether validation lives in the client or the server, or what the
// server does when it is lied to. Today a submit button owes exactly one obligation (`click`) and is
// therefore CHARACTERISED after a single act, by construction.
//
// Guards: the ladder is derived from DECLARED required fields; it is BOUNDED three ways (required-only,
//   a hard cap with a counted remainder, and truncation at the first accepted incomplete submit); an
//   accepted incomplete submit becomes a FINDING rather than a silent stop; and each rung fills exactly
//   the first k required fields.
// FAIL-ON-REVERT: make `formBattery` return `[SUBMIT_EMPTY]` only (drop the per-field rungs) → "a form
//   owes one rung per required field" reds; drop the truncation branch → "an accepted incomplete submit
//   ends the ladder" reds and the crawl keeps paying real writes for an answered question; drop the
//   `if (!formFacts.required.length) return null;` guard in formConflict → "an all-optional form accepting
//   an empty submit is NOT a finding" reds (a spurious severity:high finding on every optional form buries
//   the real ones); compare the accepted rung against `required.length` instead of the true
//   `required.length + requiredBeyondCap` → "a large form accepted at the capped rung is an incomplete-accept"
//   reds (a 5-of-7 accept mis-scored as the complete form).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formFactsFrom, formBattery, fillsFor, formConflict, FORM_PROBE_CAP, SUBMIT_EMPTY, submitRung } from '../../lib/recon/form-battery.mjs';

const fields = [
  { selector: '#title', required: true, label: 'Title', kind: 'fill' },
  { selector: '#owner', required: true, label: 'Owner', kind: 'select' },
  { selector: '#note', required: false, label: 'Note', kind: 'fill' },
  { selector: '#hidden', required: true, label: 'H', kind: 'fill', disabled: true },   // not usable
];

test('a form owes one rung per declared-required field, empty first', () => {
  const facts = formFactsFrom(fields);
  assert.equal(facts.total, 3, 'a disabled field is not part of the form to study');
  assert.deepEqual(facts.required.map((r) => r.selector), ['#title', '#owner']);

  assert.deepEqual(formBattery(facts, []), [SUBMIT_EMPTY, submitRung(1), submitRung(2)],
    'empty first — "does anything stop me at all" is the cheapest and most informative question');

  // Each rung fills exactly the first k required fields, and nothing else.
  assert.deepEqual(fillsFor(SUBMIT_EMPTY, facts, fields), []);
  assert.deepEqual(fillsFor(submitRung(1), facts, fields).map((f) => f.selector), ['#title']);
  assert.deepEqual(fillsFor(submitRung(2), facts, fields).map((f) => f.selector), ['#title', '#owner']);
});

test('the ladder stops at the first submit the server ACCEPTS, and says what it learned', () => {
  const facts = formFactsFrom(fields);
  // The empty submit went through: every later rung would add fields to a request already proven
  // unnecessary. Continuing costs real writes and buys nothing.
  const rows = [{ kind: SUBMIT_EMPTY, verdict: 'write' }];
  assert.deepEqual(formBattery(facts, rows), [], 'answered — the ladder is done');

  const conflict = formConflict(facts, rows);
  assert.ok(conflict, 'and the truncation is a FINDING, not a silent stop');
  assert.equal(conflict.severity, 'high');
  assert.match(conflict.note, /EMPTY submit was accepted/);

  // A partially-filled form accepted is the same defect, one rung along.
  const partial = formConflict(facts, [{ kind: SUBMIT_EMPTY, verdict: 'rejected' }, { kind: submitRung(1), verdict: 'write' }]);
  assert.match(partial.note, /only 1 of 2/);

  // The COMPLETE form being accepted is correct behaviour, not a finding.
  assert.equal(formConflict(facts, [
    { kind: SUBMIT_EMPTY, verdict: 'rejected' },
    { kind: submitRung(1), verdict: 'rejected' },
    { kind: submitRung(2), verdict: 'write' },
  ]), null);
});

test('an all-optional form accepting an empty submit is NOT a finding — a false HIGH buries the real ones', () => {
  // formFactsFrom stamps formFacts for ANY form with fields, and formBattery always mints a submit-empty
  // rung, so without the required.length guard EVERY all-optional form (profile-edit, a Save with nothing
  // required, a filter Submit) fired a spurious severity:high `required-fields-not-enforced` under
  // explore-all. `required-fields-not-enforced` is meaningless with nothing declared required.
  const optional = [
    { selector: '#note', required: false, label: 'Note', kind: 'fill' },
    { selector: '#tag', required: false, label: 'Tag', kind: 'fill' },
  ];
  const facts = formFactsFrom(optional);
  assert.equal(facts.required.length, 0, 'the fixture has no declared-required field');
  assert.equal(formConflict(facts, [{ kind: SUBMIT_EMPTY, verdict: 'write' }]), null,
    'an accepted empty submit is correct behaviour when nothing was required — not a finding');

  // Same accepted-empty outcome, one required field: the finding STILL fires. The guard narrows the
  // false positive without deleting the real one.
  const withReq = formFactsFrom([{ selector: '#title', required: true, label: 'Title', kind: 'fill' }]);
  const real = formConflict(withReq, [{ kind: SUBMIT_EMPTY, verdict: 'write' }]);
  assert.ok(real, 'a required field whose empty submit was accepted is still a finding');
  assert.match(real.note, /EMPTY submit was accepted/);
});

test('the ladder is bounded, and the remainder is counted rather than hidden', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({ selector: `#f${i}`, required: true, kind: 'fill' }));
  const facts = formFactsFrom(many);
  assert.equal(facts.required.length, FORM_PROBE_CAP - 1, 'bounded — 20 required fields is not 20 writes');
  assert.equal(facts.requiredBeyondCap, 20 - (FORM_PROBE_CAP - 1),
    'and the rest are COUNTED — a bounded study must never look like a complete one');
  assert.equal(formBattery(facts, []).length, FORM_PROBE_CAP);
});

test('a large form accepted at the capped rung is an incomplete-accept, not a complete one', () => {
  // `formFacts.required` is capped at FORM_PROBE_CAP-1, so a 7-required form owns only 5 rungs. Comparing
  // the accepted rung against the CAPPED length read submit-req-5-accepted as "the complete form went
  // through (correct)" — but 2 required fields were still empty. Judge against the TRUE declared count.
  const seven = Array.from({ length: 7 }, (_, i) => ({ selector: `#r${i}`, required: true, kind: 'fill' }));
  const facts = formFactsFrom(seven);
  assert.equal(facts.required.length, FORM_PROBE_CAP - 1, 'the ladder is capped at 5 rungs');
  assert.equal(facts.requiredBeyondCap, 2, 'and 2 required fields are counted beyond the cap');

  // The server accepted the LAST minted rung (5 of 7 filled): a real incomplete-accept.
  const rows = [
    { kind: submitRung(1), verdict: 'rejected' }, { kind: submitRung(2), verdict: 'rejected' },
    { kind: submitRung(3), verdict: 'rejected' }, { kind: submitRung(4), verdict: 'rejected' },
    { kind: submitRung(5), verdict: 'write' },
  ];
  const conflict = formConflict(facts, rows);
  assert.ok(conflict, 'accepting a submit with 5 of 7 required fields filled is a finding, not the complete form');
  assert.match(conflict.note, /only 5 of 7/);
});

test('a refused rung is parked, not owed forever', () => {
  const facts = formFactsFrom(fields);
  // The modal closed mid-episode: transient, so the obligation stands and the loop retries.
  const owed = formBattery(facts, [{ kind: SUBMIT_EMPTY, blocked: 'NO_INSTANCE' }]);
  assert.ok(!owed.includes(SUBMIT_EMPTY), 'a blocked rung is parked with its reason');
  assert.deepEqual(owed, [submitRung(1), submitRung(2)], 'and the rest of the ladder still stands');
});
