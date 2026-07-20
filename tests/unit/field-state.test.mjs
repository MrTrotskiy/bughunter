// STATE IS NOT A DECLARATION — the `fieldFacts` merge recorded a transient UI state as a permanent fact.
//
// `mergeSnapshot` merges fieldFacts write-once: an existing non-null fact is never overwritten. Correct
// for `maxLength` / `pattern` / `required` / `type`, which are properties of the field. Wrong for
// `disabled`, which is a live IDL property the application flips as the user works — a wizard field
// disabled until the previous step completes, a Save disabled until the form is dirty. Write-once meant
// the crawler recorded `disabled:true` the first time it saw the control and never revised it, so the
// control was written off permanently on one early observation.
//
// Measured, runs state/runs/raw3 + state/runs/hunt1: "Enter your email id" (tpl 1141) and "Group Name"
// (tpl 1020, a field inside a create-group modal) each carry `fieldFacts.disabled:true` and eight
// `click:DISABLED` probe rows in the final graph of both runs. 8 DISABLED outcomes is the second-largest
// outcome class of raw3. Two costs: the control is unstudiable forever, and docs/GOAL.md's finding — a
// control disabled where a working one is expected — is conflated with "disabled because the wizard has
// not reached this step", which is the distinction that makes it a finding at all.
//
// The dom-snapshot half is load-bearing and easy to miss: `disabled: el.disabled || null` collapsed
// `false` to `null`, and the merge skips null, so "enabled" was UNREPRESENTABLE. Guarded live
// (tests/live/field-state.test.mjs) since it runs in the page.
//
// Guards:
//   - a state key (`disabled`, `readOnly`) is RE-READ on every snapshot: observed true then false ends
//     false, and the transition is recoverable from node.fieldStateHistory;
//   - the history SEEDS from a carried graph, so a node written before the history existed does not read
//     its first post-upgrade observation as the first observation ever;
//   - a DECLARATION is still write-once: `maxLength` survives a later snapshot that LACKS it AND a later
//     snapshot that declares a DIFFERENT value; `required` survives a later reading of false (the AntD
//     wrapper-race the write-once rule exists for);
//   - `fieldStateCleared` is the disabled→enabled predicate the retirement counterpart reads;
//   - ZERO identity churn across a snapshot where `disabled` flips (identity-diff) — the assertion that
//     matters most, since transient DOM readings leaking into identity is the 148-phantom-template
//     failure mode (INC.4) and would be worse than the bug being fixed.
//
// FAIL-ON-REVERT (one lever per guard, each verified):
//   - drop the `FIELD_STATE_KEYS.has(k)` branch in mergeSnapshot (back to pure write-once) → "a state key
//     must be RE-READ" reds with true;
//   - drop the `prevValue` seed in recordFieldState → "a carried graph's reading seeds the history" reds;
//   - add 'maxLength' to FIELD_STATE_KEYS → "a declaration is NOT overwritten by a later reading" reds;
//   - add 'required' to FIELD_STATE_KEYS → "required survives a later reading of false" reds;
//   - fold fieldFacts into an identity key (idify keying on it, or mergeSnapshot minting a new id when
//     `disabled` differs) → the two ledgers diverge → "no identity churn across the flip" reds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  makeGraph, mergeSnapshot, fieldStateCleared, FIELD_STATE_KEYS, FIELD_STATE_HISTORY_CAP,
} from '../../lib/graph/graph-store.mjs';
import { makeLedger } from '../../lib/graph/ids.mjs';
import { idify } from '../../lib/recon/step.mjs';
import { diffIdentity } from '../../lib/graph/identity-diff.mjs';

// One field template, one instance. `facts` is the reading of this snapshot.
const field = (facts) => ({
  templateId: 1, instanceId: 10, templateSelector: 'form input.name', role: 'textbox', name: 'Group Name',
  instanceKey: '#1', instanceSelector: 'form input.name:nth-child(1)', fieldFacts: facts,
});

test('a state key must be RE-READ on every snapshot: disabled true then false ends false', () => {
  const g = makeGraph();
  // First sighting: the field is disabled (the modal has not been completed yet).
  mergeSnapshot(g, '/dashboard', [field({ kind: 'text', maxLength: 50, disabled: true })]);
  assert.equal(g.elements[1].fieldFacts.disabled, true, 'the first reading is recorded');

  // The app enables it. Under write-once this stayed `true` forever — the defect.
  mergeSnapshot(g, '/dashboard', [field({ kind: 'text', maxLength: 50, disabled: false })]);
  assert.equal(g.elements[1].fieldFacts.disabled, false, 'a state key must be RE-READ, not latched');

  // The transition is RECOVERABLE, not silently overwritten: the crawler learned a precondition and the
  // record of it is what makes "disabled because the wizard has not got there" separable from a finding.
  const hist = g.elements[1].fieldStateHistory.disabled;
  assert.deepEqual(hist.values, [true, false], 'both readings survive, in order');
  assert.equal(hist.flips, 1, 'the transition is counted');
  assert.equal(hist.truncated, false, 'a two-reading history is complete');
});

