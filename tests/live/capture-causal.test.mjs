// Live proof that debug capture (before/after key-frames + per-phase timings) rides ALONG
// an act WITHOUT perturbing causal attribution — the biggest risk of the capture layer. The
// frames are viewport-only screenshots taken while the cause token is __idle__ (before
// beginCause / after endCause), so they fire no page request and cannot forge a phantom
// edge. We prove it on the cross-act fixture, whose /api/shared background poll ticks inside
// #b's (slow) causal window: with capture ON, #b is still credited ONLY /api/other, the poll
// stays uncredited, AND both key-frames + the target rect + timings are produced.
//
// Guards: actStep(capture) produces a before frame (+ the acted rect), an after frame, and
//   per-phase timings, written to the run's shots/ dir — while the caused-request
//   attribution is unchanged (real edge credited, background poll rejected).
// FAIL-ON-REVERT: remove the capture.before/after calls in lib/recon/step.mjs → result.debug
//   is undefined → the "before/after frames captured" assertions go red (and no PNG is
//   written). Separately, if a frame were taken INSIDE the causal window and scrolled
//   (fullPage), a lazy fetch could leak — viewport-only + idle placement prevents it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/cross-act-app/server.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { waitSettled } from '../../lib/browser/causal.mjs';
import { snapshotStep, actStep } from '../../lib/recon/step.mjs';
import { makeGraph } from '../../lib/graph/graph-store.mjs';
import { makeLedger } from '../../lib/graph/ids.mjs';
import { openRun, makeCapture, runDir } from '../../lib/debug/trace.mjs';

test('debug capture produces frames + timings without perturbing causal attribution', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-capture-'));
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  const prevState = process.env.BUGHUNTER_STATE_DIR;
  const prevView = process.env.BUGHUNTER_VIEW;
  process.env.PW_ALLOW_PRIVATE = '1';
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  // Key-frames are VIEW-MODE-only (operator rule 2026-07-18: events always, screenshots on request).
  // This test guards the frames themselves, so it must ask for them explicitly.
  process.env.BUGHUNTER_VIEW = '1';

  const cold = await launch();
  t.after(async () => {
    await close(cold.browser);
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
    if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState;
    if (prevView === undefined) delete process.env.BUGHUNTER_VIEW; else process.env.BUGHUNTER_VIEW = prevView;
  });

  const page = cold.page;
  const graph = makeGraph();
  const ledger = makeLedger();
  await gotoGated(page, url);
  await waitSettled(page);
  await snapshotStep(page, graph, ledger, '/');

  const b = Object.values(graph.elements).find((n) => n.name === 'Load other');
  assert.ok(b, '#b was discovered');
  const target = { templateId: b.templateId, name: b.name, route: b.route, instance: b.instances[0] };

  const runId = 'r-test-capture';
  openRun({ runId, target: url });
  const capture = makeCapture(runId, b.templateId);
  const res = await actStep(page, graph, ledger, target, { capture });

  // Attribution stays clean WITH capture running: the real edge credited, the poll rejected.
  const patterns = res.requests.map((r) => r.urlPattern);
  assert.ok(patterns.includes('/api/other'), '#b is credited its real request');
  assert.ok(!patterns.includes('/api/shared'), 'the background poll is NOT credited (capture did not perturb it)');

  // Capture produced both key-frames, the target rect, and per-phase timings.
  assert.ok(res.debug, 'capture attached a debug block');
  assert.equal(res.debug.before.shot, `shots/t${b.templateId}-before.png`, 'before frame recorded');
  assert.ok(res.debug.before.rect && typeof res.debug.before.rect.width === 'number', 'the acted target rect was captured');
  assert.equal(res.debug.after.shot, `shots/t${b.templateId}-after.png`, 'after frame recorded');
  assert.equal(typeof res.debug.timings.actMs, 'number', 'the act (causal-window) duration was measured');

  // The frames actually exist on disk under the run's shots/ dir.
  assert.ok(existsSync(path.join(runDir(runId), res.debug.before.shot)), 'before PNG written');
  assert.ok(existsSync(path.join(runDir(runId), res.debug.after.shot)), 'after PNG written');
});
