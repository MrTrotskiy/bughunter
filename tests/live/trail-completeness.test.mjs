// Live proof — on a REAL explore-all + stateful crawl of the hunt-social feed — that the three decision
// facts the run-log audit found missing now reach the trail: WHY the run stopped (`loop-terminal`), the
// BASIS of an own-vs-foreign ownership verdict (`gate.ownershipVia`), and the real REASON a candidate did
// not resolve (`pick.rejected[].why`, no longer the constant «no-live-handle»). This is not a fixture-
// mechanism check — it drives the actual crawl and reads its actual events.ndjson, the bar the operator
// set ("prove we log what the agent does and why, on a real run").
//
// Guards: (1) statefulLoop emits ONE `loop-terminal` carrying the stop reason + reach stats; (2) the
//   ownership rail stamps `ownershipVia` so a same-post Edit=own vs Delete=foreign flip records its basis;
//   (3) a resolve failure records a diagnosis (gone-from-dom / present-not-visible / …), not a constant.
// FAIL-ON-REVERT (each verified): delete the `traceEvent(runId,'loop-terminal',…)` in stateful-loop.mjs
//   → "a loop-terminal event states why the run stopped" reds; drop `ownershipVia` from the ownership-rail
//   gate emit in step.mjs → "an own verdict records marker-on-handle" reds; revert resolvesLive to the
//   boolean + the constant `why:'no-live-handle'` → "a reject reason is a diagnosis" reds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/hunt-social-app/server.mjs';
import { crawl } from '../../lib/recon/recon-run.mjs';
import { huntMarker } from '../../lib/recon/hunt-gate.mjs';

test('a real explore-all crawl records why-it-stopped, the ownership basis, and real reject reasons', async (t) => {
  const runId = 'r-trailcomplete-test';
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-trailc-'));
  const marker = huntMarker(runId);
  const server = await start(0, { marker });
  const url = `http://127.0.0.1:${server.address().port}/`;
  const prevEnv = { ...process.env };
  process.env.PW_ALLOW_PRIVATE = '1';
  process.env.BUGHUNTER_EXPLORE_ALL = '1';
  process.env.BUGHUNTER_RUN_ID = runId;
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  t.after(() => {
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
    process.env = prevEnv;
  });

  await crawl({ url, steps: 40, exploreAll: true, stateful: true, runCreatedAccount: true });

  const events = readFileSync(path.join(stateDir, 'runs', runId, 'events.ndjson'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));

  // (1) the terminal reason is ON THE TRAIL, one line, not reconstructed from four tail rows
  const term = events.filter((e) => e.kind === 'loop-terminal');
  assert.equal(term.length, 1, 'a loop-terminal event states why the run stopped (exactly one per run)');
  assert.ok(term[0].payload.reason, 'the terminal event names a reason');
  assert.ok(term[0].payload.stats && Number.isInteger(term[0].payload.stats.explored), 'it carries reach stats');
  assert.equal(typeof term[0].payload.steps, 'number', 'steps is a count, not the whole steps array (the bug this guards against)');

  // (2) the ownership BASIS is recorded — an OWN verdict via the marker, a FOREIGN via its absence
  const gates = events.filter((e) => e.kind === 'gate' && e.payload.ownershipVia);
  const own = gates.find((g) => g.payload.ownership === 'own');
  const foreign = gates.find((g) => g.payload.ownership === 'foreign');
  assert.ok(own, 'at least one gate resolved OWN');
  assert.equal(own.payload.ownershipVia, 'marker-on-handle', 'an own verdict records the marker that proved it');
  assert.ok(foreign, 'at least one gate resolved FOREIGN');
  assert.equal(foreign.payload.ownershipVia, 'no-marker-in-item', 'a foreign verdict records WHY it is foreign');

  // (3) a resolve failure carries a diagnosis, not the old constant
  const rejectWhys = new Set();
  const rejects = [];
  for (const e of events.filter((e) => e.kind === 'pick')) for (const r of e.payload.rejected || []) { rejectWhys.add(r.why); rejects.push(r); }
  if (rejectWhys.size) {
    assert.ok(!rejectWhys.has('no-live-handle') || rejectWhys.size > 1, 'a reject reason is a diagnosis (gone-from-dom / present-not-visible / …), not the constant');
    assert.ok([...rejectWhys].some((w) => ['gone-from-dom', 'present-not-visible', 'wrong-template', 'not-probed'].includes(w)), 'the recorded reason is one of the real resolve diagnoses');
    // a pick-stage reject never reaches gate/act — so its OWN row must identify the control (the last
    // residual the re-audit found): the operator names it from the trail alone, not from the gzip graph.
    const nameless = rejects.find((r) => !(r.name && r.name.trim()));
    if (nameless) assert.ok(nameless.instanceKey || nameless.selector, 'a nameless pick-reject carries instanceKey/selector so it is identifiable from the trail alone');
  }
});
