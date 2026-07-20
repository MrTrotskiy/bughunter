// THE KNOWLEDGE LADDER — coverage that cannot be earned by clicking.
//
// `explored` was set immediately after one act returned, before the outcome was inspected, and the
// frontier's drain predicate read that flag. So "explored" meant "clicked once, did not throw", and
// coverage counted those. One measured run: 279 acts, 27% caused any request, 43% wholly inert, 21 of 32
// submit-like controls clicked with zero fields filled, 0 of 6 user flows completed — while the coverage
// percentage climbed. The number was measuring effort and being read as understanding.
//
// Phase 1's actual job is to turn a black box into a white one: for every control what it is and does, for
// every field what it accepts and refuses. That is a claim about knowledge, so the metric has to be one.
//
// Guards: a rung above L1 requires recorded probe evidence; a click alone can never reach L3; `rejected`
//   exists as a verdict distinct from `inert`; BLOCKED stays counted and listed instead of silently
//   leaving the denominator; the three headline numbers are not blended.
// FAIL-ON-REVERT (one lever per direction):
//   (a) make `levelOf` return L3 whenever `node.explored` is set → "a click alone is not understanding"
//       fails — this is precisely the old behaviour, so the test is the guard against reverting to it.
//   (b) make `verdictOf` return 'inert' when no requests fired regardless of refusal → "a refused act is
//       not inert" fails, restoring the inference that was wrong for six runs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { batteryFor, verdictOf, probeStatus, levelOf, knowledgeStats } from '../../lib/recon/knowledge.mjs';
import { valueForProbe } from '../../lib/recon/probe-battery.mjs';
import { nextBatch } from '../../lib/recon/frontier.mjs';

test('a click alone is not understanding', () => {
  const node = { role: 'button', name: 'Create', explored: true };
  assert.equal(levelOf(node, []), 'L1',
    'a control that was clicked once and recorded nothing sits at REACHED, not understood');

  // One recorded probe earns EXERCISED. Still not understanding — the battery is not complete.
  const one = [{ kind: 'click', verdict: 'read' }];
  assert.equal(levelOf(node, one), 'L3',
    'a button owes only a click, so one recorded outcome completes its battery');

  // THE EVIDENCE GATE. `inert` means the page did nothing observable — no request, no reveal, no
  // navigation, and it said nothing. Calling that CHARACTERIZED re-imports "clicked once and did not
  // throw" one rung higher, and it is indistinguishable from an act recorded against a control that was
  // never actually clicked. Measured: 52 of 118 elements at L3+ had only inert rows — 22 points of the
  // headline. A row with no verdict, or one recording that the act threw, is not a completed probe either.
  assert.equal(levelOf(node, [{ kind: 'click', verdict: 'inert' }]), 'L2',
    'a click that produced nothing observable is EXERCISED, never CHARACTERIZED');
  assert.equal(levelOf(node, [{ kind: 'click' }]), 'L2', 'a row with no verdict completes nothing');
  assert.equal(levelOf(node, [{ kind: 'click', verdict: 'error' }]), 'L2', 'an act that threw completes nothing');
  assert.equal(levelOf(node, [{ kind: 'click', verdict: 'inert' }, { kind: 'click', verdict: 'inert' }]), 'L2',
    'and two inert rows are not a reproduced outcome — they are two absences');

  // A field owes more, and one probe is nowhere near enough.
  const field = { role: 'textbox', name: 'Title', fieldFacts: { maxLength: 50, required: true } };
  assert.deepEqual(batteryFor(field), ['fill-valid', 'fill-overflow', 'fill-empty'],
    'a field owes a probe per DECLARED constraint — a blind battery would have nothing to check against');
  assert.equal(levelOf(field, [{ kind: 'fill-valid', verdict: 'write' }]), 'L2',
    'one of three owed probes is EXERCISED, not CHARACTERIZED');
  const full = [
    { kind: 'fill-valid', verdict: 'write' },
    { kind: 'fill-overflow', verdict: 'rejected' },
    { kind: 'fill-empty', verdict: 'rejected' },
  ];
  assert.equal(levelOf(field, full), 'L3', 'the complete battery earns CHARACTERIZED');
});

