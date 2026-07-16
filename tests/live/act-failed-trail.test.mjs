// Live proof that a FAILED agent-path act records its granular fail-reason to the debug
// trail. When whats-new's main() catches a thrown act (NO_INSTANCE / NOT_VISIBLE / REVEAL_* /
// ROUTE_DANGER), the precise code otherwise vanishes: emitError writes it to stderr only, the
// `act` trace event is written on success alone, and the graph holds just the agent's coarse
// observe effect. report.mjs --unreached's fail-reason histogram reads these granular buckets
// from the trail, so main()'s catch must emit an `act.failed` event at throw time.
//
// We provoke a REAL browser act failure the cleanest deterministic way: snapshot the search
// fixture (so template #search exists in the persisted graph), then act that valid template
// with a non-existent --instance key → run() throws NO_INSTANCE from inside the browser act
// path, main()'s catch fires. BUGHUNTER_RUN_ID is set only on the failing run so its
// events.ndjson is created by that run.
//
// Guards: the agent-path act.failed trail seam — a failed act's granular reason code
//   (here NO_INSTANCE, for the acted templateId) is captured to state/runs/<id>/events.ndjson,
//   not lost to stderr.
// FAIL-ON-REVERT: delete the `traceEvent(runId, 'act.failed', ...)` write in whats-new.mjs
//   main()'s catch → events.ndjson still holds the pre-throw `route` event but NO `act.failed`
//   event → the `assert.ok(failed, ...)` below goes red with "no act.failed event was written".
//   (Verified by reverting the write, running this file — RED — then restoring.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../fixtures/search-app/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', '..', 'lib', 'recon', 'whats-new.mjs');

function runCli(args, stateDir, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, PW_ALLOW_PRIVATE: '1', BUGHUNTER_STATE_DIR: stateDir, ...extraEnv },
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('a failed agent-path act writes its granular fail-reason (NO_INSTANCE) to the debug trail', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-actfail-'));
  const runId = 'r-actfailed-test';
  // Register teardown BEFORE any assertion that can throw, so a red assertion still cleans up.
  t.after(() => {
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
  });

  // --- baseline: snapshot the fixture so template #search is persisted to the graph ---
  const base = await runCli([`--url=${url}`], stateDir);
  assert.equal(base.code, 0, `baseline should exit 0, stderr=${base.err}`);

  // #search has a stable id, so its template key is deterministic.
  const ledger = JSON.parse(readFileSync(path.join(stateDir, 'element-ids.json'), 'utf8'));
  const searchId = ledger.ids['tpl:#search'];
  assert.ok(Number.isInteger(searchId), 'search button received a stable template id');

  // --- failing act: valid template, non-existent instance key → NO_INSTANCE from run() ---
  const acted = await runCli(
    [`--url=${url}`, `--act-template=${searchId}`, '--instance=__no_such_instance__'],
    stateDir,
    { BUGHUNTER_RUN_ID: runId },
  );
  assert.notEqual(acted.code, 0, 'the failing act must exit non-zero');
  const errEnv = JSON.parse(acted.err);
  assert.equal(errEnv.error.code, 'NO_INSTANCE', `expected NO_INSTANCE envelope, got ${acted.err}`);

  // --- assert the trail captured the granular fail-reason ---
  const eventsPath = path.join(stateDir, 'runs', runId, 'events.ndjson');
  assert.ok(existsSync(eventsPath), `events.ndjson must exist at ${eventsPath}`);
  const events = readFileSync(eventsPath, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const failed = events.find((e) => e.kind === 'act.failed');
  assert.ok(failed, 'no act.failed event was written to the trail');
  assert.equal(failed.payload.code, 'NO_INSTANCE', 'act.failed carries the granular thrown code');
  assert.equal(failed.payload.templateId, searchId, 'act.failed carries the acted templateId');
});
