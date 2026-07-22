// The Stage-6 gate PERMIT event fires once per actStep (~200/run) and, left as its own pipeline row,
// (a) floods the «Конвейер» timeline with unfoldable permit→act pairs and (b) strands its resolve/
// ownership cost — the ~30%-of-wall-clock the plan measured — on a separate row that renders as idle
// («не измерено») because the cost rides `resolveMs` at payload top-level, not in `timings`. Two render-
// only fixes (no re-crawl): scrub-math credits `resolveMs` as a `resolve` stage, and foldPermitGates
// merges a permit into the act it cleared, conserving time and prepending that stage.
//
// Guards: (1) a permit gate is FOLDED into its following act (no timeline flood), time conserved, with a
//   `resolve` stage crediting the ownership-proof cost so it leaves idleMs; (2) a REFUSE gate is NOT
//   folded — it is the first-class reason «почему не нажал».
// FAIL-ON-REVERT: drop foldPermitGates from foldAll (pipeline-view.mjs) → the permit stays its own row →
//   "the permit folded into its act (one row, not two)" reds. Drop the `resolveMs`→resolve-stage synth in
//   scrub-math.derivePipeline → the merged row's resolve cost falls into idleMs → "the resolve cost is a
//   credited stage, not idle" reds. (Both verified by hand per tests/CLAUDE.md.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derivePipeline } from '../../lib/debug/scrub-math.mjs';
import { foldAll, foldPermitGates } from '../../lib/debug/pipeline-view.mjs';

// ts deltas are the inter-event gaps derivePipeline attributes to the FOLLOWING event.
const PERMIT_RUN = [
  { seq: 0, ts: 1000, kind: 'pick', payload: {} },
  { seq: 1, ts: 1300, kind: 'gate', payload: { decision: 'permit', templateId: 5, stage: 'cleared', ownership: 'own', resolveMs: 300 } },
  { seq: 2, ts: 1500, kind: 'act', payload: { templateId: 5, name: 'Save', timings: { actMs: 100, settleMs: 100 } } },
];

test('a permit gate folds into its act — one row, not two, time conserved', () => {
  const rows = foldAll(derivePipeline(PERMIT_RUN));
  const acts = rows.filter((r) => r.kind === 'act');
  const gates = rows.filter((r) => r.kind === 'gate');
  assert.equal(gates.length, 0, 'the permit folded into its act (one row, not two)');
  assert.equal(acts.length, 1, 'exactly one act row survives');
  const act = acts[0];
  assert.equal(act.permitFolded, true, 'the merged act is marked as having absorbed a permit');
  // durMs conserved: the gap before the permit (300, the resolve/ownership work) + the act's own gap (200)
  assert.equal(act.durMs, 500, 'the merged row carries the permit gap + the act gap (time conserved)');
});

test('the resolve cost is a credited stage on the merged act, not idle', () => {
  const rows = foldAll(derivePipeline(PERMIT_RUN));
  const act = rows.find((r) => r.kind === 'act');
  const resolve = (act.stages || []).find((s) => s.name === 'resolve');
  assert.ok(resolve, 'a resolve stage credits the ownership-proof cost');
  assert.equal(resolve.ms, 300, 'the resolve stage carries resolveMs');
  assert.equal(act.idleMs, 0, 'with resolve + act + settle all credited, no wall clock falls into idle');
});

test('the permit fold only fires for the SAME templateId', () => {
  const mismatched = foldPermitGates(derivePipeline([
    { seq: 0, ts: 1000, kind: 'gate', payload: { decision: 'permit', templateId: 5, resolveMs: 10 } },
    { seq: 1, ts: 1100, kind: 'act', payload: { templateId: 9, timings: { actMs: 50 } } },
  ]));
  assert.equal(mismatched.filter((r) => r.kind === 'gate').length, 1, 'a permit for a different template is not folded');
});

test('a REFUSE gate is NOT folded — it is the first-class reason "почему не нажал"', () => {
  const rows = foldAll(derivePipeline([
    { seq: 0, ts: 1000, kind: 'gate', payload: { decision: 'refuse', templateId: 7, stage: 'href-route', code: 'DANGER_FLOOR', resolveMs: 20 } },
    { seq: 1, ts: 1100, kind: 'act.failed', payload: { templateId: 7, code: 'DANGER_FLOOR' } },
  ]));
  const refuse = rows.find((r) => r.kind === 'gate' && r.payload.decision === 'refuse');
  assert.ok(refuse, 'a refuse gate stays a row of its own');
  // and it is explained by its own resolve stage rather than reading blank
  assert.ok((refuse.stages || []).some((s) => s.name === 'resolve'), 'a standalone refuse gate credits its own resolve cost');
});
