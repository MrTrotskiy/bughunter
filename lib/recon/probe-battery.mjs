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
import { isShapedType } from './probe-kinds.mjs';

// The value a probe puts in, derived from what the field declares. Each returns null when the probe does
// not apply to this field, so the caller skips rather than inventing an input.
// VERIFIED, because the documentation says otherwise and it would have cost a redesign. MDN states that
// `minlength`/`maxlength` are checked against USER-PROVIDED input only and are NOT enforced when the value
// is set programmatically — which would mean a boundary probe silently bypasses the very constraint it is
// measuring, and every "limit not enforced" finding would be false. Measured directly instead of trusted:
// typing 15 characters into a `maxlength=10` input yields length 10 through BOTH Playwright `fill()` and
// `pressSequentially()`. `fill()` drives the input through the browser's own input pipeline rather than
// assigning `.value`, so the constraint applies. The boundary verdict therefore stands on real evidence.
export function valueForProbe(kind, facts = {}) {
  const max = facts.maxLength || null;
  switch (kind) {
    case 'fill-valid': {
      // A TYPED input does not accept prose, and the browser says so before the page ever sees it.
      // Measured on run goal2: 5 acts died on `elementHandle.fill: Cannot type text into
      // input[type=number]` — the year field of a date picker, among others. The field was declared
      // (`kind: 'number'`) and we typed "Test value" at it anyway, so the probe recorded ACT_FAILED and
      // the element stayed at L1 owing a fill it could never satisfy. `valueFor` (form-fill.mjs) had
      // handled types for a year; this generator, written later for the declared-facts battery, had not.
      // A value the browser rejects outright teaches nothing about the FIELD — it only measures our own
      // input, which is the same "probe that invents its own answer" failure the boundary verdict avoids.
      const t = String(facts.kind || facts.type || 'text').toLowerCase();
      const numeric = () => {
        // Prefer a declared bound so the value is valid BY THE FIELD'S OWN DECLARATION.
        const lo = Number(facts.min); const hi = Number(facts.max);
        if (Number.isFinite(lo)) return String(lo);
        if (Number.isFinite(hi)) return String(Math.min(1, hi));
        return '1';
      };
      if (t === 'number' || t === 'range') return numeric();
      if (t === 'date') return '2026-01-15';
      if (t === 'time') return '12:00';
      if (t === 'datetime-local') return '2026-01-15T12:00';
      if (t === 'month') return '2026-01';
      if (t === 'week') return '2026-W03';
      if (t === 'email') return 'qa.bughunter@example.com';
      if (t === 'tel') return '5551234567';
      if (t === 'url') return 'https://example.com';
      if (t === 'color') return '#336699';
      // Comfortably inside every declared bound, so a refusal here means something other than length.
      return max ? 'a'.repeat(Math.max(1, Math.min(8, max))) : 'Test value';
    }
    case 'fill-overflow':
      // ONE character past the declared limit. The whole point is the prediction: the page should refuse.
      return max ? 'a'.repeat(max + 1) : null;
    case 'fill-empty':
      return '';
    case 'fill-invalid': {
      // THE WRONG SHAPE for the field's DECLARED type/pattern/range (docs/GOAL.md rung 4). Genuinely invalid
      // BY THE DECLARATION — never a fixed innocuous string (a prior review caught `valueForProbe` returning
      // 'Test value' at a `pattern` field, a value the client accepts, so the probe measured only our own
      // input). The value is constructed to VIOLATE the specific declaration; the outcome + read-back then
      // settle whether the field actually enforced it.
      const t = String(facts.kind || facts.type || '').toLowerCase();
      // Letters into a number. A NATIVE input[type=number] refuses the fill outright → NOT_FILLABLE, and
      // that refusal IS the answer (the type is enforced) — recorded, never retried away. A text input
      // rendered as a number (e.g. AntD InputNumber) HOLDS them, and whether the app then accepts is the
      // finding.
      if (t === 'number' || t === 'range') return 'not-a-number';
      // Prose where a temporal shape is declared.
      if (t === 'date' || t === 'datetime-local' || t === 'month' || t === 'week' || t === 'time') return 'not-a-date';
      if (t === 'email') return 'not-an-email';          // no `@` → typeMismatch
      if (t === 'url') return 'not a url';               // a space and no scheme
      if (t === 'color') return 'not-a-color';           // not a #rrggbb
      // A declared regex `pattern` on a free-text field: a value mixing letters, a digit, a space and a
      // symbol, chosen to violate the common cases. The browser's `patternMismatch` and the read-back decide
      // whether it actually violated — a value that happened to MATCH is inconclusive, not a false finding.
      if (facts.pattern) return 'a b!2@';
      // A numeric RANGE declared without a typed input still means "a number" — put letters at it.
      if (facts.min != null || facts.max != null) return 'not-a-number';
      return null;
    }
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

  // THE FINDING. A declared contract that the page did not enforce is a defect, and it is decidable right
  // here: we predicted a refusal and got an acceptance instead.
  // A boundary is violated only when the field actually HELD more than it declared AND the commit went
  // through. Truncation at the declared limit is the constraint working, not a defect.
  const overflowed = accepted != null ? accepted > facts.maxLength : false;
  // A WRONG-SHAPE value the field HELD (the fill did not fail — we are past the NOT_FILLABLE return, so the
  // input took the value) and the commit was not refused: the declared type/pattern was not enforced.
  // "declares type=number, accepted letters" is a finding, never a silent pass (docs/GOAL.md). A NATIVE
  // typed input that refuses the fill never reaches here — it returned NOT_FILLABLE above, which is the
  // type being ENFORCED, not a defect.
  const shapeHeld = accepted == null || accepted > 0;
  const conflict = (kind === 'fill-overflow' && overflowed && verdict !== 'rejected' && verdict !== 'error')
    ? { claim: 'maxLength', declared: facts.maxLength, accepted }
    : (kind === 'fill-empty' && facts?.required && verdict !== 'rejected' && verdict !== 'error')
      ? { claim: 'required', declared: true, accepted: 'empty' }
      : (kind === 'fill-invalid' && shapeHeld && verdict !== 'rejected' && verdict !== 'error')
        ? { claim: facts.pattern ? 'pattern' : 'type', declared: facts.pattern || facts.kind || facts.type || null, accepted: value }
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
