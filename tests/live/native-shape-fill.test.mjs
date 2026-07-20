// Live proof that a SHAPE probe DRAINS on a native constrained input (the SHOULD FIX 1 fix), not a unit
// assertion — invariant #1 (a green mechanism says nothing about whether data is collected; prove the
// obligation actually falls off the outstanding list on a REAL browser).
//
// A native `input[type=number]` REFUSES a wrong-shape fill by THROWING: `handle.fill('not-a-number')` →
// "Malformed value". Before the fix, that throw was a non-envelope Playwright error recorded with
// `blocked:'ACT_FAILED'` — a TRANSIENT code that discharges NOTHING (knowledge.TRANSIENT_BLOCKS), so the
// `fill-invalid` obligation the field owes (batteryFor mints it via isShapedType('number')) stayed
// outstanding forever: the field stalled at L2 while the frontier reported it retired. The correct answer
// is `NOT_FILLABLE` — the native type held the line, a terminal L3 answer that mints no false finding.
// step.mjs tags the fill throw (`err.duringFill`) and stateful-step.mjs records NOT_FILLABLE for a shape
// probe on a NATIVE shaped input (`isShapedType(fieldFacts.kind)`) whose throw is not a transient
// (detach / navigation / timeout), so the obligation drains only when the type genuinely enforced it.
//
// Guards:
//   (a) NON-VACUITY — the field genuinely OWES fill-invalid (batteryFor includes it), and the crawl really
//       recorded a fill-invalid probe row. Without this the drain below could be trivially satisfied by a
//       field never probed.
//   (b) THE THROW IS RECORDED AS NOT_FILLABLE, not the transient ACT_FAILED it was before.
//   (c) DRAIN — probeStatus(#amount).outstanding does NOT include 'fill-invalid'. This is the fix: a
//       terminal block leaves the obligation discharged; a transient one (the bug) leaves it owed.
//
// FAIL-ON-REVERT (two independent levers, either reds guard (b) + (c)):
//   LEVER A (step.mjs) — delete `fillErr.duringFill = true;` in actStep's fill catch → the throw carries no
//       duringFill flag → stateful-step falls through to the final else → records ACT_FAILED (transient) →
//       fill-invalid stays in outstanding → "the fill-invalid obligation drained" reds.
//   LEVER B (stateful-step.mjs) — remove the `if (err.duringFill && (probeKind==='fill-invalid'||…))`
//       NOT_FILLABLE branch → same ACT_FAILED outcome → the drain and the NOT_FILLABLE-row assertions red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/native-number-app/server.mjs';
import { crawl } from '../../lib/recon/recon-run.mjs';
import { loadGraph } from '../../lib/graph/graph-store.mjs';
import { probeStatus, batteryFor } from '../../lib/recon/knowledge.mjs';

test('a wrong-shape probe on a native input[type=number] drains as NOT_FILLABLE (the type enforced its shape)', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-native-shape-'));
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  const prevState = process.env.BUGHUNTER_STATE_DIR;
  process.env.PW_ALLOW_PRIVATE = '1';
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  t.after(() => {
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
    if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState;
  });

  // The fixture holds one native numeric field (+ a harmless Save), so a small budget suffices: the loop
  // grinds #amount through its battery — fill-valid, then the fill-invalid shape probe that throws.
  const res = await crawl({ url, steps: 10, stateful: true });
  assert.equal(res.ok, true, 'stateful crawl completed');

  const graph = loadGraph(path.join(stateDir, 'graph.json'));
  // The native numeric input is the one whose declared field kind is `number` (id #amount, placeholder
  // "Amount"). dom-snapshot reads kind from el.type, so this is unambiguous.
  const num = Object.values(graph.elements).find((n) => n.fieldFacts?.kind === 'number');
  assert.ok(num, 'the native input[type=number] was discovered with fieldFacts.kind === "number"');

  // (a) NON-VACUITY — the field genuinely owes a wrong-shape probe, and the crawl recorded one.
  assert.ok(batteryFor(num, []).includes('fill-invalid'),
    'a native number input OWES a fill-invalid probe (isShapedType(number) mints it)');
  const invalidRows = (num.probes || []).filter((p) => p.kind === 'fill-invalid');
  assert.ok(invalidRows.length >= 1, 'the crawl actually probed #amount with a fill-invalid value');

  // (b) THE THROW IS RECORDED AS NOT_FILLABLE — the native type refused the wrong shape, terminally.
  assert.ok(invalidRows.some((p) => p.blocked === 'NOT_FILLABLE'),
    'the fill-invalid throw is recorded NOT_FILLABLE (the type enforced its shape), not a transient ACT_FAILED');
  assert.ok(!invalidRows.some((p) => p.blocked === 'ACT_FAILED'),
    'the fill throw must NOT be recorded as the transient ACT_FAILED that never drains');

  // (c) DRAIN — the obligation is discharged, so it is off the outstanding list. This is the whole fix:
  // NOT_FILLABLE is terminal (not in TRANSIENT_BLOCKS), so probeStatus removes fill-invalid from outstanding;
  // ACT_FAILED (the bug) would have left it owed forever.
  const outstanding = probeStatus(num, num.probes || []).outstanding;
  assert.ok(!outstanding.includes('fill-invalid'),
    `the fill-invalid obligation drained (outstanding: ${JSON.stringify(outstanding)})`);
});
