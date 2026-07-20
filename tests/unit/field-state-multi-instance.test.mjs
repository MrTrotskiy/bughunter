// A MULTI-INSTANCE DISAGREEMENT IS NOT A TEMPORAL UNLOCK.
//
// `fieldFacts` / `fieldStateHistory` live on the TEMPLATE, but one snapshot carries every instance of a
// template as its own element, so `mergeSnapshot` used to call `recordFieldState` once PER INSTANCE in DOM
// order. A template rendering several instances with MIXED `disabled` — a permissions table: the current
// user's row disabled, everyone else's enabled — recorded history `[true, false]` in a SINGLE instant, and
// `fieldStateCleared` then returned true. Its contract is "went true→false OVER TIME, the crawler learned
// what unlocks it" — but nothing unlocked; two different rows at the same moment.
//
// The cost: the genuinely-disabled instances keep being re-emitted/re-probed (knowledge ARM 1/ARM 2 decline
// to retire pre-flip DISABLED while `cleared` is true), the "control-not-operable" finding is suppressed,
// and the self-limiting recovery never triggers because the enabled row keeps re-reading false. Wasted acts
// on a common UI pattern.
//
// Fix: the history now records ONE per-snapshot AGGREGATE per key — instances that agree collapse to their
// shared boolean, instances that disagree collapse to 'mixed', which `fieldStateCleared` refuses to read as
// a flip. A genuine temporal unlock (uniform disabled → uniform enabled across snapshots) still clears.
//
// Guards: a spatial (multi-instance) disagreement never masquerades as a temporal unlock, while a real
// unlock across snapshots still does; both knowledge ARMs consequently retire the genuinely-disabled
// instance and surface its finding.
// FAIL-ON-REVERT: restore the per-instance `merged[k] = recordFieldState(node, k, v, prev[k])` in
// mergeSnapshot (record every instance) → the mixed snapshot writes history [true,false] in one instant →
// fieldStateCleared reads it as an unlock → "a mixed permissions table is NOT a temporal unlock" reds, and
// "the genuinely-disabled row is still retired / a finding" red with it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGraph, mergeSnapshot, fieldStateCleared } from '../../lib/graph/graph-store.mjs';
import { answeredTerminally, notOperableFindings, probeStatus } from '../../lib/recon/knowledge.mjs';

// One field template, N instances in ONE snapshot. `rows` is [{ key, disabled }, …] — one instance each.
const FACTS = { kind: 'text', maxLength: 50, required: true };
const snapshot = (rows) => rows.map((r, i) => ({
  templateId: 1, instanceId: 10 + i, templateSelector: 'table input.perm', role: 'textbox', name: 'Permission',
  instanceKey: r.key, instanceSelector: `table tr:nth-child(${i + 1}) input.perm`, visible: true,
  fieldFacts: { ...FACTS, disabled: r.disabled },
}));

test('a mixed permissions table (row 1 disabled, row 2 enabled) is NOT a temporal unlock', () => {
  const g = makeGraph();
  // Both rows in ONE snapshot: #1 disabled, #2 enabled. Under per-instance recording this wrote
  // [true,false] in one instant and read as an unlock. It must record 'mixed' instead.
  mergeSnapshot(g, '/team', snapshot([{ key: '#1', disabled: true }, { key: '#2', disabled: false }]));

  assert.equal(g.elements[1].instances.length, 2, 'both rows are distinct instances (non-vacuous)');
  assert.deepEqual(g.elements[1].fieldStateHistory.disabled.values, ['mixed'],
    'a within-snapshot disagreement is recorded as one mixed reading, not a two-entry flip');
  assert.equal(fieldStateCleared(g.elements[1]), false,
    'a mixed permissions table is NOT a temporal unlock — nothing changed over time, two rows differ at once');
});

test('DOM order does not matter — enabled first, disabled second, still mixed', () => {
  const g = makeGraph();
  mergeSnapshot(g, '/team', snapshot([{ key: '#1', disabled: false }, { key: '#2', disabled: true }]));
  assert.deepEqual(g.elements[1].fieldStateHistory.disabled.values, ['mixed'], 'order-independent aggregate');
  assert.equal(fieldStateCleared(g.elements[1]), false, 'still not a temporal unlock');
});

test('the genuinely-disabled row is still retired and surfaced as a finding (both ARMs stay correct)', () => {
  // With `cleared` correctly false, knowledge does NOT drop the DISABLED rows: ARM 1 retires the disabled
  // instance element-scoped, and notOperableFindings reports it. This is exactly the re-probing/finding the
  // false-positive used to suppress.
  const g = makeGraph();
  mergeSnapshot(g, '/team', snapshot([{ key: '#1', disabled: true }, { key: '#2', disabled: false }]));
  g.elements[1].instances[0].explored = true;
  // The disabled row's probe history: three DISABLED answers (the shape a run accumulates on it).
  g.elements[1].probes = Array.from({ length: 3 }, () => ({ instanceKey: '#1', kind: 'click', blocked: 'DISABLED' }));

  assert.equal(answeredTerminally(g.elements[1], g.elements[1].probes), 'element-blocked',
    'ARM 1 retires the genuinely-disabled row — a mixed snapshot did not clear it');
  assert.deepEqual(probeStatus(g.elements[1], g.elements[1].probes).outstanding, [],
    'and its battery is discharged with the DISABLED reason attached, not left owing a code it cannot answer');
  assert.equal(notOperableFindings(g).length, 1,
    'the control-not-operable finding is surfaced, not suppressed by a phantom unlock');
});

test('a GENUINE temporal unlock across snapshots still clears — the fix does not over-suppress', () => {
  const g = makeGraph();
  // Snapshot 1: BOTH rows disabled (the whole table is locked until a precondition).
  mergeSnapshot(g, '/team', snapshot([{ key: '#1', disabled: true }, { key: '#2', disabled: true }]));
  assert.deepEqual(g.elements[1].fieldStateHistory.disabled.values, [true], 'uniform → a clean boolean, not mixed');
  assert.equal(fieldStateCleared(g.elements[1]), false, 'still locked');

  // Snapshot 2: the precondition is met and BOTH rows enable.
  mergeSnapshot(g, '/team', snapshot([{ key: '#1', disabled: false }, { key: '#2', disabled: false }]));
  assert.deepEqual(g.elements[1].fieldStateHistory.disabled.values, [true, false], 'a real transition over time');
  assert.equal(fieldStateCleared(g.elements[1]), true,
    'uniform-disabled → uniform-enabled across snapshots IS a temporal unlock — this still clears');
});

test('a mixed snapshot AFTER a clean disabled one does not read as unlocked', () => {
  const g = makeGraph();
  mergeSnapshot(g, '/team', snapshot([{ key: '#1', disabled: true }, { key: '#2', disabled: true }])); // both locked
  mergeSnapshot(g, '/team', snapshot([{ key: '#1', disabled: true }, { key: '#2', disabled: false }])); // now split
  assert.deepEqual(g.elements[1].fieldStateHistory.disabled.values, [true, 'mixed'], 'true then a disagreement');
  assert.equal(fieldStateCleared(g.elements[1]), false,
    'the latest snapshot disagreed across instances — not the whole control becoming enabled');
});
