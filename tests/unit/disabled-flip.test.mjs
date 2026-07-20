// A CONTROL THAT WAS DISABLED AND IS NOW ENABLED MUST BE ASKED AGAIN — the retirement counterpart to the
// re-readable field state landed in lib/graph/.
//
// `mergeSnapshot` merged `fieldFacts` write-once, so the FIRST sighting of `disabled` became permanent: a
// wizard field disabled until the previous step, a Save disabled until the form is dirty, were written off
// forever. Measured on runs raw3 + hunt1, "Enter your email id" (tpl 1141) and "Group Name" (tpl 1020) each
// latched `disabled:true` and carried EIGHT `click:DISABLED` probe rows. That half is fixed — the state is
// re-read every snapshot and `fieldStateCleared(node)` answers "was it disabled, is it enabled NOW".
//
// This is the half that decides whether the fix does anything. It is TWO RULES, and either one alone keeps
// the control retired:
//   (1) `elementBlockedBy` treats a DISABLED row as an answer ABOUT THE ELEMENT — true of a policy refusal
//       ("re-asking cannot change it") and false of a STATE — and `probeStatus` uses that same call to
//       discharge EVERY owed kind, so the battery empties and nothing is outstanding.
//   (2) even with (1) skipped, the no-progress rule retires on a tail of 3 identical `click:DISABLED`
//       signatures — and the measured graphs already hold eight of them.
// Both must disregard pre-flip DISABLED evidence, and the tests below assert them SEPARATELY, since a fix
// to one reads as green while the control stays retired by the other.
//
// SELF-LIMITING BY DESIGN: the control returns to the frontier, and if it answers DISABLED again the
// current reading is `true` once more, `fieldStateCleared` goes false, and the no-progress rule retires it
// on the NEW tail. Restoration comes through `batteryOwing` refilling `outstanding` — deliberately NOT by
// clearing `explored`/`unreachable` in mergeSnapshot, which would leave the control counted open by
// `frontierStats` while `terminallyAnswered` still refused to emit it (the phantom-stall frontier.mjs warns
// about, where `remaining` never reaches 0).
//
// FAIL-ON-REVERT (both verified, each red on its own arm and green on the other's):
//   (a) ARM 1 — in `probeStatus`, restore `const rows = (probes || []).filter(Boolean)` in place of
//       `liveRows(node, probes)` and drop the `node` from `elementBlockedBy(rows, node)` →
//       "ARM 1: a control that is enabled again must owe its battery" reds (outstanding stays []).
//   (b) ARM 2 — delete the `fieldStateCleared(node) && tail[0].blocked === 'DISABLED'` guard in
//       `answeredTerminally` → "ARM 2: a tail of DISABLED answers is pre-flip evidence" reds (the tail of
//       three still retires, on evidence the element has left).
//   EITHER lever alone also reds "a re-enabled control is emitted by the frontier again" and the
//   denominator assertion — which is what proves the two arms COMPOSE rather than merely coexisting, and
//   why fixing one and declaring victory would have read green while the control stayed retired.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGraph, mergeSnapshot, fieldStateCleared } from '../../lib/graph/graph-store.mjs';
import { nextBatch, frontierInstanceStats } from '../../lib/recon/frontier.mjs';
import { answeredTerminally, probeStatus, levelOf, notOperableFindings } from '../../lib/recon/knowledge.mjs';

// The live shape of "Group Name" (tpl 1020): a required, length-capped field inside a create-group modal,
// disabled until the terms checkbox is ticked. `facts` is THIS snapshot's reading.
const field = (facts) => ({
  templateId: 1020, instanceId: 1020, templateSelector: 'form input.name', role: 'textbox',
  name: 'Group Name', instanceKey: '#1', instanceSelector: 'form input.name:nth-child(1)',
  visible: true, fieldFacts: facts,
});

const FACTS = { kind: 'text', maxLength: 50, required: true };
const push = (g, row) => (g.elements[1020].probes || (g.elements[1020].probes = [])).push({ instanceKey: '#1', ...row });

// A graph in the state raw3/hunt1 ended in: seen disabled, acted, answered DISABLED `n` times.
function seedDisabled(n = 3) {
  const g = makeGraph();
  mergeSnapshot(g, '/dashboard', [field({ ...FACTS, disabled: true })]);
  g.elements[1020].explored = true;
  g.elements[1020].instances[0].explored = true;
  for (let i = 0; i < n; i++) push(g, { kind: 'click', blocked: 'DISABLED' });
  return g;
}

// The user ticks the checkbox; the next snapshot reads the field enabled.
const enable = (g) => mergeSnapshot(g, '/dashboard', [field({ ...FACTS, disabled: false })]);