test('a refused act is not inert — the distinction that did not exist', () => {
  assert.equal(verdictOf({ requests: [], refused: true }), 'rejected',
    'the page said no: a working control we failed to satisfy');
  assert.equal(verdictOf({ requests: [], refused: false }), 'inert',
    'the page said nothing: dead weight in the denominator');
  assert.equal(verdictOf({ requests: [{ class: 'write' }] }), 'write');
  assert.equal(verdictOf({ requests: [{ class: 'read' }] }), 'read');
  assert.equal(verdictOf({ requests: [], revealed: 3 }), 'reveal');
  // WRITE BEATS NAVIGATE, and the old precedence was backwards. A successful submit normally redirects, so
  // post-redirect-get is the ordinary shape of the very thing this tool exists to find — ranking navigation
  // first discarded the mutation from the verdict. Measured on the live graph: 2 of 4 navigate rows carried
  // a write, and a wider audit put it at 10 of 20.
  assert.equal(verdictOf({ requests: [{ class: 'write' }], navigated: true }), 'write+navigate',
    'a submit that redirects is a WRITE that also navigated, not a navigation');
  assert.equal(verdictOf({ requests: [{ class: 'read' }], navigated: true }), 'navigate',
    'navigation still wins when nothing was written');
  assert.equal(verdictOf({ error: 'timeout' }), 'error');
  // The success channel stands alone: on the live target a form answered on no validation tier at all and
  // announced itself only through a toast.
  assert.equal(verdictOf({ requests: [], succeeded: true }), 'write',
    'an announced success is a write even when the request ledger is empty');
});

test('blocked stays in the denominator, named', () => {
  const node = { role: 'button', name: 'Video Call' };
  const probes = [{ kind: 'click', blocked: 'POLICY_OUTWARD' }];
  assert.equal(levelOf(node, probes), 'L-1', 'a control we may not probe is BLOCKED, not understood');

  const st = probeStatus(node, probes);
  assert.deepEqual(st.blocked, [{ kind: 'click', code: 'POLICY_OUTWARD' }], 'the reason is kept, not discarded');
  assert.equal(st.terminal, 'EXHAUSTED', 'nothing left to try, and nothing was learned');

  const graph = {
    elements: {
      1: { role: 'button', name: 'Video Call', probes },
      2: { role: 'button', name: 'Refresh', probes: [{ kind: 'click', verdict: 'read' }] },
      3: { role: 'button', name: 'Chrome', widgetInternal: true, probes: [] },
    },
  };
  const stats = knowledgeStats(graph);
  assert.equal(stats.obligations, 2, 'widget chrome is not an obligation (INC.6f), the other two are');
  assert.equal(stats.understood, 1, 'only the one with a complete battery counts');
  assert.equal(stats.knowledgePct, 50);
  assert.deepEqual(stats.blocked, [{ templateId: 1, name: 'Video Call', code: 'POLICY_OUTWARD' }],
    'the blocked control is LISTED by name and reason — never a silent subtraction');
});

test('a partially blocked element still owes what remains', () => {
  const field = { role: 'textbox', name: 'Title', fieldFacts: { maxLength: 50, required: true } };
  // NOT_FILLABLE is a TERMINAL fact about the field — a readonly input really cannot take a value, so the
  // obligation is legitimately discharged and stays named in `blocked`.
  const probes = [
    { kind: 'fill-valid', verdict: 'write' },
    { kind: 'fill-overflow', blocked: 'NOT_FILLABLE' },
  ];
  assert.equal(levelOf(field, probes), 'L2',
    'one probe blocked does not write the element off — fill-empty is still owed');
  const st = probeStatus(field, probes);
  assert.deepEqual(st.outstanding, ['fill-empty']);
  assert.equal(st.terminal, null, 'not terminal while anything is still attemptable');
});

