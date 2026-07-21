// Live proof that a crawl the operator STOPS (SIGTERM) stamps a partial conclusion on run.json
// instead of leaving it phantom "running". A signal-killed run used to hit closeRun on NORMAL loop
// completion only, so a SIGTERM/SIGINT left run.json at status:"running" with no stop-reason and no
// coverage totals — the admin viewer then showed a run that never ends. This violates the project's
// "an uninformative trail is a defect to fix" rule. recon-run's crawl() now installs SIGTERM/SIGINT
// handlers (right after openRun, before the browser launches) that closeRun the run partial-stamped,
// then exit non-zero.
//
// We spawn a REAL crawl subprocess against a local fixture, wait for openRun to publish
// run.json at status:"running" (handlers are armed in the same synchronous block), then SIGTERM it
// mid-run and assert the run.json is stamped with a stop-reason.
//
// Guards: recon-run stamps a PARTIAL conclusion (status != "running" + a `stopped` field) on
//   run.json when a crawl is killed by SIGTERM/SIGINT, so an operator-stopped run is never a phantom
//   status:"running" run with no conclusion.
// FAIL-ON-REVERT: remove the `process.on('SIGTERM', onSigterm)` / `process.on('SIGINT', onSigint)`
//   wiring in recon-run.mjs crawl() → the default disposition kills the process on SIGTERM with
//   run.json still at status:"running" and no `stopped` field → `assert.notEqual(r.status,'running')`
//   goes red with "Expected 'running' to not loosely deep-equal 'running'".
//   (Verified by reverting the wiring, running this file — RED — then restoring.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../fixtures/search-app/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', '..', 'lib', 'recon', 'recon-run.mjs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('a SIGTERM-killed crawl stamps a partial conclusion on run.json (never phantom-running)', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-signal-'));
  const runId = 'r-signal-test';
  const runJson = path.join(stateDir, 'runs', runId, 'run.json');

  const child = spawn(process.execPath, [CLI, `--url=${url}`], {
    env: { ...process.env, PW_ALLOW_PRIVATE: '1', BUGHUNTER_STATE_DIR: stateDir, BUGHUNTER_RUN_ID: runId },
  });
  let exitInfo = null;
  child.on('exit', (code, signal) => { exitInfo = { code, signal }; });

  // Teardown registered BEFORE any assertion that can throw, so a red assertion still cleans up.
  t.after(() => {
    try { if (exitInfo === null) child.kill('SIGKILL'); } catch {}
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  // Wait for openRun to publish run.json at status:"running". openRun runs BEFORE the browser
  // launches and the handlers are installed in the same synchronous block, so once this file
  // exists the SIGTERM is guaranteed to hit an armed process still mid-run (chromium launch alone
  // outlasts the poll).
  const readyBy = Date.now() + 30000;
  let running = false;
  while (Date.now() < readyBy) {
    if (existsSync(runJson)) {
      const r = JSON.parse(readFileSync(runJson, 'utf8'));
      if (r.status === 'running') { running = true; break; }
    }
    if (exitInfo) break;
    await sleep(50);
  }
  assert.ok(running, `run.json should reach status:"running" before we signal (exit=${JSON.stringify(exitInfo)})`);

  // Kill it mid-run.
  child.kill('SIGTERM');

  const exitBy = Date.now() + 20000;
  while (!exitInfo && Date.now() < exitBy) await sleep(50);
  assert.ok(exitInfo, 'the crawl process must exit after SIGTERM');
  assert.notEqual(exitInfo.code, 0, 'a signal-killed crawl must not report success (non-zero exit)');

  const r = JSON.parse(readFileSync(runJson, 'utf8'));
  assert.notEqual(r.status, 'running', 'run.json must not be left phantom-running after a kill');
  assert.ok(r.stopped, 'run.json must carry a stop-reason (stopped) after a signal kill');
  assert.equal(r.stopped, 'signal', 'the stop-reason names the signal disposition');
  assert.equal(r.partial, true, 'the conclusion is flagged partial (the crawl did not finish its frontier)');
});
