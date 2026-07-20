// PROBE KINDS — the ONE vocabulary, because three modules were inventing their own and disagreeing.
//
// THE FAILURE THIS EXISTS TO PREVENT, measured. `batteryFor` owed a field `fill-valid`. The writer in
// `stateful-step` emitted `click` or `fill-submit`. `probeField` emitted a third set. Nothing translated
// between them, so 49 elements sat at L2 — and not one of them was waiting on an act it never received.
// Every single one had been acted and recorded; the row simply did not answer the obligation by name.
//
// The inversion that gave it away: a submit button where 12 of 12 fields were actuated and 8 elements
// appeared scored L2, while an unnamed logo link that got one empty click scored L3. The better probe
// scored lower, because the good one recorded `fill-submit` against an obligation spelled `click`.
//
// A dangling string is invisible until something measures it, which is why this is a module and not a
// convention: everything that mints or reads a probe kind imports from here.

// What an interaction WAS. Closed set — a kind outside it is a bug, not an extension point.
export const KINDS = Object.freeze({
  CLICK: 'click',              // the plain act on a control
  FILL_SUBMIT: 'fill-submit',  // fields actuated, then the commit clicked — one transaction
  FILL_VALID: 'fill-valid',    // a value inside every declared bound
  FILL_OVERFLOW: 'fill-overflow',
  FILL_EMPTY: 'fill-empty',
  // THE WRONG-SHAPE probe (docs/GOAL.md rung 4): a value that violates the field's DECLARED type / pattern /
  // range — letters into a number, prose into a date/email, a value the pattern rejects. Minted by
  // `knowledge.batteryFor` wherever a shape is declared, valued by `probe-battery.valueForProbe`.
  FILL_INVALID: 'fill-invalid',
  // FORM LADDER (form-battery.mjs). A form is studied incrementally — empty first, then one required
  // field at a time — and each rung is its OWN obligation, or the ladder can never empty. `submit-req-N`
  // is generated per rung, so it is matched by shape below rather than enumerated here.
  SUBMIT_EMPTY: 'submit-empty',
});

// A form rung: `submit-req-1`, `submit-req-2`, …
export const isFormRung = (k) => /^submit-req-\d+$/.test(String(k || ''));

// The declared INPUT TYPES that constrain a value's SHAPE — the set a `fill-invalid` probe can falsify by
// putting the wrong shape in (letters into `number`, prose into `date`/`email`/…). A plain
// `text`/`search`/`tel`/`password` field declares no shape, so there is nothing to violate and no probe is
// minted. Shared between `knowledge.batteryFor` (which MINTS the probe) and `probe-battery.valueForProbe`
// (which VALUES it) so the two can never disagree about what counts as a shape — the exact vocabulary drift
// this module exists to prevent.
export const SHAPED_TYPES = Object.freeze(new Set([
  'number', 'range', 'date', 'datetime-local', 'month', 'week', 'time', 'email', 'url', 'color',
]));
export const isShapedType = (t) => SHAPED_TYPES.has(String(t || '').toLowerCase());

// Which recorded kinds SATISFY an owed kind. A control owes `click`; a `fill-submit` is a click that also
// filled the form first, so it satisfies the obligation and then some — refusing it is what made the better
// probe score lower. A field owes `fill-valid`; a `fill-submit` is exactly that transaction performed for
// real, so it counts. The relation is deliberately one-way: a bare click never satisfies a field's
// obligation, because clicking a textbox teaches nothing about what it accepts.
const SATISFIES = Object.freeze({
  [KINDS.CLICK]: [KINDS.CLICK, KINDS.FILL_SUBMIT],
  [KINDS.FILL_VALID]: [KINDS.FILL_VALID, KINDS.FILL_SUBMIT],
  [KINDS.FILL_OVERFLOW]: [KINDS.FILL_OVERFLOW],
  [KINDS.FILL_EMPTY]: [KINDS.FILL_EMPTY],
  [KINDS.FILL_INVALID]: [KINDS.FILL_INVALID],
  // A rung is satisfied only by ITSELF. A plain `click` must never discharge `submit-empty`: the whole
  // point of the empty rung is that the form was submitted with nothing in it, and an ordinary click on
  // the button after a previous act filled the fields is a different event entirely.
  [KINDS.SUBMIT_EMPTY]: [KINDS.SUBMIT_EMPTY],
});

export function satisfies(owedKind, recordedKind) {
  const accepted = SATISFIES[owedKind];
  return accepted ? accepted.includes(recordedKind) : owedKind === recordedKind;
}

// `fieldFacts.kind` (what dom-snapshot observed) → `actuateField` kind (how to drive it). These two
// vocabularies also drifted: the harvester emits `picker`/`file`/`radio`/`checkbox`/`range`, the actuator
// speaks `date`/`upload`/`check`/`select`/`native-select`/`fill`. Seven of the stuck fields would have come
// back NOT_FILLABLE on wiring day purely because of the gap.
const ACTUATION = Object.freeze({
  select: 'select', 'native-select': 'native-select',
  picker: 'date', date: 'date',
  file: 'upload', upload: 'upload',
  radio: 'check', checkbox: 'check', check: 'check',
});

export function actuationKindFor(factsKind) {
  return ACTUATION[factsKind] || 'fill';
}
