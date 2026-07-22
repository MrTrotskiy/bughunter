// Live proof that the Stage-6 DECISION RECORD reaches the trail: for every offered control the agent
// path emits a `gate` event saying whether it PRESSED and — for a refusal — at which rule, and the run
// records WHO drove it (`driver.open`). Before this, a refusal survived only as a relabelled `act.failed`
// (an outcome, not a decision) and a PERMIT had no event at all, so the admin could not answer the
// operator's standing question "почему нажал / почему НЕ нажал" from the trail alone.
//
// The logout-link fixture carries both shapes in ONE page: a safe `#search` button (→ a PERMIT gate) and
// an icon-only `<a id="logout-link" href="/logout">` whose empty name slips the name-floor but whose href
// is a danger route (→ a REFUSE gate at stage href-route). Two whats-new acts share ONE BUGHUNTER_RUN_ID
// so both land in the same events.ndjson, exactly as act-failed-trail.test.mjs drives its trail.
//
// Guards: the gate decision record — a permit names the cleared stage + a numeric resolveMs (the ownership-
//   proof cost), a refusal names its rule + code, and driver.open records the AGENT driver — all to
//   state/runs/<id>/events.ndjson, not lost to inference.
// FAIL-ON-REVERT: delete the `emitGate(runId, {...decision:'permit'...})` write before beginCause in
//   step.mjs → the permit assertion "a PERMIT gate was recorded for the safe control" goes red. Delete the
//   `driverOpen(runId, {driver:'agent'...})` call in whats-new.mjs → the driver assertion goes red. Delete
//   the href-route `emitGate(...decision:'refuse'...)` → the refuse assertion goes red. (Verified by hand.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../fixtures/logout-link-app/server.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, '..', '..', 'lib', 'recon', 'whats-new.mjs');

function runCli(args, stateDir, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, PW_ALLOW_PRIVATE: '1', BUGHUNTER_STATE_DIR: stateDir, ...extraEnv },
    });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, out, err }));
  });
}

test('the agent path records gate permits/refusals and the driver to the trail', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-gate-'));
  const runId = 'r-gate-trail-test';
  t.after(() => { server.close(); rmSync(stateDir, { recursive: true, force: true }); });

  // baseline: persist #search + #logout-link templates to the graph
  const base = await runCli([`--url=${url}`], stateDir);
  assert.equal(base.code, 0, `baseline should exit 0, stderr=${base.err}`);
  const ledger = JSON.parse(readFileSync(path.join(stateDir, 'element-ids.json'), 'utf8'));
  const searchId = ledger.ids['tpl:#search'];
  const logoutId = ledger.ids['tpl:#logout-link'];
  assert.ok(Number.isInteger(searchId) && Number.isInteger(logoutId), 'both templates received stable ids');

  // act the SAFE control → a permit gate + driver.open, then the DANGER link → a refuse gate
  const permit = await runCli([`--url=${url}`, `--act-template=${searchId}`], stateDir, { BUGHUNTER_RUN_ID: runId });
  assert.equal(permit.code, 0, `the safe act should exit 0, stderr=${permit.err}`);
  const refuse = await runCli([`--url=${url}`, `--act-template=${logoutId}`], stateDir, { BUGHUNTER_RUN_ID: runId });
  assert.notEqual(refuse.code, 0, 'the danger link act must exit non-zero (refused)');
  assert.equal(server.logoutHits(), 0, 'the gate must keep the browser off /logout (non-vacuous: the link was really refused)');

  const events = readFileSync(path.join(stateDir, 'runs', runId, 'events.ndjson'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l));

  // driver.open — recorded exactly once, naming the AGENT (whats-new is the agent path)
  const drivers = events.filter((e) => e.kind === 'driver.open');
  assert.equal(drivers.length, 1, 'driver.open is recorded once per run (head-scan dedup across processes)');
  assert.equal(drivers[0].payload.driver, 'agent', 'the agent path records driver=agent');

  // PERMIT — the positive decision record that had no event before
  const gates = events.filter((e) => e.kind === 'gate');
  const permitG = gates.find((e) => e.payload.decision === 'permit' && e.payload.templateId === searchId);
  assert.ok(permitG, 'a PERMIT gate was recorded for the safe control');
  assert.equal(permitG.payload.stage, 'cleared', 'the permit fired after every gate cleared');
  assert.equal(typeof permitG.payload.resolveMs, 'number', 'the permit carries the ownership-proof cost (resolveMs)');

  // REFUSE — the reason "почему не нажал", first-class, not inferred from act.failed
  const refuseG = gates.find((e) => e.payload.decision === 'refuse' && e.payload.templateId === logoutId);
  assert.ok(refuseG, 'a REFUSE gate was recorded for the danger link');
  assert.equal(refuseG.payload.stage, 'href-route', 'the refusal names the rule that declined (href-route)');
  assert.equal(refuseG.payload.code, 'DANGER_FLOOR', 'the refusal carries its code');
});
