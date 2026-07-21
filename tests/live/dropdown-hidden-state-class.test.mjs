// Guards: the `-hidden` VISIBILITY state suffix does NOT fragment a control's identity (schemaVersion 9).
// AntD toggles `ant-dropdown-hidden` on a dropdown wrapper, so a positional (id-less) button THROUGH that
// wrapper had two template selectors — `.ant-dropdown > … > button` and
// `.ant-dropdown.ant-dropdown-hidden > … > button` — and fragmented into two templates for one control
// (measured ALIAS_COLLISION 1092/1098↔1100/1108 on the live target). `dom-snapshot.isStateClass` now strips
// the `-hidden` suffix; the structural `ant-dropdown` anchor is KEPT. Visibility is already recorded in the
// additive, non-identity `visible` field, so it is not lost by dropping the class from the selector.
//
// FAIL-ON-REVERT: drop `|hidden` from the isStateClass suffix regex in dom-snapshot.mjs → the toggled-hidden
// wrapper mints a second template selector → "the control is ONE template across the -hidden flip (got 2)"
// reds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/dropdown-hidden-app/server.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { waitSettled } from '../../lib/browser/causal.mjs';
import { snapshotStep } from '../../lib/recon/step.mjs';
import { makeGraph } from '../../lib/graph/graph-store.mjs';
import { makeLedger } from '../../lib/graph/ids.mjs';

const isCopy = (n) => (n.role === 'button' || n.tag === 'button') && String(n.name || '').trim() === 'Copy link';

test('a transient -hidden visibility class does not fragment a control into two templates', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-dropdown-hidden-'));
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

  const before = Object.values(graph.elements).find(isCopy);
  assert.ok(before, 'the "Copy link" control was discovered before the -hidden flip');
  const templateBefore = before.templateId;

  await page.click('#toggle');
  await waitSettled(page);
  await snapshotStep(page, graph, ledger, '/');

  // NON-VACUITY: the -hidden class really is on the wrapper now.
  const hidden = await page.$eval('div.ant-dropdown', (el) => el.classList.contains('ant-dropdown-hidden'));
  assert.equal(hidden, true, 'the wrapper carries ant-dropdown-hidden after the toggle');

  const templates = new Set(Object.values(graph.elements).filter(isCopy).map((n) => n.templateId));
  assert.equal(templates.size, 1, `the control is ONE template across the -hidden flip (got ${templates.size})`);
  assert.ok(templates.has(templateBefore), 'the post-flip snapshot resolves to the SAME template, not a fresh one');
});
