// Live proof that a SHAPE field's fill-valid probe DRAINS under explore-all, instead of failing on the
// ownership marker (invariant #1: a green mechanism says nothing about whether the obligation actually
// falls off the outstanding list on a REAL browser).
//
// Under explore-all the run stamps an invisible ownership marker (a zero-width unicode run) into every
// self-fill. Appended to a value the browser parses BY TYPE — `"0"` into `input[type=range]` — the result
// is no longer valid for that type, so `handle.fill` throws "Malformed value". `fill-valid` is not the
// wrong-shape probe, so stateful-step does NOT record it NOT_FILLABLE (that branch is fill-invalid/overflow
// only); it falls through to the transient ACT_FAILED, and the fill-valid obligation stays owed FOREVER.
// The fix (step.stampOwnership skips shaped types) lets the fill land, so the probe drains.
//
// Guards:
//   (a) NON-VACUITY — the range field genuinely OWES fill-valid (batteryFor mints it) and the crawl really
//       recorded a fill-valid probe row on it. Without this the drain below is trivially satisfied.
//   (b) THE FILL LANDED — the fill-valid row is NOT the transient ACT_FAILED (no malformed throw), and the
//       act recorded it as self-filled.
//   (c) DRAIN — probeStatus(#vol).outstanding does NOT include 'fill-valid'. Before the fix, the malformed
//       throw is a transient block that discharges nothing, so the obligation stays owed.
//
// FAIL-ON-REVERT: delete `if (isShapedType(factsKind)) return field;` in step.stampOwnership → the marker is
// appended to the range's "0" → handle.fill throws "Malformed value" → the fill-valid probe records
// ACT_FAILED (transient) → "the fill-valid obligation drained" reds. (Verified separately at the unit layer
// in tests/unit/ownership-shape.test.mjs, whose revert reds the shaped-skip assertion.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/marker-range-app/server.mjs';
import { crawl } from '../../lib/recon/recon-run.mjs';
import { loadGraph } from '../../lib/graph/graph-store.mjs';
import { probeStatus, batteryFor } from '../../lib/recon/knowledge.mjs';

test('a fill-valid probe on a native input[type=range] drains under explore-all (the marker no longer malforms it)', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-marker-range-'));
  const prev = {
    allow: process.env.PW_ALLOW_PRIVATE, state: process.env.BUGHUNTER_STATE_DIR,
    explore: process.env.BUGHUNTER_EXPLORE_ALL, run: process.env.BUGHUNTER_RUN_ID,
  };
  process.env.PW_ALLOW_PRIVATE = '1';
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  process.env.BUGHUNTER_EXPLORE_ALL = '1';           // arm explore-all so the ownership marker is active
  process.env.BUGHUNTER_RUN_ID = 'markershape';      // the marker needs a run id (exploreAllArmed)
  t.after(() => {
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
    for (const [k, envk] of [['allow', 'PW_ALLOW_PRIVATE'], ['state', 'BUGHUNTER_STATE_DIR'],
      ['explore', 'BUGHUNTER_EXPLORE_ALL'], ['run', 'BUGHUNTER_RUN_ID']]) {
      if (prev[k] === undefined) delete process.env[envk]; else process.env[envk] = prev[k];
    }
  });

  const res = await crawl({ url, steps: 14, stateful: true, exploreAll: true });
  assert.equal(res.ok, true, 'stateful explore-all crawl completed');

  const graph = loadGraph(path.join(stateDir, 'graph.json'));
  const vol = Object.values(graph.elements).find((n) => n.fieldFacts?.kind === 'range');
  assert.ok(vol, 'the native input[type=range] was discovered with fieldFacts.kind === "range"');

  // (a) NON-VACUITY.
  assert.ok(batteryFor(vol, []).includes('fill-valid'),
    'a range input OWES a fill-valid probe');
  const validRows = (vol.probes || []).filter((p) => p.kind === 'fill-valid');
  assert.ok(validRows.length >= 1, 'the crawl actually probed #vol with a fill-valid value');

  // (b) THE FILL LANDED — no malformed-throw ACT_FAILED, and the act self-filled.
  assert.ok(!validRows.some((p) => p.blocked === 'ACT_FAILED'),
    'the fill-valid probe must NOT record the transient ACT_FAILED a malformed marker would cause');
  assert.ok(validRows.some((p) => p.selfFilled === true || p.blocked == null),
    'the fill-valid probe landed (self-filled / not blocked)');

  // (c) DRAIN.
  const outstanding = probeStatus(vol, vol.probes || []).outstanding;
  assert.ok(!outstanding.includes('fill-valid'),
    `the fill-valid obligation drained (outstanding: ${JSON.stringify(outstanding)})`);
});
