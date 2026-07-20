// Live proof that a DISABLED field becomes readable as ENABLED once its precondition is met — the half of
// the state-vs-declaration fix that runs IN THE PAGE and so cannot be unit tested.
//
// `dom-snapshot.fieldFactsOf` reported `disabled: el.disabled || null`, which collapses `false` to `null`;
// `mergeSnapshot` skips null, so "this control is operable right now" was UNREPRESENTABLE and the
// graph-store fix alone is inert. Reverting the boolean is therefore a silent re-break of the whole
// change, which is exactly what this test exists to catch. It drives the REAL path (snapshotDom →
// mergeSnapshot via snapshotStep), not a hand-built element.
//
// Guards:
//   - a field observed `disabled:true` at baseline reads `disabled:false` after its precondition is met,
//     through the real snapshot path, and the transition is recorded in node.fieldStateHistory;
//   - the field's DECLARATION (`maxLength:50`) is identical in both states — the flip does not disturb it;
//   - ZERO identity churn across the flip on a REAL page: the ledger's id map is byte-identical before and
//     after, so the transient reading never reached templateSelector / instanceKey (the INC.4 failure mode).
// FAIL-ON-REVERT: restore `disabled: el.disabled || null` in lib/graph/dom-snapshot.mjs → the enabled
//   reading is null → the merge skips it → the latched `true` stands → "must be re-read as ENABLED" reds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/disabled-app/server.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { waitSettled } from '../../lib/browser/causal.mjs';
import { snapshotStep } from '../../lib/recon/step.mjs';
import { makeGraph, fieldStateCleared } from '../../lib/graph/graph-store.mjs';
import { makeLedger } from '../../lib/graph/ids.mjs';

const fieldNode = (graph) => {
  const node = Object.values(graph.elements).find((n) => n.fieldFacts && n.fieldFacts.placeholder === 'Group Name');
  assert.ok(node, 'the Group Name field must be discovered by the snapshot');
  return node;
};

test('a disabled field is re-read as enabled once its precondition is met, with no identity churn', async (t) => {
  const server = await start(0);
  const port = server.address().port;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-fieldstate-'));
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
  await gotoGated(page, `http://127.0.0.1:${port}/`);
  await waitSettled(page);

  // BASELINE: the field is disabled until the box is ticked — the state that used to latch forever.
  await snapshotStep(page, graph, ledger, '/');
  const before = fieldNode(graph);
  assert.equal(before.fieldFacts.disabled, true, 'the field is captured DISABLED at baseline (non-vacuous)');
  assert.equal(before.fieldFacts.maxLength, 50, 'its declared limit is captured alongside the state');
  assert.equal(fieldStateCleared(before), false, 'the precondition has not been met yet');
  const idsBefore = JSON.parse(JSON.stringify(ledger.ids));

  // The precondition is met. A plain page click, not a measured act: this test is about the READING, and
  // opening a causal window here would put the fixture's own setup inside the attribution path.
  await page.click('#agree');
  await waitSettled(page);

  // SECOND SNAPSHOT through the same real path.
  await snapshotStep(page, graph, ledger, '/');
  const after = fieldNode(graph);
  assert.equal(after.fieldFacts.disabled, false, 'the field must be re-read as ENABLED — a state is not a declaration');
  assert.deepEqual(after.fieldStateHistory.disabled.values, [true, false], 'the transition is recorded, not silently overwritten');
  assert.equal(fieldStateCleared(after), true, 'the precondition now reads as met');

  // The DECLARATION did not move with the state.
  assert.equal(after.fieldFacts.maxLength, 50, 'the declared limit is unchanged by the state flip');

  // IDENTITY: the flip must not have re-keyed anything. Same template, same instance, same ids.
  assert.equal(after.templateId, before.templateId, 'the field kept its template id across the flip');
  assert.deepEqual(ledger.ids, idsBefore, 'the id ledger is unchanged — no transient reading reached identity');
  assert.equal(after.instances.length, 1, 'the field is still ONE instance, not one per state');
});
