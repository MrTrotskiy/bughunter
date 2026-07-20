// form-battery — a form is studied INCREMENTALLY, not submitted once.
//
// docs/GOAL.md states the sequence the operator wants, and it is not a preference:
//   Open it. Submit it EMPTY. What is sent? What comes back? Does the CLIENT block it, or the SERVER?
//   Fill ONE required field. Submit. What changed in the request?
//   Fill the second. Submit. Then the third — one at a time.
//
// Each submit is a DIFFERENT QUESTION. Filling every field and submitting once answers only the happy path:
// it cannot tell which field is genuinely required, where validation lives, or what the server does when
// it is lied to. Those are the facts that turn a form from a black box into a white one, and they are
// exactly the facts a single submit throws away.
//
// This module is PURE: it computes what a form owes and which fields each rung fills. It performs no acts,
// touches no page, and mutates no graph — the caller executes each rung as an ordinary act with its own
// causal window, so N rungs are N acts and attribution is untouched.
//
// THE BOUND, three-fold, because a 30-field form must not become 30 writes:
//   1. The ladder is derived from REQUIRED fields only. A 30-field form with 3 required is 4 submits.
//   2. FORM_PROBE_CAP bounds the ladder regardless of how many fields declare themselves required.
//   3. EVIDENCE TRUNCATION: the ladder stops at the first submit the server ACCEPTS. "Which fields are
//      really required" is answered the moment an incomplete form goes through — continuing would buy
//      nothing and cost real writes. The truncation is RECORDED as a finding, never a silent subtraction.
//
// A note on cost that makes the early rungs nearly free: on a form with working native validation the
// browser refuses to send an incomplete submit at all, so `submit-empty` and the early partial rungs cost
// ZERO server writes. They cost writes precisely on forms that DON'T validate — which is the defect worth
// paying to find.

import { KINDS } from './probe-kinds.mjs';

// How many rungs one form may owe, however many required fields it declares.
export const FORM_PROBE_CAP = 6;

// The rung names. `submit-empty` first, then one rung per required field added cumulatively.
export const SUBMIT_EMPTY = 'submit-empty';
export const submitRung = (k) => `submit-req-${k}`;

// What a form DECLARES about itself, derived from the field census the caller already performs.
// Additive metadata, never an identity input — the same discipline as fieldFacts.
export function formFactsFrom(fields = []) {
  const usable = fields.filter((f) => f && f.selector && !f.disabled && !f.readOnly);
  const required = usable.filter((f) => f.required === true)
    .map((f) => ({ selector: f.selector, label: f.label || f.name || '', kind: f.kind || 'fill' }));
  return {
    total: usable.length,
    required: required.slice(0, FORM_PROBE_CAP - 1),
    // Required fields beyond the cap are COUNTED, so a form with 20 required fields reports an honest
    // remainder instead of quietly pretending it had 5.
    requiredBeyondCap: Math.max(0, required.length - (FORM_PROBE_CAP - 1)),
  };
}

// Did a recorded rung reach the server and get ACCEPTED? That is the truncation signal: an incomplete
// submit the server took means the declared requirements are not enforced, which is both the answer to
// "which fields are really required" and a finding in its own right.
const accepted = (row) => row && !row.blocked
  && ['write', 'write-unconfirmed', 'read', 'write+navigate'].includes(row.verdict);

// The rungs this form still owes, in order. `rows` are the element's recorded probe rows.
export function formBattery(formFacts, rows = []) {
  if (!formFacts) return [];
  const ladder = [SUBMIT_EMPTY, ...formFacts.required.map((_, i) => submitRung(i + 1))];
  const byKind = new Map();
  for (const r of rows) if (r && r.kind) byKind.set(r.kind, r);

  const owed = [];
  for (const rung of ladder) {
    const row = byKind.get(rung);
    if (!row) { owed.push(rung); continue; }
    if (row.blocked) continue;                 // asked and could not be answered — parked, not owed forever
    // TRUNCATION. The server took an incomplete form; every later rung would only add fields to a request
    // already proven unnecessary. Stop, and let `formConflict` state what was learned.
    if (accepted(row)) return [];
  }
  return owed;
}

// What this rung fills: nothing for `submit-empty`, the first k required fields for `submit-req-k`.
// Returns the SLICE of the caller's own field list, so the caller keeps using its existing actuation path.
export function fillsFor(kind, formFacts, fields = []) {
  if (!formFacts || kind === SUBMIT_EMPTY) return [];
  const m = /^submit-req-(\d+)$/.exec(String(kind));
  if (!m) return null;                          // not a form rung — caller decides
  const k = Number(m[1]);
  const wanted = new Set(formFacts.required.slice(0, k).map((r) => r.selector));
  return fields.filter((f) => f && wanted.has(f.selector));
}

// What the ladder LEARNED, as a finding. Two shapes, and both are defects worth a human's time:
//   - the server accepted a form missing fields the UI declares required
//   - every rung was refused, including the complete one (the form cannot be submitted at all)
export function formConflict(formFacts, rows = []) {
  if (!formFacts) return null;
  // `required-fields-not-enforced` is meaningless without a declared requirement: an all-optional form
  // (profile-edit, a Save with every field optional, a filter Submit) legitimately accepts an empty submit.
  // `formFactsFrom` stamps formFacts for ANY form with fields and `formBattery` always mints a submit-empty
  // rung, so without this guard EVERY optional form fired a spurious severity:high finding under explore-all
  // — and a false HIGH buries the real ones, the exact failure the findings layer exists to prevent.
  if (!formFacts.required.length) return null;
  // THE TRUE REQUIREMENT, not the capped ladder. `formFacts.required` is bounded at FORM_PROBE_CAP-1, so a
  // 7-required form owns only 5 rungs; comparing the accepted rung against the CAPPED length read
  // `submit-req-5 accepted` as "the complete form went through (correct behaviour)" when 2 required fields
  // were still empty — a real incomplete-accept scored as no finding. The declared count the server was
  // judged against is required + the counted overflow.
  const declaredRequired = formFacts.required.length + (formFacts.requiredBeyondCap || 0);
  const byKind = new Map();
  for (const r of rows) if (r && r.kind) byKind.set(r.kind, r);

  const empty = byKind.get(SUBMIT_EMPTY);
  if (accepted(empty)) {
    return {
      kind: 'required-fields-not-enforced', severity: 'high',
      note: `the form declares ${declaredRequired} required field(s), yet an EMPTY submit was accepted by the server`,
    };
  }
  for (let k = 1; k <= formFacts.required.length; k++) {
    const row = byKind.get(submitRung(k));
    if (!accepted(row)) continue;
    if (k >= declaredRequired) break;   // the complete form being accepted is correct behaviour
    return {
      kind: 'required-fields-not-enforced', severity: 'high',
      note: `submitted with only ${k} of ${declaredRequired} declared-required field(s) filled, and the server accepted it`,
    };
  }
  return null;
}

// The kinds this module mints, so `probe-kinds` can hold the closed vocabulary.
export const FORM_KINDS = Object.freeze({ SUBMIT_EMPTY, submitRung, CLICK: KINDS.CLICK });
