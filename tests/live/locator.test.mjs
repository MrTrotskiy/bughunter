// Live proof of locator preference: the snapshot classifies each control's most DURABLE
// handle (test-id > stable #id > role+name > css path) and applies the two-level
// uniqueness gate — a page-unique test-id is an instance discriminator, a test-id shared
// across a template's rows is a MARKER (flagged non-unique). This is the Phase-2 input so a
// generated spec targets `[data-testid="save-btn"]`, not a brittle nth-child path. Locator
// is a DERIVED attribute: identity still keys on the selector (asserted by the existing
// identity tests, which stay green — no churn).
//
// Guards: (1) the ladder assigns the right KIND per control (testid/id/role-name/css);
//   (2) the uniqueness gate flags a template-marker test-id non-unique while a page-unique
//   one is unique; (3) the KIND propagates to the graph node + instance + report.
// FAIL-ON-REVERT: force `unique: true` in dom-snapshot.mjs's locator gate → the shared
//   "row-action" marker reports unique=true → the "marker test-id is non-unique" assertion
//   fails. Separately, drop the testid/id ladder (return type 'css') → the Save/Stable/link
//   KIND assertions fail.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/locator-app/server.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { waitSettled } from '../../lib/browser/causal.mjs';
import { snapshotStep } from '../../lib/recon/step.mjs';
import { makeGraph, saveGraph } from '../../lib/graph/graph-store.mjs';
import { makeLedger, saveLedger } from '../../lib/graph/ids.mjs';
import { report } from '../../lib/recon/report.mjs';

test('the snapshot classifies each control\'s durable locator and gates test-id uniqueness', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-locator-'));
  const prevAllow = process.env.PW_ALLOW_PRIVATE;
  const prevState = process.env.BUGHUNTER_STATE_DIR;
  process.env.PW_ALLOW_PRIVATE = '1';
  process.env.BUGHUNTER_STATE_DIR = stateDir;

  const cold = await launch();
  t.after(async () => {
    await close(cold.browser);
    server.close();
    rmSync(stateDir, { recursive: true, force: true });
    if (prevAllow === undefined) delete process.env.PW_ALLOW_PRIVATE; else process.env.PW_ALLOW_PRIVATE = prevAllow;
    if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState;
  });

  const page = cold.page;
  const graph = makeGraph();
  const ledger = makeLedger();
  await gotoGated(page, url);
  await waitSettled(page);
  await snapshotStep(page, graph, ledger, '/');

  const byName = (n) => Object.values(graph.elements).find((e) => e.name === n);

  // (1) ladder KIND per control.
  const save = byName('Save');
  assert.equal(save.locator.type, 'testid', 'a control with an authored test-id → testid');
  assert.equal(save.instances[0].locator.value, 'save-btn', 'the concrete test-id value is recorded');
  assert.equal(save.instances[0].locator.unique, true, 'a page-unique test-id is an instance discriminator');

  // (2) uniqueness gate: a test-id shared across a template's rows is a MARKER, non-unique.
  const act = byName('Act');
  assert.equal(act.locator.type, 'testid', 'the shared test-id is still a testid KIND');
  assert.equal(act.instances[0].locator.unique, false, 'a test-id shared across instances is a marker, not unique');

  const stable = byName('Stable');
  assert.equal(stable.locator.type, 'id', 'a stable #id with no test-id → id');
  assert.equal(stable.instances[0].locator.value, '#stable', 'the id selector is recorded');

  const link = byName('Next page');
  assert.equal(link.locator.type, 'role-name', 'no test-id/id but role+name → role-name');

  const div = Object.values(graph.elements).find((e) => e.templateSelector.includes('widget'));
  assert.ok(div, 'the nameless [tabindex] div was captured');
  assert.equal(div.locator.type, 'css', 'nothing durable → css path');

  // (3) the KIND propagates through the graph to the report.
  saveGraph(path.join(stateDir, 'graph.json'), graph);
  saveLedger(path.join(stateDir, 'element-ids.json'), ledger);
  const rep = report({ json: true });
  const repSave = rep.routes.flatMap((r) => r.templates).find((tpl) => tpl.name === 'Save');
  assert.equal(repSave.locator.type, 'testid', 'the report surfaces the locator KIND (Phase-2 input)');
});
