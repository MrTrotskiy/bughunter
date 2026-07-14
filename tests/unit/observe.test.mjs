// observe — the recon agent's semantic writer and the ONLY thing that flips `explored`
// in the agent path. Runs entirely without a browser over a temp BUGHUNTER_STATE_DIR.
//
// Guards: (1) an observed template LEAVES the frontier (explored ⟺ observed → forward
//   progress, no infinite re-hand-out); (2) the destructive backstop REFUSES an ACTED
//   observation on a Delete/Logout/Pay control (a mis-judging agent cannot fire it),
//   while still allowing it to be recorded as NOT acted; (3) a value-less --template
//   flag is rejected, not silently written to templateId 1; (4) --state-change=false is
//   stored as false, not coerced to true.
// FAIL-ON-REVERT: drop the DANGER_FLOOR refusal → an ACTED observation on "Delete" is
//   accepted → assert.throws fails "acting on a Delete control must be refused". Also:
//   drop markExplored → "observed template still in the frontier"; revert the boolean
//   --template reject → observe({template:true}) writes template 1 instead of throwing
//   USAGE; revert `=== 'true'` to `!!` → --state-change=false becomes true.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeGraph, mergeSnapshot, saveGraph, loadGraph } from '../../lib/graph/graph-store.mjs';
import { observe } from '../../lib/recon/observe.mjs';
import { emit } from '../../lib/recon/frontier-cli.mjs';

function withState(t, els) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bughunter-obs-'));
  const prev = process.env.BUGHUNTER_STATE_DIR;
  process.env.BUGHUNTER_STATE_DIR = dir;
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prev;
  });
  const g = makeGraph();
  mergeSnapshot(g, '/', els);
  saveGraph(path.join(dir, 'graph.json'), g);
  return { dir, graphPath: path.join(dir, 'graph.json') };
}

const searchEl = {
  templateId: 3, instanceId: 4, templateSelector: 'button#search', role: 'button',
  name: 'Search', instanceKey: '#1', instanceSelector: 'button#search',
};
const deleteEl = {
  templateId: 5, instanceId: 6, templateSelector: 'button.del', role: 'button',
  name: 'Delete', instanceKey: '#1', instanceSelector: 'button.del:nth-child(1)',
};
const firstEl = {
  templateId: 1, instanceId: 10, templateSelector: 'button.first', role: 'button',
  name: 'First', instanceKey: '#1', instanceSelector: 'button.first:nth-child(1)',
};

test('observe records semantics, marks explored, and drains the template from the frontier', (t) => {
  const { graphPath } = withState(t, [searchEl]);
  assert.deepEqual(emit().batch.map((b) => b.templateId), [3], 'Search is in the frontier before observing');

  const res = observe({ template: 3, purpose: 'runs a search', danger: 'safe', effect: 'reveal' });
  assert.equal(res.explored, true);

  const g = loadGraph(graphPath);
  assert.equal(g.elements[3].semantics.effect, 'reveal');
  assert.equal(g.elements[3].explored, true);
  assert.deepEqual(emit().batch.map((b) => b.templateId), [], 'observed template still in the frontier');
});

test('destructive backstop refuses an ACTED observation on a Delete control', (t) => {
  withState(t, [deleteEl]);
  assert.throws(
    () => observe({ template: 5, purpose: 'deletes a row', danger: 'destructive', effect: 'none', acted: 'true' }),
    (err) => err.code === 'DANGER_FLOOR',
    'acting on a Delete control must be refused by the danger floor',
  );
  // Recording it as NOT acted is allowed and still drains the frontier.
  const ok = observe({ template: 5, purpose: 'deletes a row', danger: 'destructive', effect: 'none', acted: 'false' });
  assert.equal(ok.explored, true);
});

test('a bare --template flag (boolean true) is rejected, not written to template 1', (t) => {
  withState(t, [firstEl]); // template 1 EXISTS — a reverted guard would silently corrupt it
  assert.throws(
    () => observe({ template: true, purpose: 'x', danger: 'safe', effect: 'none' }),
    (err) => err.code === 'USAGE',
    'a value-less --template must be a USAGE error, never coerced to templateId 1',
  );
});

test('--state-change=false is recorded as false, not coerced to true', (t) => {
  const { graphPath } = withState(t, [searchEl]);
  observe({ template: 3, purpose: 'runs a search', danger: 'safe', effect: 'reveal', stateChange: 'false' });
  const g = loadGraph(graphPath);
  assert.equal(g.elements[3].semantics.stateChange, false, "the string 'false' must not become true");
});