// ── THE PRECONDITION, ASSERTED FIRST ────────────────────────────────────────────────────────────────

test('the retired state is real before the flip — the guards below are not vacuous', () => {
  const g = seedDisabled(3);
  assert.equal(fieldStateCleared(g.elements[1020]), false, 'still disabled — the precondition is NOT met');
  assert.equal(answeredTerminally(g.elements[1020], g.elements[1020].probes), 'element-blocked', 'ARM 1 retires it');
  assert.deepEqual(probeStatus(g.elements[1020], g.elements[1020].probes).outstanding, [], 'and the battery is discharged');
  assert.deepEqual(nextBatch(g, { size: 5 }).map((t) => t.templateId), [], 'so the frontier stops offering it');
});

// ── ARM 1: THE ELEMENT-SCOPED DISCHARGE ─────────────────────────────────────────────────────────────

test('ARM 1: a control that is enabled again must owe its battery', () => {
  const g = seedDisabled(3);
  enable(g);
  assert.equal(fieldStateCleared(g.elements[1020]), true, 'the flip is visible (non-vacuous)');

  const st = probeStatus(g.elements[1020], g.elements[1020].probes);
  assert.deepEqual(
    st.outstanding.sort(), ['fill-empty', 'fill-overflow', 'fill-valid'],
    'ARM 1: a control that is enabled again must owe its battery — a DISABLED row records a state the element has LEFT, and must stop discharging every kind it owes',
  );
  assert.deepEqual(st.blocked, [], 'and nothing is still parked behind a code the element no longer returns');
  assert.equal(st.terminal, null, 'it is not CHARACTERIZED — it has answered nothing yet');
});

test('ARM 1 is scoped to DISABLED alone — a policy refusal is not a state and never clears', () => {
  // DANGER_FLOOR / OUTWARD_REFUSED / FOREIGN_DESTROY / ACCOUNT_PROTECTED are verdicts over the element's
  // IDENTITY. No snapshot can clear them, and widening the flip to cover them would re-open controls the
  // project deliberately refuses to fire.
  const g = seedDisabled(0);
  push(g, { kind: 'click', blocked: 'DANGER_FLOOR' });
  enable(g);
  assert.equal(fieldStateCleared(g.elements[1020]), true, 'the state DID clear (non-vacuous)');
  assert.equal(
    answeredTerminally(g.elements[1020], g.elements[1020].probes), 'element-blocked',
    'a policy refusal is a fact about identity, not a reading of state — an enabled field we refuse to fire is still refused',
  );
});

// ── ARM 2: THE NO-PROGRESS TAIL ─────────────────────────────────────────────────────────────────────

test('ARM 2: a tail of DISABLED answers is pre-flip evidence, not a no-progress repeat', () => {
  // Asserted with ARM 1 already satisfied, so this can only pass on ARM 2's own guard: the rows are
  // element-scoped-clean (elementBlockedBy returns null) and the ONLY thing left that retires the control
  // is the tail of three identical `click:DISABLED` signatures.
  const g = seedDisabled(8);   // hunt1 and raw3 each hold EIGHT of these
  enable(g);

  assert.equal(
    answeredTerminally(g.elements[1020], g.elements[1020].probes), null,
    'ARM 2: a tail of DISABLED answers is pre-flip evidence — retiring on it writes the control off for a state it has left',
  );
});

test('ARM 2 stays self-limiting — a control that is disabled AGAIN retires on the new tail', () => {
  // The bound that makes the whole thing safe: this can only ever postpone a retirement by one more round
  // of evidence. It cannot loop.
  const g = seedDisabled(8);
  enable(g);
  assert.equal(answeredTerminally(g.elements[1020], g.elements[1020].probes), null, 'reopened after the flip');

  // Re-asked, and the app disables it again: the current reading governs, so every row counts once more.
  mergeSnapshot(g, '/dashboard', [field({ ...FACTS, disabled: true })]);
  assert.equal(fieldStateCleared(g.elements[1020]), false, 'the current reading governs');
  assert.equal(
    answeredTerminally(g.elements[1020], g.elements[1020].probes), 'element-blocked',
    'a control that answers DISABLED again is retired again — the rule postpones a retirement, it never cancels one',
  );
});

// ── BOTH ARMS COMPOSE: THE CONTROL IS ACTUALLY EMITTED AGAIN ────────────────────────────────────────