test('readOnly is classified as STATE too — it is a live IDL property, not a declaration', () => {
  assert.ok(FIELD_STATE_KEYS.has('disabled') && FIELD_STATE_KEYS.has('readOnly'), 'both are state keys');
  assert.ok(!FIELD_STATE_KEYS.has('required') && !FIELD_STATE_KEYS.has('maxLength'), 'declarations are not');

  const g = makeGraph();
  mergeSnapshot(g, '/p', [field({ kind: 'text', readOnly: true })]);
  // An "Edit" toggle unlocks the field. A permanently-readonly AntD widget simply re-reads true forever.
  mergeSnapshot(g, '/p', [field({ kind: 'text', readOnly: false })]);
  assert.equal(g.elements[1].fieldFacts.readOnly, false, 'readOnly is re-read, so an unlocked field is not written off');
  assert.deepEqual(g.elements[1].fieldStateHistory.readOnly.values, [true, false], 'its transition is recorded too');
});

test("a carried graph's reading seeds the history, so the transition is not lost at the upgrade", () => {
  // A node written BEFORE fieldStateHistory existed: it holds the latched fact and no history.
  const g = makeGraph();
  mergeSnapshot(g, '/p', [field({ kind: 'text' })]);
  g.elements[1].fieldFacts.disabled = true;
  assert.equal(g.elements[1].fieldStateHistory, undefined, 'the carried node has no history (non-vacuous)');

  // The first post-upgrade snapshot sees it enabled. Without the seed this reads as the FIRST reading
  // ever ([false]) and the transition — the whole point — vanishes.
  mergeSnapshot(g, '/p', [field({ kind: 'text', disabled: false })]);
  assert.deepEqual(g.elements[1].fieldStateHistory.disabled.values, [true, false], 'the carried reading seeds the history');
  assert.equal(fieldStateCleared(g.elements[1]), true, 'the transition is visible to the retirement counterpart');
});

test('a declaration is NOT overwritten by a later reading — maxLength survives absence and disagreement', () => {
  const g = makeGraph();
  mergeSnapshot(g, '/p', [field({ kind: 'text', maxLength: 50 })]);

  // (a) a later snapshot that LACKS it (null = nothing declared) leaves it standing.
  mergeSnapshot(g, '/p', [field({ kind: 'text', maxLength: null })]);
  assert.equal(g.elements[1].fieldFacts.maxLength, 50, 'a declaration survives a later snapshot that lacks it');

  // (b) a later snapshot declaring a DIFFERENT value does not win either — the first honest reading
  // stands. This is the half that would break if maxLength were reclassified as state.
  mergeSnapshot(g, '/p', [field({ kind: 'text', maxLength: 9 })]);
  assert.equal(g.elements[1].fieldFacts.maxLength, 50, 'a declaration is write-once, not last-wins');

  // A declaration is still FILLED when it was genuinely absent before (write-once-THEN-FILL, unchanged).
  mergeSnapshot(g, '/p', [field({ kind: 'text', pattern: '[a-z]+' })]);
  assert.equal(g.elements[1].fieldFacts.pattern, '[a-z]+', 'a fact absent before is still added later');
});

test('required survives a later reading of false — the AntD wrapper race write-once exists for', () => {
  const g = makeGraph();
  // A full reading: the `.ant-form-item-required` wrapper had rendered.
  mergeSnapshot(g, '/p', [field({ kind: 'text', required: true })]);

  // A later snapshot catches the field before its wrapper renders. dom-snapshot writes `|| null` for a
  // declaration, so the realistic shape is null — skipped by the merge whatever the classification.
  mergeSnapshot(g, '/p', [field({ kind: 'text', required: null })]);
  assert.equal(g.elements[1].fieldFacts.required, true, 'required survives a later snapshot that omits it');

  // The load-bearing half: an EXPLICIT false must not unset it either. This is what separates a
  // declaration from a state key — a state key would take this reading and delete the field's
  // `fill-empty` obligation (knowledge.batteryFor), silently dropping the negative probe that carries
  // more information than the positive one (docs/GOAL.md).
  mergeSnapshot(g, '/p', [field({ kind: 'text', required: false })]);
  assert.equal(g.elements[1].fieldFacts.required, true, 'required survives an explicit later reading of false');
});

test('fieldStateCleared is the disabled→enabled predicate, and is false in every other case', () => {
  const still = makeGraph();
  mergeSnapshot(still, '/p', [field({ kind: 'text', disabled: true })]);
  assert.equal(fieldStateCleared(still.elements[1]), false, 'still disabled — the precondition is NOT met');

  mergeSnapshot(still, '/p', [field({ kind: 'text', disabled: false })]);
  assert.equal(fieldStateCleared(still.elements[1]), true, 'observed disabled, now enabled — the precondition IS met');

  // Flapped back: the control is disabled again, so a DISABLED row describes the CURRENT state.
  mergeSnapshot(still, '/p', [field({ kind: 'text', disabled: true })]);
  assert.equal(fieldStateCleared(still.elements[1]), false, 'disabled again — the current reading governs');

  // Never disabled at all: nothing to clear, and no history entry to misread.
  const never = makeGraph();
  mergeSnapshot(never, '/p', [field({ kind: 'text', disabled: false })]);
  assert.equal(fieldStateCleared(never.elements[1]), false, 'a control never seen disabled has no cleared precondition');

  // An unknown node / an unknown key never throws — the counterpart calls this on every element.
  assert.equal(fieldStateCleared(undefined), false, 'an absent node is false, not a throw');
  assert.equal(fieldStateCleared(never.elements[1], 'maxLength'), false, 'a non-state key is false');
});

