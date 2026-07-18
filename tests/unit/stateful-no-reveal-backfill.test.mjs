// STATEFUL MODE WRITES NO REVEAL BACKFILL (INC.6d) — the poisoned-path writer that survived its own cleanup.
//
// A reveal path is a COLD-REPLAY artifact: re-navigate, replay the opener clicks, act. The stateful walk
// never replays — it acts in place on an already-open modal — and reveal-replay REFUSES a stateful path
// outright (REVEAL_PROVENANCE_ONLY), because an in-session breadcrumb is an over-approximation of every act
// since the last nav, not a route. The schemaVersion 5→6 bump was made to invalidate 494 such unwalkable
// paths; the backfill that MINTS them stayed switched on and had already written 250 more, 173 of them onto
// controls that were never hidden in the first place.
//
// The second, worse effect is a live loop. `fillRevealIfHidden` clears `explored` and deletes `unreachable`
// so a genuinely-uncovered panel control can re-enter the frontier. In stateful mode `preVisible` is a
// VISIBILITY set, and a control sitting under an open modal reads as not-visible — so when the modal closed,
// a control that had just FAILED its act (marked explored+unreachable by an intercepted click) was read as
// "revealed by this act", had its failure flags wiped, was re-ranked as freshly revealed, and was picked
// again to fail identically. Measured live: tpl 25 "Create Event" at seq 34 and seq 44, the same
// `ant-modal-wrap … intercepts pointer events` both times.
//
// Guards: in stateful mode the backfill is inert — it neither mints an unwalkable path nor resurrects a
//   failed act; the stateless panel-reach backfill it exists for is untouched.
// FAIL-ON-REVERT: delete `if (stateful) return false;` from fillRevealIfHidden (graph-store.mjs) → the
//   failed instance is resurrected and stamped → "a failed act must NOT be resurrected by a stateful
//   backfill" fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGraph, mergeSnapshot } from '../../lib/graph/graph-store.mjs';

// A base-page control, visible at baseline — it needs no reveal path to be reached, and never did.
const baseEl = () => ({
  templateId: 25, templateSelector: 'main > button.primary', role: 'button', name: 'Create Event',
  instanceId: 250, instanceKey: '#1', instanceSelector: 'main > button.primary', visible: true,
});
const openerHop = { templateId: 35, instanceKey: '#1' };

// The state an intercepted click leaves behind: the act ran, it failed, the instance is drained-unreachable.
function failTheAct(graph) {
  const inst = graph.elements[25].instances.find((i) => i.instanceKey === '#1');
  inst.explored = true;
  inst.unreachable = 'elementHandle.click: Timeout 5000ms exceeded — intercepts pointer events';
  return inst;
}

test('a failed act is NOT resurrected by a stateful backfill, and no unwalkable path is minted', () => {
  const graph = makeGraph();
  mergeSnapshot(graph, '/dashboard', [baseEl()]);
  failTheAct(graph);

  // A later stateful act closes the modal that was covering it. preVisible (captured while the modal was up)
  // does NOT contain the control, so the old code read this as "revealed by this act".
  mergeSnapshot(graph, '/dashboard', [baseEl()], {
    revealPath: [openerHop], stateful: true, preVisible: new Set(['div.other::x1']),
  });

  const inst = graph.elements[25].instances.find((i) => i.instanceKey === '#1');
  assert.equal(inst.explored, true,
    'a failed act must NOT be resurrected by a stateful backfill — it was picked again and failed identically');
  assert.ok(inst.unreachable, 'and its honest unreachable verdict must survive, not be silently deleted');
  assert.ok(!inst.reveal,
    'no reveal path is minted in stateful mode — reveal-replay refuses a stateful path, so it could never be walked');
});

test('the stateless panel-reach backfill is untouched (the fix is mode-scoped, not a blanket disable)', () => {
  const graph = makeGraph();
  // The genuine panel-reach class: captured HIDDEN at baseline, drained NOT_VISIBLE, then uncovered by a
  // "…more" opener. This must still reopen — it is real coverage the crawl would otherwise lose.
  mergeSnapshot(graph, '/dashboard', [{ ...baseEl(), visible: false }]);
  const inst0 = graph.elements[25].instances.find((i) => i.instanceKey === '#1');
  inst0.explored = true;
  inst0.unreachable = 'NOT_VISIBLE';

  mergeSnapshot(graph, '/dashboard', [baseEl()], {
    revealPath: [openerHop], preVisible: new Set(['div.other::x1']),   // no `stateful` → the cold path
  });

  const inst = graph.elements[25].instances.find((i) => i.instanceKey === '#1');
  assert.ok(inst.reveal, 'a stateless opener still backfills a reveal path (panel reach preserved)');
  assert.deepEqual(inst.reveal.statePath, [openerHop], 'and it ends at the opener that uncovered it');
  assert.equal(inst.explored, false, 'and the control is reopened for the frontier');
  assert.ok(!inst.unreachable, 'its NOT_VISIBLE verdict is correctly cleared — it is reachable now');
});
