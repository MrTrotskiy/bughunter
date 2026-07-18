// REVEAL RECENCY ordering (INC.6c) — the just-opened modal must be drained before the page under it.
//
// Three iterations of this one bug, each measured on a live run, and each fix exposing the next:
//   1. Candidates were handed out in ascending templateId order. Freshly revealed controls get the
//      HIGHEST ids, so a modal's contents were always LAST. 0 of 46 revealing acts drained their own
//      revelation.
//   2. Marking "revealed by the last act" fixed that, but a single non-revealing act (clicking a field
//      reveals nothing) wiped the set, so the walk lost the modal mid-drain and then closed it.
//   3. Accumulating instead of overwriting fixed THAT — and broke the ordering, which is what this test
//      guards. A nav-like act reveals a whole page (52 controls, measured); after it, EVERYTHING is
//      "revealed", the boolean orders nothing, `sort` is stable, and the walk falls straight back to
//      ascending id. The modal was abandoned exactly as in step 1.
// So recency, not a flag: the 11 controls a modal just mounted must outrank the 52 the navigation before
// it uncovered, while the record still survives a non-revealing act.
//
// Guards: pickLive orders by WHEN a control was revealed (most recent first), with dismiss controls last.
// FAIL-ON-REVERT: make the comparator use a boolean again (`justRevealed.has(...) ? 0 : 1` with no
//   recency tie-break) → the walk picks the low-id page control → "the modal's control must be acted
//   before the page control revealed earlier" fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { statefulLoop } from '../../lib/recon/stateful-loop.mjs';
import { makeGraph, mergeSnapshot } from '../../lib/graph/graph-store.mjs';

// A handle that is always resolvable and visible — resolution is not what this test is about.
const handle = { isVisible: async () => true, evaluate: async () => true };
const fakePage = { url: () => 'https://x.test/dash', $: async () => handle, $$: async () => [handle] };

function elem(templateSelector, name, role = 'button') {
  return { templateSelector, instanceKey: "#1", instanceSelector: templateSelector, name, role, visible: true, locator: null };
}

test('a just-opened modal is drained before the page revealed by the navigation before it', async () => {
  const graph = makeGraph();
  // Baseline: the nav control we will "click" first.
  mergeSnapshot(graph, '/dash', [{ ...elem('main > button.nav', 'My Profile'), templateId: 1, instanceId: 1 }]);

  // 52 page controls uncovered by the nav act (LOW ids), then 2 modal controls (HIGH ids) —
  // the live shape: ids ascend with discovery, so the modal always sorts last by id.
  const pageControls = [];
  for (let i = 0; i < 52; i++) {
    pageControls.push({ ...elem(`section > button.p${i}`, `Page ${i}`), templateId: 10 + i, instanceId: 10 + i });
  }
  const modalSubmit = { ...elem('div.modal-footer > button.primary', 'Create Event'), templateId: 900, instanceId: 900 };
  const modalCancel = { ...elem('div.modal-footer > button.default', 'Cancel'), templateId: 901, instanceId: 901 };
  mergeSnapshot(graph, '/dash', [...pageControls, modalSubmit, modalCancel]);

  const acted = [];
  // The injected step: acting the nav control "reveals" the 52 page controls; acting a page control
  // reveals the modal's two. Everything else reveals nothing.
  const step = async (_g, target) => {
    acted.push(target.templateId);
    if (target.templateId === 1) return { newElements: pageControls.map((e) => ({ templateId: e.templateId })), requests: [], route: '/dash' };
    if (target.templateId === 10) return { newElements: [{ templateId: 900 }, { templateId: 901 }], requests: [], route: '/dash' };
    return { newElements: [], requests: [], route: '/dash' };
  };

  await statefulLoop(graph, { page: fakePage, origin: 'https://x.test', ledger: {}, step, budget: { steps: 4 } });

  assert.equal(acted[0], 1, 'the nav control is acted first (only resolvable candidate ordering aside)');
  assert.equal(acted[1], 10, 'then a page control — the 52 the nav revealed');
  // THE ASSERTION. After act #2 mounted the modal, the next pick must be the modal's own control, not
  // "Page 1" (id 11) which is equally "revealed" but was revealed EARLIER.
  assert.equal(acted[2], 900,
    'the modal\'s control must be acted before the page control revealed earlier — recency, not a flag');
  // And the dismiss goes last, never ahead of the submit it would close.
  assert.ok(!acted.slice(0, 3).includes(901), 'Cancel must not be acted before the modal is drained');
});