// FAIL-ON-REVERT: delete TRANSIENT_BLOCKS from probeStatus and this goes red — the element reads
// CHARACTERIZED/L3 on ONE answered probe out of three.
//
// THE FAILURE IT GUARDS. A field owes three probes. The first commit closes the modal it lived in, so
// probes two and three come back NO_INSTANCE — we never got to ask. With one undifferentiated blocked
// bucket, `outstanding` empties, `terminal` reads CHARACTERIZED, and the element scores L3 UNDERSTOOD
// having answered a third of its battery. That inverts the honest-denominator invariant at its most
// dangerous point: a failure to measure counted as a measurement, and it inflates the headline silently
// because nothing in the output distinguishes it from a field that genuinely answered.
test('a failure to ASK is not an answer — transient blocks keep the obligation standing', () => {
  const field = { role: 'textbox', name: 'Title', fieldFacts: { maxLength: 50, required: true } };
  const probes = [
    { kind: 'fill-valid', verdict: 'write' },
    { kind: 'fill-overflow', blocked: 'NO_INSTANCE' },  // the modal closed under us
    { kind: 'fill-empty', blocked: 'ACT_FAILED' },      // the click threw
  ];
  const st = probeStatus(field, probes);
  assert.deepEqual(st.outstanding, ['fill-overflow', 'fill-empty'],
    'neither was answered, so both are still owed');
  assert.equal(st.terminal, null, 'nothing is terminal — we simply have not asked yet');
  assert.equal(levelOf(field, probes), 'L2',
    'one of three answered is EXERCISED; calling it CHARACTERIZED would be a fabricated number');

  // And the other direction: a TERMINAL code really does discharge, or every readonly field would be
  // permanently incomplete and the denominator could never close.
  const readonly = [
    { kind: 'fill-valid', verdict: 'write' },
    { kind: 'fill-overflow', blocked: 'NOT_FILLABLE' },
    { kind: 'fill-empty', blocked: 'NOT_APPLICABLE' },
  ];
  assert.equal(probeStatus(field, readonly).terminal, 'CHARACTERIZED',
    'the field answered what it could and declared the rest impossible');
});

test('CONFIRMED needs the outcome seen twice, or a write read back', () => {
  const node = { role: 'button', name: 'Post' };
  assert.equal(levelOf(node, [{ kind: 'click', verdict: 'write' }]), 'L3',
    'a single observation of a control is characterisation, not confirmation');
  assert.equal(levelOf(node, [{ kind: 'click', verdict: 'write' }, { kind: 'click', verdict: 'write' }]), 'L4',
    'reproduced twice the same way');
  assert.equal(levelOf(node, [{ kind: 'click', verdict: 'write', confirmedByReadBack: true }]), 'L4',
    'or verified by reading the created thing back');
});

// A collision leaves the obligation standing — it is a failure to ASK, not an answer. Pure, so it
// lives here rather than in the live alias test (layer rule).
// FAIL-ON-REVERT: remove 'ALIAS_COLLISION' from TRANSIENT_BLOCKS -> the battery discharges and this reds.
test('a collision leaves the obligation standing — it is a failure to ASK, not an answer', () => {
  // (4) A field whose act aliased onto another instance's node learned NOTHING about itself. Discharging
  // its battery here would credit one control's behaviour to another — the same confusion the gate exists
  // to prevent, laundered through the ladder.
  const field = { role: 'textbox', name: 'Search', fieldFacts: { maxLength: 75 } };
  const probes = [{ kind: 'fill-valid', blocked: 'ALIAS_COLLISION' }];
  const st = probeStatus(field, probes);
  assert.deepEqual(st.outstanding, ['fill-valid', 'fill-overflow'],
    'nothing was answered, so everything is still owed');
  assert.equal(st.terminal, null, 'not terminal — we never got to ask');
});

