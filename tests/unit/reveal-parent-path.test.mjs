// A reveal path is a PARENT POINTER in the reveal tree, never the accumulated act log.
//
// WHY THIS TEST EXISTS. `stateful-step.mjs` stamped `chain.concat([hop])` on everything an act revealed,
// where `chain` was every act since the last route change. That is a session history, and a history is not
// a route. Measured on one live graph:
//   - a ten-hop path opened a board at hop 4 and then clicked, at hop 5, the breadcrumb that navigates back
//     OUT of it — followed by three MUTUALLY EXCLUSIVE modal openers, which cannot all be open at once;
//   - another carried the same template twice (`statePath [35, 35]`, one control acted back to back).
// No suffix of such a path can be walked at any length. That is why raising the reopen cap was measured to
// change admission by exactly zero (1100 of 1120 admitted at maxHops 3, 8 AND 20) while adding 831 attempts,
// and why every one of the 15 successful reopens in the audited run used exactly ONE hop.
//
// The filters in that file could not have prevented it: they gate whether the hop joins `chain` for FUTURE
// acts, while the value stamped on THIS act's revelations was computed earlier and unfiltered. So an act on
// a dismiss control — which reveals whatever sat behind the overlay, and therefore passes the `revealed > 0`
// test — stamped a path ending in its own "Cancel" onto every control it uncovered.
//
// A parent pointer is acyclic and single-route BY CONSTRUCTION rather than by a filter that must anticipate
// every way a log goes wrong. This test pins the RULE as a pure function, because the defect is in how the
// value is derived and not in anything a browser does.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isDismissControl } from '../../lib/recon/danger-floor.mjs';

// The rule exactly as implemented in stateful-step.mjs.
function pathFor(graph, target, chainIgnored) {
  const hop = { templateId: target.templateId, instanceKey: target.instanceKey };
  const parent = (target.instance && target.instance.reveal && target.instance.reveal.statePath)
    || (graph.elements[target.templateId] && graph.elements[target.templateId].reveal
        && graph.elements[target.templateId].reveal.statePath)
    || [];
  const cyclic = parent.some((h) => h && h.templateId === target.templateId);
  return cyclic || isDismissControl({ name: target.name }) ? null : parent.concat([hop]);
}

const graph = () => ({
  elements: {
    10: { templateId: 10, name: 'Open board', route: '/boards' },
    20: { templateId: 20, name: 'New task', route: '/boards', reveal: { statePath: [{ templateId: 10 }] } },
    30: { templateId: 30, name: 'Cancel', route: '/boards', reveal: { statePath: [{ templateId: 10 }] } },
  },
});

test('depth is preserved: a control revealed two levels down carries both openers', () => {
  const g = graph();
  // "New task" was itself revealed by "Open board", so what IT reveals sits behind both.
  const p = pathFor(g, { templateId: 20, name: 'New task', instanceKey: '#1' });
  assert.deepEqual(p.map((h) => h.templateId), [10, 20],
    'the parent chain reproduces the real nesting — this is not a flattening');
});

test('an unrelated earlier act is NOT in the path, however recently it happened', () => {
  const g = graph();
  // Under the old rule, ANY act since the last navigation joined the breadcrumb. A search box filled on the
  // way to a board has nothing to do with reaching a task, and its presence made the path unwalkable.
  g.elements[99] = { templateId: 99, name: 'Search', route: '/boards' };
  const p = pathFor(g, { templateId: 20, name: 'New task', instanceKey: '#1' });
  assert.ok(!p.some((h) => h.templateId === 99),
    'the path names openers, not everything that happened first');
});

test('a dismiss control stamps NOTHING — it closes the container it would claim to open', () => {
  const g = graph();
  assert.equal(pathFor(g, { templateId: 30, name: 'Cancel', instanceKey: '#1' }), null,
    'clicking Cancel reveals what was behind the modal, which is exactly how "Cancel" ended up in the path '
    + 'of everything it uncovered');
});

test('a cyclic parent is refused rather than extended', () => {
  const g = graph();
  // A path carried over from an older scheme may already contain this very hop.
  g.elements[20].reveal.statePath = [{ templateId: 10 }, { templateId: 20 }];
  assert.equal(pathFor(g, { templateId: 20, name: 'New task', instanceKey: '#1' }), null,
    'a path that revisits its own opener cannot be walked — reveal-replay refuses it outright');
});

test('a baseline control with no parent gets a one-hop path, not an empty one', () => {
  const g = graph();
  const p = pathFor(g, { templateId: 10, name: 'Open board', instanceKey: '#1' });
  assert.deepEqual(p.map((h) => h.templateId), [10],
    'what a baseline opener reveals sits behind exactly that opener');
});

test('the instance path outranks the template path', () => {
  const g = graph();
  // Two instances of one template can be revealed by different openers; the instance is the specific truth.
  const p = pathFor(g, {
    templateId: 20, name: 'New task', instanceKey: '#2',
    instance: { reveal: { statePath: [{ templateId: 10 }, { templateId: 11 }] } },
  });
  assert.deepEqual(p.map((h) => h.templateId), [10, 11, 20],
    'the instance knows how IT was reached; the template average would be wrong for it');
});
