// A REOPEN THAT DELIVERS NOTHING MUST NOT BE BOUGHT AGAIN — the wiring, not just the memo's arithmetic.
//
// MEASURED, run state/runs/hunt1, seq 491-521: eight consecutive `reopen{ok:true, code:REOPEN_OK, hops:1,
// rung:"in-place"}` on template 1290 instance #1, each immediately followed by `act.failed NO_INSTANCE`.
// The container genuinely reopened every time and the control genuinely was not inside it. `recoverGated`
// recorded `re.ok` — the relocation's verdict, taken before the act it exists to enable had run — so the
// memo filed eight successes, never memoized a failure, and `shouldAttempt` went on saying yes. The run's
// own census printed `{attempted:12, succeeded:10}`.
//
// relocation-memo.test.mjs guards the memo's semantics. THIS guards that the driver actually settles the
// entry with the act's outcome: a memo with the right rules and a caller that never closes the entry is
// exactly as wrong as before, and the census would then read `pending` instead of `succeeded` — a
// different lie, not a fix.
//
// NO BROWSER (layer rule): the reopen path is driven against a stub page. Every helper on it degrades as
// documented — `waitSettled` returns on its own evaluate, `settleAnimations` catches, `resetTrackerVerdicts`
// is a Map lookup, `inOwnableItem` reads the handle. The one seam that matters is real: the hop's click
// opens the container, the oracle then resolves the target, and `reopenContainer` returns REOPEN_OK.
//
// Guards: (a) a reopen whose act failed is never counted a success; (b) the driver does not re-buy that
//   same empty container; (c) a reopen whose act SUCCEEDS still counts, so the fix does not simply declare
//   every relocation a failure.
//
// FAIL-ON-REVERT: restore the single-phase call in `recoverGated`
//   (`relocMemo.record(target.templateId, keyOf(target), !!(re && re.ok), …)` with the return value
//   discarded, and no settle after `runAct`) → "the same empty container must not be re-bought" reds with
//   the target acted 12 times (the REOPEN_BUDGET), and "a reopen whose act failed is not a success" reds
//   with succeeded:12.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statefulLoop } from '../../lib/recon/stateful-loop.mjs';
import { makeGraph, mergeSnapshot } from '../../lib/graph/graph-store.mjs';

const OPENER = 'main > button.opener';
const TARGET = 'div.panel > input.combo';

// A live DOM whose panel really does open when the opener is clicked — the whole point of a reopen, and
// the reason hunt1's `reopen{ok:true}` was not a lie about the RELOCATION.
function makeStub() {
  const state = { panelOpen: false, opened: 0 };
  const handleFor = (sel) => ({
    isVisible: async () => true,
    // Answers `inOwnableItem` (false → ownership NONE) and the live-name read (falsy → the stored name).
    evaluate: async () => false,
    click: async () => { if (sel === OPENER) { state.panelOpen = true; state.opened++; } },
  });
  const page = {
    url: () => 'https://x.test/dash',
    $: async (sel) => {
      if (sel === TARGET) return state.panelOpen ? handleFor(sel) : null;
      if (sel === OPENER) return handleFor(sel);
      return null;
    },
    $$: async () => [],
    // Settled immediately, so waitSettled does not spend its 6s bound on a stub.
    evaluate: async () => ({ total: 1, inflight: 0 }),
    waitForTimeout: async () => {},
    keyboard: { press: async () => {} },
  };
  return { page, state };
}

function seedGraph() {
  const graph = makeGraph();
  const el = (templateId, instanceId, templateSelector, name, role) => ({
    templateId, instanceId, templateSelector, instanceSelector: templateSelector,
    instanceKey: '#1', name, role, visible: true, locator: null,
  });
  mergeSnapshot(graph, '/dash', [
    el(1, 1, OPENER, 'Open panel', 'button'),
    el(1290, 1290, TARGET, 'Select a group', 'combobox'),
  ]);
  // The target lives behind the opener and carries the breadcrumb back to itself — the recoverGated
  // precondition. A REPLAY path (not `stateful: true` provenance, which reopen-policy refuses by contract).
  graph.elements[1290].reveal = { route: '/dash', statePath: [{ templateId: 1, instanceKey: '#1' }] };
  // fieldFacts is what keeps a failed target in the frontier at all (`batteryOwing`), which is why hunt1
  // could ask template 1290 eight times rather than retiring it after the first failure.
  graph.elements[1290].fieldFacts = { kind: 'text', required: true };
  return graph;
}

// The injected step. The opener acts normally; the target's act fails NO_INSTANCE the way hunt1's did —
// the panel is open, and the control the breadcrumb promised is not in it.
function makeStep(state, acted, { targetFails = true } = {}) {
  return async (graph, target) => {
    acted.push(target.templateId);
    if (target.templateId !== 1290) return { newElements: [], requests: [], route: '/dash' };
    // recordProbe's row, written by the real step before it re-throws.
    (graph.elements[1290].probes || (graph.elements[1290].probes = []))
      .push({ instanceKey: '#1', kind: 'fill-valid', blocked: targetFails ? 'NO_INSTANCE' : null, verdict: targetFails ? null : 'read' });
    if (!targetFails) return { newElements: [], requests: [], route: '/dash' };
    state.panelOpen = false;               // the failed act left the container shut behind it
    const err = new Error('no live instance for template 1290');
    err.envelope = { code: 'NO_INSTANCE' };
    throw err;
  };
}

test('a reopen whose act failed is not a success, and the empty container is not re-bought', async () => {
  const { page, state } = makeStub();
  const graph = seedGraph();
  const acted = [];

  const res = await statefulLoop(graph, {
    page, origin: 'https://x.test', ledger: {}, step: makeStep(state, acted), budget: { steps: 30 },
  });

  // NON-VACUOUS: the recovery path really ran — the opener was clicked by the reopen walk, not by an act.
  assert.ok(state.opened >= 1, 'the reopen must genuinely have replayed the hop (non-vacuous)');
  assert.ok(acted.includes(1290), 'and the target must genuinely have been acted after it (non-vacuous)');

  assert.equal(
    acted.filter((t) => t === 1290).length, 1,
    'the same empty container must not be re-bought — hunt1 spent EIGHT reopen+act pairs on template 1290, every one of them ending NO_INSTANCE',
  );
  assert.equal(
    res.reloc.succeeded, 0,
    'a reopen whose act failed is not a success — hunt1 filed 8 of these as successes and reported a 83% success rate',
  );
  assert.equal(res.reloc.deliveredNothing, 1, 'it is counted in the bucket that names what happened');
  assert.equal(res.reloc.pending, 0, 'the entry is settled, not abandoned — a `pending` census is a different lie, not a fix');
});

test('a reopen whose act SUCCEEDS still counts — the fix does not just call every relocation a failure', async () => {
  // The over-correction direction. If `succeeded` could never be reached, the census would be as useless
  // as before and `shouldAttempt` would strand every container that legitimately needs re-entering.
  const { page, state } = makeStub();
  const graph = seedGraph();
  const acted = [];

  const res = await statefulLoop(graph, {
    page, origin: 'https://x.test', ledger: {}, step: makeStep(state, acted, { targetFails: false }), budget: { steps: 30 },
  });

  assert.ok(acted.includes(1290), 'the recovered target was acted');
  assert.equal(res.reloc.succeeded, 1, 'a relocation whose act resolved IS a success');
  assert.equal(res.reloc.deliveredNothing, 0);
  assert.equal(res.reloc.pending, 0);
});
