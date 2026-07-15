// Unit proof for the GAP 2 stay-on-page ANNOTATION: mergeSnapshot stamps node.reveal on
// NEWLY-created templates when given a revealPath, first-reveal-path-wins, and — the load-
// bearing property — the annotation adds ZERO identity churn (it is a separate addressing
// dimension, never an identity key). Also: frontier.nextBatch carries the reveal field.
//
// Guards:
//   (A) mergeSnapshot({revealPath}) stamps node.reveal on a NEW template only; an already-
//       existing template is never re-stamped (first-reveal-path-wins, graph-store's if(!node)).
//   (B) ZERO CHURN: feeding the SAME elements once WITHOUT and once WITH a revealPath mints
//       IDENTICAL template/instance ids (the ledger key->id map is byte-equal), and
//       diffIdentity over the two runs reports ok:true (no churned/dropped identity).
//   (C) frontier.nextBatch emits `reveal` per item (node.reveal, else null).
// FAIL-ON-REVERT:
//   (A) drop the `if (opts.revealPath) node.reveal = ...` line in graph-store.mjs → node.reveal
//       is undefined → "the revealed template carries its reveal path" goes red.
//   (B) fold revealPath into the identity key (e.g. idify keying on it, or mergeSnapshot
//       minting a new id when revealPath differs) → the two ledgers diverge and diffIdentity
//       reports churn → the deepEqual(ledger maps) + ok:true assertions go red.
//   (C) drop `reveal: node.reveal || null` in frontier.nextBatch → the batch item has no
//       `reveal` key → the deepEqual on the emitted item goes red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGraph, mergeSnapshot } from '../../lib/graph/graph-store.mjs';
import { makeLedger } from '../../lib/graph/ids.mjs';
import { idify } from '../../lib/recon/step.mjs';
import { nextBatch } from '../../lib/recon/frontier.mjs';
import { diffIdentity } from '../../lib/graph/identity-diff.mjs';

// Raw element descriptors (as dom-snapshot would emit, before ids are minted). Two controls:
// an opener ('Open') that lives on the initial page, and a modal control ('Save') revealed by
// clicking Open. idify mints ids into a fresh clone each run so runs never share state.
function els() {
  return [
    { templateSelector: '#open', role: 'button', name: 'Open', instanceKey: '#1', instanceSelector: '#open' },
    { templateSelector: '#save', role: 'button', name: 'Save', instanceKey: '#1', instanceSelector: '#save' },
  ];
}
const REVEAL_PATH = [{ templateId: 2, instanceKey: '#1' }]; // an illustrative Open-first path

// --- (A) stamping + first-reveal-path-wins -----------------------------------------------

test('mergeSnapshot stamps node.reveal on a NEW template when given a revealPath', () => {
  const g = makeGraph();
  const ledger = makeLedger();
  const e = idify(ledger, els());
  mergeSnapshot(g, '/', e, { revealPath: REVEAL_PATH });
  const save = Object.values(g.elements).find((n) => n.name === 'Save');
  assert.ok(save, 'the Save template was merged');
  assert.deepEqual(save.reveal, { route: '/', statePath: REVEAL_PATH }, 'the revealed template carries its reveal path');
});

test('a revealPath is NOT written onto an already-existing template (first-reveal-path-wins)', () => {
  const g = makeGraph();
  const ledger = makeLedger();
  // First merge WITHOUT a revealPath — the templates are created reveal-free.
  mergeSnapshot(g, '/', idify(ledger, els()));
  // A later merge WITH a revealPath must NOT re-stamp the existing nodes.
  mergeSnapshot(g, '/', idify(ledger, els()), { revealPath: REVEAL_PATH });
  const save = Object.values(g.elements).find((n) => n.name === 'Save');
  assert.equal(save.reveal, undefined, 'an existing template is never re-stamped with a reveal path');
});

test('mergeSnapshot without a revealPath leaves node.reveal absent (additive field)', () => {
  const g = makeGraph();
  const ledger = makeLedger();
  mergeSnapshot(g, '/', idify(ledger, els()));
  for (const n of Object.values(g.elements)) assert.equal(n.reveal, undefined, 'no reveal without a revealPath');
});

// --- (B) ZERO identity churn -------------------------------------------------------------

test('the reveal annotation adds ZERO identity churn (ledger maps identical; diffIdentity ok)', () => {
  // Run 1: merge the elements WITHOUT a revealPath.
  const gA = makeGraph();
  const ledgerA = makeLedger();
  mergeSnapshot(gA, '/', idify(ledgerA, els()));
  // Run 2: merge the SAME elements WITH a revealPath.
  const gB = makeGraph();
  const ledgerB = makeLedger();
  mergeSnapshot(gB, '/', idify(ledgerB, els()), { revealPath: REVEAL_PATH });

  // The append-only ledger keys on the selector strings ONLY — revealPath must never enter it,
  // so the two key->id maps are byte-identical (the reveal path did not churn any id).
  assert.deepEqual(ledgerB.ids, ledgerA.ids, 'template/instance ids are identical with and without a revealPath');

  // The just-built churn probe agrees: no churned templates/instances, no dropped edges.
  const d = diffIdentity({ ledger: ledgerA, graph: gA }, { ledger: ledgerB, graph: gB });
  assert.equal(d.ok, true, 'identity-diff reports ok (no churn) across the two runs');
  assert.deepEqual(d.churnedTemplates, [], 'no template ids churned');
  assert.deepEqual(d.churnedInstances, [], 'no instance ids churned');
  assert.deepEqual(d.droppedEdges, [], 'no edges dropped');
});

// --- (C) frontier carries the reveal field -----------------------------------------------

test('frontier.nextBatch emits reveal per item (node.reveal, else null)', () => {
  const g = makeGraph();
  const ledger = makeLedger();
  const all = idify(ledger, els());
  // Open is a baseline (directly-reachable) control — merged with NO revealPath.
  mergeSnapshot(g, '/', [all[0]]);
  // Save is revealed by Open — merged WITH the reveal path.
  mergeSnapshot(g, '/', [all[1]], { revealPath: REVEAL_PATH });
  const batch = nextBatch(g, { size: 5 });
  const save = batch.find((b) => b.name === 'Save');
  const open = batch.find((b) => b.name === 'Open');
  assert.deepEqual(save.reveal, { route: '/', statePath: REVEAL_PATH }, 'the reveal path rides the emitted batch item');
  assert.equal(open.reveal, null, 'a directly-reachable control emits reveal:null');
});
