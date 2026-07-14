// recon-loop — Phase-1 loop-driver control-flow. Pure: the step primitive (browser)
// and the judge are injected, so this asserts ONLY orchestration — frontier draining,
// explored-marking (no re-clicks), unreachable accounting, judge-filter draining, the
// step-budget cap (incl. a malformed budget), incremental persistence, and picking up
// templates a step reveals.
//
// Guards + FAIL-ON-REVERT (one per mechanism in reconLoop):
//   - markExplored (no re-clicks / terminates) — revert → "template acted twice: 1".
//   - markUnreachable on a step error (honest coverage) — revert → stats show
//     explored:2 unreachable:0 instead of explored:0 unreachable:2.
//   - drain the judge-dismissed items (no starvation) — revert → a filtering judge
//     never drains; stopped:'budget', remaining > 0.
//   - Number.isFinite budget clamp — revert to `?? Infinity` → a NaN budget does zero
//     work yet falsely reports 'frontier-drained'; explored stays 0.
//   - onStep per step — remove the call → the persistence hook never fires.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGraph, mergeSnapshot } from '../../lib/graph/graph-store.mjs';
import { reconLoop } from '../../lib/recon/recon-loop.mjs';

function seed(n) {
  const g = makeGraph();
  const els = [];
  for (let i = 1; i <= n; i++) {
    els.push({
      templateId: i,
      instanceId: i * 100,
      templateSelector: `button.b${i}`,
      role: 'button',
      name: `B${i}`,
      instanceKey: `#${i}`,
      instanceSelector: `button.b${i}:nth-child(${i})`,
    });
  }
  mergeSnapshot(g, '/', els);
  return g;
}

const actedIds = (res) => res.steps.flat().map((a) => a.templateId);

// A step that does nothing to the graph — pure frontier drain.
const inertStep = async () => ({ requests: [] });

// A step that throws — simulates a control a cold-start reload cannot reach.
const throwingStep = async () => { throw new Error('NO_INSTANCE'); };

test('drains a static frontier, each template acted exactly once', async () => {
  const g = seed(3);
  const res = await reconLoop(g, { step: inertStep });
  const ids = actedIds(res).sort((a, b) => a - b);
  assert.deepEqual(ids, [1, 2, 3]);
  assert.equal(res.stopped, 'frontier-drained');
  assert.deepEqual(res.stats, { discovered: 3, explored: 3, unreachable: 0, remaining: 0 });
});

test('no template is acted twice across the run', async () => {
  const g = seed(6);
  // Budget-bounded so a broken explored-mark re-acts templates and fails cleanly here
  // (with a useful message) instead of looping forever.
  const res = await reconLoop(g, { step: inertStep, size: 2, budget: { steps: 20 } });
  const ids = actedIds(res);
  const seen = new Set();
  for (const id of ids) {
    assert.ok(!seen.has(id), `template acted twice: ${id}`);
    seen.add(id);
  }
});

test('step-budget caps the number of receptive-field steps', async () => {
  const g = seed(10);
  const res = await reconLoop(g, { step: inertStep, size: 2, budget: { steps: 2 } });
  assert.equal(res.steps.length, 2);
  assert.equal(actedIds(res).length, 4); // 2 steps x width 2
  assert.equal(res.stopped, 'budget');
  assert.equal(res.stats.explored, 4);
  assert.equal(res.stats.remaining, 6); // untouched templates stay in the denominator
});

test('templates a step reveals enter the frontier and get explored', async () => {
  const g = seed(1);
  // Acting on template 1 reveals a new template 99 (a row the action rendered).
  const revealingStep = async (graph, target) => {
    if (target.templateId === 1) {
      mergeSnapshot(graph, '/', [{
        templateId: 99, instanceId: 9900, templateSelector: 'button.edit',
        role: 'button', name: 'Edit', instanceKey: 'row:7', instanceSelector: 'li[data-id="7"] button.edit',
      }]);
    }
    return { newElements: [] };
  };
  const res = await reconLoop(g, { step: revealingStep });
  assert.deepEqual(actedIds(res).sort((a, b) => a - b), [1, 99]);
  assert.equal(res.stats.discovered, 2);
  assert.equal(res.stats.explored, 2);
});

test('an errored step marks the template unreachable, not genuine coverage', async () => {
  const g = seed(2);
  const res = await reconLoop(g, { step: throwingStep });
  assert.equal(res.stopped, 'frontier-drained'); // still drains → terminates
  assert.deepEqual(res.stats, { discovered: 2, explored: 0, unreachable: 2, remaining: 0 });
  assert.ok(res.steps.flat().every((a) => a.error), 'each errored step surfaces its error, not swallowed');
});

test('a judge that filters the batch does not starve the frontier', async () => {
  const g = seed(4);
  // Drops the first item every step. Without draining dismissed items this re-offers
  // template 1 forever; budget-bounded so the bug fails fast instead of hanging.
  const dropFirst = (batch) => batch.slice(1);
  const res = await reconLoop(g, { step: inertStep, judge: dropFirst, budget: { steps: 20 } });
  assert.equal(res.stopped, 'frontier-drained', 'the frontier must drain even under a filtering judge');
  assert.equal(res.stats.remaining, 0);
});

test('a non-finite step-budget is treated as unbounded, not a no-op success', async () => {
  const g = seed(3);
  // budget.steps = NaN (e.g. Number("abc")). `?? Infinity` missed NaN, so `0 < NaN`
  // short-circuited the loop and it falsely reported 'frontier-drained' having done nothing.
  const res = await reconLoop(g, { step: inertStep, budget: { steps: NaN } });
  assert.equal(res.stats.explored, 3, 'NaN budget must still do the work, not silently skip it');
  assert.equal(res.stopped, 'frontier-drained');
});

test('onStep runs once per step for incremental persistence', async () => {
  const g = seed(3);
  let calls = 0;
  await reconLoop(g, { step: inertStep, size: 1, onStep: () => { calls += 1; } });
  assert.equal(calls, 3, 'one persistence hook per receptive-field step');
});