test('a re-enabled control is emitted by the frontier again', () => {
  // The end-to-end claim, and the one that fails under EITHER arm's revert. Restoration comes through
  // `batteryOwing` refilling `outstanding` — the drain flags are untouched, exactly as designed.
  const g = seedDisabled(3);
  assert.deepEqual(nextBatch(g, { size: 5 }).map((t) => t.templateId), [], 'retired while disabled (non-vacuous)');

  enable(g);

  assert.deepEqual(
    nextBatch(g, { size: 5 }).map((t) => t.templateId), [1020],
    'a re-enabled control is emitted by the frontier again — the crawler learned what unlocks it and must now study it',
  );
  assert.ok(g.elements[1020].instances[0].explored, 'and the drain flags were NOT cleared to achieve it — that is the phantom-stall mode frontier.mjs warns about');
});

test('the denominator does not move across the flip — nothing is added or subtracted, only re-opened', () => {
  const g = seedDisabled(3);
  const before = frontierInstanceStats(g);
  enable(g);
  const after = frontierInstanceStats(g);

  assert.equal(after.walkable, before.walkable, 'the denominator never collapses — and never inflates either');
  assert.equal(before.remaining, 0, 'it was retired');
  assert.equal(after.remaining, 1, 'and is outstanding work again');
});

// ── REPORTING FOLLOWS THE SAME FACT ─────────────────────────────────────────────────────────────────

test('a flipped control is neither L-1 BLOCKED nor a control-not-operable finding', () => {
  const g = seedDisabled(3);
  assert.equal(levelOf(g.elements[1020], g.elements[1020].probes), 'L-1', 'blocked while disabled (non-vacuous)');
  assert.equal(notOperableFindings(g).length, 1, 'and reported as an affordance the app will not honour');

  enable(g);

  assert.equal(
    levelOf(g.elements[1020], g.elements[1020].probes), 'L1',
    'a control we are on our way back to probe is REACHED, not a permanent ceiling — reporting it L-1 presents a fixable gap as unprobeable',
  );
  assert.deepEqual(
    notOperableFindings(g), [],
    'and it is no longer a finding: it was disabled because a precondition was unmet, which is the distinction that MAKES the remaining cases findings',
  );
});

// ── THE CONCURRENT AGENT'S LADDER MUST SURVIVE ──────────────────────────────────────────────────────

test('a form mid-ladder is still emitted — with the flip active and without it', () => {
  // The terminal-answer retirement (repeats 30%→19.2% on raw3, 34%→19.5% on hunt1) rests on all 11 real
  // form ladders surviving. This change may only ever POSTPONE a retirement; it must never cause one, and
  // a rule that filtered DISABLED rows out of the tail could — [answer, DISABLED, answer] would collapse
  // into a repeat that never happened. The tail is therefore checked in place, not rebuilt.
  const g = makeGraph();
  mergeSnapshot(g, '/dashboard', [{ ...field({ ...FACTS, disabled: true }), templateId: 1020 }]);
  g.elements[1020].instances[0].explored = true;

  // A ladder interleaved with a stale DISABLED row: the two real rungs are NOT adjacent, so any rule that
  // dropped the middle row would see one repeated answer and retire the ladder at rung two of three.
  push(g, { kind: 'fill-valid', verdict: 'write' });
  push(g, { kind: 'click', blocked: 'DISABLED' });
  push(g, { kind: 'fill-valid', verdict: 'write' });
  enable(g);

  assert.equal(
    answeredTerminally(g.elements[1020], g.elements[1020].probes), null,
    'a form mid-ladder must still be emitted — it still owes fill-overflow; a rule meant to STOP a retirement must not be able to cause one',
  );
  assert.ok(
    probeStatus(g.elements[1020], g.elements[1020].probes).outstanding.includes('fill-overflow'),
    'the declared boundary is still owed — the ladder fill-valid → fill-overflow is intact',
  );
  assert.deepEqual(nextBatch(g, { size: 5 }).map((t) => t.templateId), [1020], 'and the frontier still hands it out');
});

test('a control with no state history is completely untouched by this change', () => {
  // The blast radius. `fieldStateCleared` is false for every node that never recorded a disabled→enabled
  // transition, so every existing retirement path behaves exactly as it did.
  const g = makeGraph();
  mergeSnapshot(g, '/dashboard', [{ ...field({ kind: 'text' }), templateId: 1020 }]);
  g.elements[1020].instances[0].explored = true;
  push(g, { kind: 'click', blocked: 'DISABLED' });

  assert.equal(fieldStateCleared(g.elements[1020]), false, 'no history, no flip');
  assert.equal(answeredTerminally(g.elements[1020], g.elements[1020].probes), 'element-blocked', 'retired exactly as before');
  assert.deepEqual(nextBatch(g, { size: 5 }).map((t) => t.templateId), [], 'and not emitted');
});