test('a flapping control is capped, and the cap is disclosed rather than silently dropping readings', () => {
  const g = makeGraph();
  // Alternate more times than the cap allows.
  for (let i = 0; i < FIELD_STATE_HISTORY_CAP + 4; i++) {
    mergeSnapshot(g, '/p', [field({ kind: 'text', disabled: i % 2 === 0 })]);
  }
  const hist = g.elements[1].fieldStateHistory.disabled;
  assert.equal(hist.values.length, FIELD_STATE_HISTORY_CAP, 'the history stops growing at the cap');
  assert.equal(hist.truncated, true, 'the truncation is DISCLOSED, never a silent drop');
  assert.ok(hist.flips > FIELD_STATE_HISTORY_CAP, 'flips keeps counting past the cap — incomplete, never wrong');
  // The CURRENT reading always lives in fieldFacts, so it survives the cap.
  assert.equal(g.elements[1].fieldFacts.disabled, false, 'the current state is read from fieldFacts, not the capped list');
});

// THE LOAD-BEARING ASSERTION. A test that only checks the flag changed would pass while `disabled` quietly
// became an identity input — the 148-phantom-template failure mode (decisions.md INC.4, transient CSS-motion
// classes in the selector path) with a different transient reading, and worse than the bug being fixed.
//
// WHICH ASSERTION CATCHES IT, stated because the obvious one does NOT. A fact leaking into identity mints a
// NEW ledger key (`tpl:<sel>` → `tpl:<sel>true` / `<sel>false`), and the ledger is APPEND-ONLY: the old key
// is never re-mapped and never dropped, so `diffIdentity` classifies it as an ADDED template and still
// reports ok:true. `identity-diff` detects re-keys and drops, which is what it is for, and it is asserted
// here for that direction — but the leak is caught by the COUNTS (one template, one instance after the flip)
// and by the ledger map being unchanged. Run over ONE append-only ledger, as a real crawl does, so an
// unchanged map genuinely means no new key was minted.
test('no identity churn across the flip: one template, one instance, ledger unmoved', () => {
  const els = (facts) => [{
    templateSelector: 'form input.name', role: 'textbox', name: 'Group Name',
    instanceKey: '#1', instanceSelector: 'form input.name:nth-child(1)', fieldFacts: facts,
  }];

  const g = makeGraph(); const ledger = makeLedger();
  mergeSnapshot(g, '/p', idify(ledger, els({ kind: 'text', maxLength: 50, disabled: true })));
  const before = { ledger: JSON.parse(JSON.stringify(ledger)), graph: JSON.parse(JSON.stringify(g)) };

  // The SAME control, now enabled — the flip under test.
  mergeSnapshot(g, '/p', idify(ledger, els({ kind: 'text', maxLength: 50, disabled: false })));

  // THE PHANTOM CHECK, asserted FIRST so an identity leak reds with the diagnostic message rather than
  // with a downstream symptom: a state reading in the identity path mints a SECOND template here, and the
  // original then never receives the flip, so every later assertion fails for the wrong stated reason.
  assert.equal(Object.keys(g.elements).length, 1, 'the flip minted NO phantom template — still ONE control');
  assert.equal(g.elements[1].instances.length, 1, 'the flip minted NO phantom instance');

  // The flip really happened — the identity proof is not vacuous.
  assert.equal(g.elements[1].fieldFacts.disabled, false, 'the flip landed');
  assert.equal(g.elements[1].fieldStateHistory.disabled.flips, 1, 'the transition was recorded');

  // The append-only ledger keys on the selector strings ONLY — no field fact may enter it, so a flip adds
  // no key at all.
  assert.deepEqual(ledger.ids, before.ledger.ids, 'the id ledger is unchanged across the flip — no new key minted');

  // And the re-key / drop direction, which is what identity-diff is built to catch.
  const d = diffIdentity(before, { ledger, graph: g });
  assert.equal(d.ok, true, 'identity-diff reports no churn or drop across the flip');
  assert.deepEqual(d.churnedTemplates, [], 'no template ids churned');
  assert.deepEqual(d.churnedInstances, [], 'no instance ids churned');
  assert.equal(d.addedTemplates, 0, 'no template was ADDED either — the leak shape identity-diff calls growth');
  assert.equal(d.addedInstances, 0, 'no instance was added');
  assert.deepEqual(d.droppedEdges, [], 'no edges dropped');
});
