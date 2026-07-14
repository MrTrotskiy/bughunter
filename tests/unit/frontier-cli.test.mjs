// frontier-cli — the recon agent's "what to study next" tool. Pure graph read, no
// browser: it must surface the honest denominator and never hand the agent more than
// the receptive-field ceiling (2-5 elements), whatever --size is asked for.
//
// Guards: (1) the emitted denominator does not collapse — discovered stays constant as
//   templates are explored (honest coverage through the tool boundary); (2) the batch
//   is capped at the receptive-field ceiling so a bad --size can't blow the agent's
//   context (the founding failure of bughunt-agents).
// FAIL-ON-REVERT: drop the `Math.min(size, MAX_SIZE)` clamp in frontier-cli.mjs → a
//   --size=50 request returns the whole frontier → "batch exceeded receptive-field
//   ceiling".

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeGraph, mergeSnapshot, markExplored, saveGraph } from '../../lib/graph/graph-store.mjs';
import { emit } from '../../lib/recon/frontier-cli.mjs';

function withStateDir(t, n) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bughunter-fcli-'));
  const prev = process.env.BUGHUNTER_STATE_DIR;
  process.env.BUGHUNTER_STATE_DIR = dir;
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prev;
  });
  const g = makeGraph();
  const els = [];
  for (let i = 1; i <= n; i++) {
    els.push({
      templateId: i, instanceId: i * 100, templateSelector: `button.b${i}`,
      role: 'button', name: `B${i}`, instanceKey: `#${i}`, instanceSelector: `button.b${i}:nth-child(${i})`,
    });
  }
  mergeSnapshot(g, '/', els);
  return { dir, g, graphPath: path.join(dir, 'graph.json') };
}

test('emitted denominator does not collapse as templates are explored', (t) => {
  const { g, graphPath } = withStateDir(t, 3);
  saveGraph(graphPath, g);
  assert.deepEqual(emit().stats, { discovered: 3, explored: 0, unreachable: 0, remaining: 3 });

  markExplored(g, 1);
  markExplored(g, 2);
  saveGraph(graphPath, g);
  assert.deepEqual(emit().stats, { discovered: 3, explored: 2, unreachable: 0, remaining: 1 }, 'discovered must not shrink');
});

test('batch is capped at the receptive-field ceiling regardless of --size', (t) => {
  const { g, graphPath } = withStateDir(t, 8);
  saveGraph(graphPath, g);
  const batch = emit({ size: 50 }).batch;
  assert.ok(batch.length <= 5, `batch exceeded receptive-field ceiling: ${batch.length}`);
});