// A TYPED INPUT DOES NOT ACCEPT PROSE — the probe that could never be satisfied.
//
// MEASURED on run goal2: five acts failed with `elementHandle.fill: Cannot type text into
// input[type=number]`. The field DECLARED itself numeric (`kind: 'number'` in fieldFacts, read straight
// off the DOM), the battery asked for a 'fill-valid' value, and the generator returned "Test value" —
// which the browser refuses before the page ever sees it. The probe recorded ACT_FAILED, the obligation
// stayed outstanding, and the element sat at L1 owing a fill it could never satisfy however many times
// the loop returned to it. `valueFor` (form-fill.mjs) had handled input types for a year; this generator,
// written later for the declared-facts battery, had not — the same rule in two places, disagreeing.
//
// Guards: a declared field type produces a value of THAT type, and a declared bound is honoured, so a
//   valid-fill probe measures the FIELD rather than our own bad input.
// FAIL-ON-REVERT: drop the type switch from `valueForProbe('fill-valid')` (always the text default) →
//   "a numeric field gets a number" reds with got 'Test value'.
test('a valid-fill probe respects the type the field declares', () => {
  assert.equal(valueForProbe('fill-valid', { kind: 'number' }), '1', 'a numeric field gets a number');
  assert.equal(valueForProbe('fill-valid', { kind: 'number', min: '1900' }), '1900',
    'and a declared minimum is used, so the value is valid by the field\'s OWN declaration');
  assert.equal(valueForProbe('fill-valid', { kind: 'date' }), '2026-01-15');
  assert.equal(valueForProbe('fill-valid', { kind: 'time' }), '12:00');
  assert.match(valueForProbe('fill-valid', { kind: 'email' }), /@/);

  // The untyped default is unchanged — this widen must not disturb the ordinary text field, which is
  // still the common case, nor the declared-maxLength behaviour the boundary probes depend on.
  assert.equal(valueForProbe('fill-valid', { kind: 'text' }), 'Test value');
  assert.equal(valueForProbe('fill-valid', { kind: 'text', maxLength: 5 }), 'aaaaa');
  assert.equal(valueForProbe('fill-valid', {}), 'Test value');
});

// A FIELD THAT DECLARES A SHAPE OWES A WRONG-SHAPE PROBE, and that obligation must DRAIN — the whole
// three-end wiring (minted → valued → satisfied/blocked), or it is the "green but the obligation never
// drains" failure this project has hit repeatedly.
//
// docs/GOAL.md rung 4: "the wrong shape for its declared type/pattern/range — letters into a number, text
// into a date". Before this, `fill-invalid` was minted ONLY for a declared pattern/min/max, so a plain
// `type=email` / `type=number` field — a shape declared by the TYPE alone — was never asked what it
// refuses, only what it accepts. "It accepts a value" is nearly free; "declared number, refused letters"
// is the knowledge.
//
// Guards: a typed-shape field (number/date/email) OWES `fill-invalid`; a plain text field does NOT (no
//   shape to falsify); the value is genuinely WRONG for the declaration (non-numeric at a number, no `@`
//   at an email); and the obligation DRAINS whether the field refused the fill (NOT_FILLABLE, the type
//   enforced) or accepted+committed it (a recorded row) — never sits owed forever.
// FAIL-ON-REVERT: narrow `batteryFor` back to `pattern||min||max` (drop `isShapedType`) → "a type=number
//   field owes a wrong-shape probe" reds; make `valueForProbe('fill-invalid')` return a numeric/valid value
//   for a number → "the wrong-shape value is genuinely non-numeric" reds.
test('a field that declares a SHAPE owes a wrong-shape probe, and it drains', () => {
  // MINTED — a declared TYPE is a shape, even with no pattern/min/max.
  assert.ok(batteryFor({ role: 'textbox', fieldFacts: { kind: 'number' } }).includes('fill-invalid'),
    'a type=number field owes a wrong-shape probe — a shape declared by the type alone was never probed before');
  assert.ok(batteryFor({ role: 'textbox', fieldFacts: { kind: 'email' } }).includes('fill-invalid'),
    'a type=email field owes a wrong-shape probe');
  assert.ok(batteryFor({ role: 'textbox', fieldFacts: { pattern: '[0-9]+' } }).includes('fill-invalid'),
    'a declared pattern still owes it (the pre-existing case, unbroken)');
  // NOT MINTED — a plain text field declares no shape, so there is nothing to falsify.
  assert.ok(!batteryFor({ role: 'textbox', fieldFacts: { kind: 'text', maxLength: 50 } }).includes('fill-invalid'),
    'a plain text field owes NO wrong-shape probe — a blind invalid value would measure our own input');

  // VALUED — genuinely wrong for the declaration, never a fixed innocuous string.
  assert.ok(Number.isNaN(Number(valueForProbe('fill-invalid', { kind: 'number' }))),
    'the wrong-shape value is genuinely non-numeric — letters into a number, not a value the field accepts');
  assert.ok(!valueForProbe('fill-invalid', { kind: 'email' }).includes('@'),
    'no `@`, so a type=email flags a typeMismatch');
  assert.equal(valueForProbe('fill-invalid', { kind: 'text' }), null,
    'a field with no declared shape gets no wrong-shape value');

  // DRAINS — via a NOT_FILLABLE the type ENFORCED (native number refused the fill)…
  const numField = { role: 'textbox', fieldFacts: { kind: 'number' } };
  const enforced = probeStatus(numField, [
    { kind: 'fill-valid', verdict: 'write' },
    { kind: 'fill-invalid', blocked: 'NOT_FILLABLE' },   // browser refused letters — the answer, recorded
  ]);
  assert.deepEqual(enforced.outstanding, [],
    'the wrong-shape obligation DRAINS on a NOT_FILLABLE — the type was enforced, and that is a terminal answer, never a retry');
  // …or via an ANSWERED row (the app rejected the wrong shape).
  const rejected = probeStatus(numField, [
    { kind: 'fill-valid', verdict: 'write' },
    { kind: 'fill-invalid', verdict: 'rejected' },
  ]);
  assert.deepEqual(rejected.outstanding, [], 'and it drains on a recorded rejection too');
});

