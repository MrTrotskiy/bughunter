// Live proof of L1 — a recovery act.failed row carries the reveal-replay OUTCOME inline (stateful-loop.mjs
// stamps `target.revealReplay`, stateful-step.mjs recordFail emits it). The fix1/dashproof audit
// (run-log-reviewer) found that the 22 reveal-required NO_INSTANCE/ALIAS failures were the one class the
// trail could NOT explain from the failure row alone: a reader could not tell "the container never opened"
// from "it opened and the control STILL would not act". The reveal-replay diagnosis existed only in separate
// `reopen`/`reopen-delivered` events the failure-row consumer (`readActFailed`) never joined.
//
// This forces the confusing pair deterministically. A hand-built graph holds an already-explored opener A
// (#open) and an unexplored target B (#deep) that is display:none at baseline (so it does NOT resolve live —
// recoverGated is the only path that reaches it) and records a reveal path through A. recoverGated reopens
// B: it clicks A in place, the panel opens, B becomes VISIBLE → reopenContainer returns REOPEN_OK. It then
// acts B — but the panel's #cover overlay intercepts pointer events, so the click times out → ACT_FAILED.
// The reopen SUCCEEDED and the act FAILED, and the recovery act.failed row must say so inline.
//
// Guards: the recovery act.failed carries `revealReplay.replayed === true` with `ok === true` (the container
//   reopened) — the inline half of the reopen/reopen-delivered events, on the row readActFailed reads.
// FAIL-ON-REVERT: delete the `target.revealReplay = {...}` stamp in stateful-loop.mjs recoverGated → the
//   recovery act.failed falls back to the recordFail default `{replayed:false}` → "the recovery act.failed
//   carries replayed:true" reds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/reopen-act-fail-app/server.mjs';
import { statefulStep } from '../../lib/recon/stateful-step.mjs';
import { statefulLoop } from '../../lib/recon/stateful-loop.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';

test('a recovery act that fails after a successful reopen carries the reveal-replay outcome inline', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const origin = new URL(url).origin;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-reveal-replay-'));
  const runId = 'r-reveal-replay-test';
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  const prevState = process.env.BUGHUNTER_STATE_DIR;
  process.env.PW_ALLOW_PRIVATE = '1';
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  const { browser, page } = await launch();
  t.after(async () => {
    await close(browser);
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
    if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState;
  });

  await gotoGated(page, url);

  // A is an explored opener that resolves live (#open); B is unexplored, display:none at baseline (does not
  // resolve live), with a reveal path through A. recoverGated reopens B in place, then acts it.
  const graph = {
    schemaVersion: 8,
    routes: {},
    requests: {},
    edges: [],
    elements: {
      1: {
        role: 'button', name: 'Open Panel', route: '/', explored: true,
        instances: [{ instanceKey: 'a-1', instanceSelector: '#open', explored: true }],
      },
      2: {
        role: 'button', name: 'Deep Control', route: '/',
        instances: [{
          instanceKey: 'b-1', instanceSelector: '#deep',
          reveal: { statePath: [{ templateId: 1, instanceKey: 'a-1' }] },
        }],
      },
    },
  };

  const step = statefulStep({ page, origin, baselineUrl: url, ledger: {}, runId });
  const result = await statefulLoop(graph, { page, origin, ledger: {}, step, budget: { steps: 30 }, runId });
  assert.ok(result && result.stopped, 'statefulLoop returned a terminal verdict');

  const eventsPath = path.join(stateDir, 'runs', runId, 'events.ndjson');
  assert.ok(existsSync(eventsPath), `events.ndjson must exist at ${eventsPath}`);
  const events = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

  // NON-VACUITY: the reopen genuinely succeeded (REOPEN_OK), so a recovery act ran.
  const reopen = events.find((e) => e.kind === 'reopen' && e.payload?.templateId === 2 && e.payload?.ok === true);
  assert.ok(reopen, 'the container reopened successfully (REOPEN_OK) so a recovery act was attempted');

  // The recovery act.failed for B carries the reveal-replay outcome inline.
  const failed = events.find((e) => e.kind === 'act.failed' && e.payload?.templateId === 2);
  assert.ok(failed, 'the recovery act on B failed and was recorded as act.failed');
  assert.equal(failed.payload.revealReplay?.replayed, true,
    'the recovery act.failed carries revealReplay.replayed:true (the reopen happened before this act)');
  assert.equal(failed.payload.revealReplay?.ok, true,
    'the inline outcome records that the reopen SUCCEEDED — so this is "reopened, acted, still failed", not a live-state miss');
});
