// THE PROBE BATTERY — the interactions that turn "we touched it" into "we know what it does".
//
// A FIELD ANSWERS NOTHING ON ITS OWN. Typing 51 characters into a field that declares a 50-character limit
// produces no observable at all: no request, no error, nothing. The answer only exists after a COMMIT — the
// form is submitted and the page either refuses, or accepts and reveals that the declared limit was never
// enforced. So a field probe is a transaction (fill → commit → read), not a touch. That is why the previous
// model could never learn what a field accepts: it clicked fields as if they were buttons, and 37 of 53
// such acts were inert by construction.
//
// PROBES ARE DERIVED FROM DECLARATIONS, never blind. A boundary probe runs only where the field DECLARES a
// boundary, because a declaration is a PREDICTION and a prediction can be falsified. "maxLength 50" plus an
// accepted 51-character submit is a defect found; 51 characters into a field that declares nothing is a
// number with no meaning. This is also what keeps the battery affordable — one probe per declared
// constraint rather than a fixed matrix over every element.
//
// CAUSAL DISCIPLINE. Fills run under `__idle__` and open no causal window; only the COMMIT is measured, by
// the caller's `actStep`. This module never calls `beginCause` and never mutates the graph — it returns
// probe rows and lets the caller record them.

import { readOutcome, wasRefused, announcedSuccess } from '../browser/observables.mjs';
import { actuateField } from './field-actuate.mjs';
import { verdictOf } from './knowledge.mjs';

// The value a probe puts in, derived from what the field declares. Each returns null when the probe does
// not apply to this field, so the caller skips rather than inventing an input.
export function valueForProbe(kind, facts = {}) {
  const max = facts.maxLength || null;
  switch (kind) {
    case 'fill-valid':
      // Comfortably inside every declared bound, so a refusal here means something other than length.
      return max ? 'a'.repeat(Math.max(1, Math.min(8, max))) : 'Test value';
    case 'fill-overflow':
      // ONE character past the declared limit. The whole point is the prediction: the page should refuse.
      return max ? 'a'.repeat(max + 1) : null;
    case 'fill-empty':
      return '';
    case 'fill-invalid':
      // Deliberately wrong SHAPE, not wrong length — for a declared pattern/type/range.
      if (facts.pattern || facts.kind === 'email') return 'not-a-valid-value';
      if (facts.min != null || facts.max != null) return '-999999';
      return null;
    default:
      return null;
  }
}

// What the page did in response to ONE probe. `requests` comes from the caller's causal ledger — this
// module never attributes anything itself.
export function readProbeVerdict({ outcome, requests = [], revealed = 0, navigated = false, error = null }) {
  return verdictOf({
    requests, revealed, navigated, error,
    refused: wasRefused(outcome),
    succeeded: announcedSuccess(outcome),
  });
}

// Run ONE field probe as a transaction: set the value, commit, read the answer.
//
// `commit` is injected — it is the caller's measured act (actStep), so the ONE causal window stays where it
// has always been and this module cannot open a second one. It receives no arguments and returns whatever
// actStep returned.
export async function probeField(page, { handle, facts, kind, commit, scope = null }) {
  const row = { kind, at: null, input: null };
  const value = valueForProbe(kind, facts || {});
  if (value === null) return { ...row, blocked: 'NOT_APPLICABLE' };
  if (!handle) return { ...row, blocked: 'NO_INSTANCE' };

  row.input = { value: value.length > 40 ? `${value.slice(0, 12)}…(${value.length} chars)` : value, length: value.length };

  // The fill itself is setup, under __idle__. A field that refuses to accept the value at all (a readonly
  // input, a disabled control) is a fact about the field, recorded rather than thrown.
  const filled = await actuateField(page, handle, { kind: facts?.kind === 'select' ? 'select' : 'fill', value })
    .catch(() => false);
  if (!filled) return { ...row, blocked: 'NOT_FILLABLE' };

  // READ BACK WHAT THE FIELD ACTUALLY TOOK, and judge the conflict on that — never on what we typed.
  // Measured live: "Meeting Title" declares maxLength 50, we typed 51, and the browser truncated to 50
  // natively. Comparing the ATTEMPTED length against the declaration would have reported a boundary
  // violation on a field that enforced its boundary perfectly — a false finding, and the most damaging
  // kind, because a probe that invents defects is worse than no probe.
  const accepted = await handle.evaluate((el) => (el.value != null ? String(el.value).length : null)).catch(() => null);
  if (accepted != null) row.input.accepted = accepted;

  let res = null; let error = null;
  try { res = await commit(); } catch (e) { error = String(e?.message || e).split('\n')[0].slice(0, 120); }

  const outcome = await readOutcome(page, { scope });
  const verdict = readProbeVerdict({
    outcome,
    requests: res?.requests || [],
    revealed: res?.newElements?.length || 0,
    navigated: !!(res?.route && res.navigated),
    error,
  });

  // THE FINDING. A declared boundary that the page did not enforce is a defect, and it is decidable right
  // here: we predicted a refusal and got an acceptance instead.
  // A boundary is violated only when the field actually HELD more than it declared AND the commit went
  // through. Truncation at the declared limit is the constraint working, not a defect.
  const overflowed = accepted != null ? accepted > facts.maxLength : false;
  const conflict = (kind === 'fill-overflow' && overflowed && verdict !== 'rejected' && verdict !== 'error')
    ? { claim: 'maxLength', declared: facts.maxLength, accepted }
    : (kind === 'fill-empty' && facts?.required && verdict !== 'rejected' && verdict !== 'error')
      ? { claim: 'required', declared: true, accepted: 'empty' }
      : null;

  return {
    ...row,
    verdict,
    error,
    refused: wasRefused(outcome),
    evidence: {
      requests: (res?.requests || []).map((q) => `${q.method} ${q.urlPattern || q.url}`),
      validity: outcome.validity, frameworkErrors: outcome.frameworkErrors,
      liveRegions: outcome.liveRegions.map((r) => r.text),
    },
    ...(conflict ? { conflict } : {}),
  };
}

// Run ONE control probe — a click, read the answer. The commit IS the probe here.
export async function probeControl(page, { kind = 'click', commit, scope = null }) {
  let res = null; let error = null;
  try { res = await commit(); } catch (e) { error = String(e?.message || e).split('\n')[0].slice(0, 120); }
  const outcome = await readOutcome(page, { scope });
  return {
    kind,
    verdict: readProbeVerdict({
      outcome,
      requests: res?.requests || [],
      revealed: res?.newElements?.length || 0,
      navigated: !!(res?.route && res.navigated),
      error,
    }),
    error,
    refused: wasRefused(outcome),
    evidence: {
      requests: (res?.requests || []).map((q) => `${q.method} ${q.urlPattern || q.url}`),
      revealed: res?.newElements?.length || 0,
      validity: outcome.validity, frameworkErrors: outcome.frameworkErrors,
      liveRegions: outcome.liveRegions.map((r) => r.text),
    },
  };
}