// THE SCRIPT DRIVES THE STUDY — an element with an outstanding obligation does not leave the frontier.
//
// THE MEASURED FAILURE. `batteryFor` says what a control owes: a valid value, plus a boundary probe where
// the field DECLARES a limit, an empty commit where it declares itself required, a wrong-shape value where
// it declares a pattern. It was built, revert-proven, and CALLED BY NOTHING. Every act filled one valid
// value and moved on, and `explored` — set the moment that one act returned — drained the element. So a
// field was reported as studied on a single happy-path input: we learned it accepts something and never
// what it refuses. Touching a control is not understanding it, and Phase 1 exists to turn a black box into
// a white one WITHOUT the source.
//
// Guards: a field with unmet obligations stays walkable; discharging them all releases it; the grind is
//   BOUNDED so a control that cannot answer does not loop forever.
// FAIL-ON-REVERT: drop `batteryOwing` from `instanceDrained` → "a partly-probed field is still owed" reds,
//   which is exactly the one-touch-is-coverage reading this replaces.
test('a field is not done until its battery is', () => {
  const field = (probes) => ({
    elements: { 1: {
      role: 'textbox', name: 'Title', route: '/f',
      fieldFacts: { kind: 'text', maxLength: 50, required: true },   // owes: valid, overflow, empty
      instances: [{ instanceKey: '#0', instanceSelector: '#t', explored: true }],
      probes,
    } },
  });

  // One valid fill, marked explored — the old rule called this covered.
  const partly = field([{ kind: 'fill-valid', verdict: 'read', instanceKey: '#0' }]);
  assert.equal(nextBatch(partly, { size: 5 }).length, 1,
    'a partly-probed field is still owed — one accepted value says nothing about what it refuses');
  assert.deepEqual(probeStatus(partly.elements[1], partly.elements[1].probes).outstanding,
    ['fill-overflow', 'fill-empty'], 'and the script knows exactly which probes are missing');

  // All three discharged → released.
  const done = field([
    { kind: 'fill-valid', verdict: 'read', instanceKey: '#0' },
    { kind: 'fill-overflow', verdict: 'rejected', instanceKey: '#0' },
    { kind: 'fill-empty', verdict: 'rejected', instanceKey: '#0' },
  ]);
  assert.equal(nextBatch(done, { size: 5 }).length, 0, 'battery discharged — now it is genuinely studied');

  // BOUNDED: a field that keeps failing must not be handed out forever.
  const stuck = field(Array.from({ length: 8 }, () => ({ kind: 'fill-valid', blocked: 'ACT_FAILED', instanceKey: '#0' })));
  assert.equal(nextBatch(stuck, { size: 5 }).length, 0, 'the grind is capped — an unanswerable control is owed, not looped');
});
