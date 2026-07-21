// Guards: a TRANSIENT `-dragged`/`-dragging` (react-draggable) state suffix does NOT fragment a draggable
// control's identity. A button inside `div.react-draggable` keeps ONE template selector across the flip to
// `div.react-draggable.react-draggable-dragged` (what a real drag leaves behind), so the same control is not
// counted as two templates — the phantom-denominator + ALIAS_COLLISION class measured live (tpl 1066
// colliding onto tpl 41, same node, different post-drag class). The structural `react-draggable` base class
// is KEPT as the anchor; only the state suffix is stripped (dom-snapshot.isStateClass, INC.6 class).
//
// FAIL-ON-REVERT: drop `|dragged|dragging` from the isStateClass suffix regex in dom-snapshot.mjs → the
// dragged wrapper mints a SECOND template selector → the "Move me" button has 2 templates → "one template
// across the drag flip" reds (moveTemplates.length === 2).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { start } from '../fixtures/draggable-app/server.mjs';
import { launch, gotoGated, close } from '../../lib/browser/session.mjs';
import { waitSettled } from '../../lib/browser/causal.mjs';
import { snapshotStep } from '../../lib/recon/step.mjs';
import { makeGraph } from '../../lib/graph/graph-store.mjs';
import { makeLedger } from '../../lib/graph/ids.mjs';

const isMoveButton = (n) => (n.role === 'button' || n.tag === 'button') && String(n.name || '').trim() === 'Move me';

test('a transient -dragged state class does not fragment a draggable control into two templates', async (t) => {
  const server = await start(0);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-draggable-'));
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

  const before = Object.values(graph.elements).find(isMoveButton);
  assert.ok(before, 'the "Move me" button was discovered before the drag');
  const templateBefore = before.templateId;

  // Flip the wrapper to carry react-draggable-dragged, exactly as a real drag would.
  await page.click('#drag');
  await waitSettled(page);
  await snapshotStep(page, graph, ledger, '/');

  // NON-VACUITY: the dragged class really is on the wrapper now (the flip happened).
  const dragged = await page.$eval('div.react-draggable', (el) => el.classList.contains('react-draggable-dragged'));
  assert.equal(dragged, true, 'the wrapper carries react-draggable-dragged after the simulated drag');

  const moveTemplates = new Set(Object.values(graph.elements).filter(isMoveButton).map((n) => n.templateId));
  assert.equal(moveTemplates.size, 1, `the draggable control is ONE template across the drag flip (got ${moveTemplates.size})`);
  assert.ok(moveTemplates.has(templateBefore), 'the post-drag snapshot resolves to the SAME template, not a fresh one');
});
