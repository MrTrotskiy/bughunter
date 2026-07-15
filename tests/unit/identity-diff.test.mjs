// identity-diff — the read-only churn GATE (lib/graph/identity-diff.mjs). Feeds SYNTHETIC
// before/after {ledger, graph} pairs, never a browser (pure fn → unit layer).
//
// Guards: the GAP 2 precondition gate — a change that RE-KEYS an existing template/instance
//   or DROPS a causal edge is reported (ok:false); pure-additive growth (new keys / new
//   edges) is NOT flagged (ok:true); a missing/empty before never throws.
// The three FAIL-ON-REVERT notes below each name a mechanism whose removal flips the gate
// silently green — the matching test then goes red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { diffIdentity, loadStrict } from '../../lib/graph/identity-diff.mjs';

const edge = (from, to, type = 'triggers') => ({ from, to, type, provenance: 'causal' });

// (a) Append-only: new tpl/inst keys added, every SHARED key keeps its id, no edge dropped.
// FAIL-ON-REVERT: drop the `hasOwnProperty(bIds, key)` shared-key guard in diffIdentity →
//   a NEW key is compared against undefined and mis-reported as churn → churnedTemplates is
//   non-empty here → this test goes red.
test('append-only growth is not churn (ok:true, nothing churned)', () => {
  const before = {
    ledger: { next: 3, ids: { 'tpl:button.a': 1, 'inst:button.a::0': 2 } },
    graph: { edges: [edge('element:1', 'request:GET /x')] },
  };
  const after = {
    ledger: { next: 5, ids: { 'tpl:button.a': 1, 'inst:button.a::0': 2, 'tpl:button.b': 3, 'inst:button.b::0': 4 } },
    graph: { edges: [edge('element:1', 'request:GET /x'), edge('element:3', 'request:POST /y')] },
  };
  const d = diffIdentity(before, after);
  assert.equal(d.ok, true, 'pure-additive change must be ok');
  assert.deepEqual(d.churnedTemplates, [], 'no template may churn');
  assert.deepEqual(d.churnedInstances, [], 'no instance may churn');
  assert.deepEqual(d.droppedEdges, [], 'no edge may drop');
  assert.equal(d.addedTemplates, 1, 'the new template counts as added');
  assert.equal(d.addedInstances, 1, 'the new instance counts as added');
  assert.equal(d.addedEdges, 1, 'the new edge counts as added');
});

// (b) A re-keyed template: SAME 'tpl:' key, DIFFERENT id (1 → 9) — the exact regression.
// FAIL-ON-REVERT: replace the `aIds[key] !== bIds[key]` id-inequality with a constant false
//   (or delete the churn push) → churnedTemplates stays [] → ok flips true → this test's
//   ok:false + key-present assertions go red.
test('a re-keyed template is churn (ok:false, key in churnedTemplates)', () => {
  const before = { ledger: { next: 3, ids: { 'tpl:button.a': 1, 'inst:button.a::0': 2 } }, graph: { edges: [] } };
  const after = { ledger: { next: 3, ids: { 'tpl:button.a': 9, 'inst:button.a::0': 2 } }, graph: { edges: [] } };
  const d = diffIdentity(before, after);
  assert.equal(d.ok, false, 'a re-keyed template must fail the gate');
  assert.deepEqual(d.churnedTemplates, [{ key: 'tpl:button.a', beforeId: 1, afterId: 9 }]);
  assert.deepEqual(d.churnedInstances, [], 'the untouched instance must not churn');
  assert.deepEqual(d.droppedEdges, []);
});

// (c) A dropped edge: a before triple absent from after (ledgers identical → no key churn).
// FAIL-ON-REVERT: neuter the dropped-edge loop (`if (!aKeys.has(k))` → never true) →
//   droppedEdges stays [] → ok flips true → this test's ok:false + non-empty droppedEdges
//   assertions go red.
test('a dropped edge is churn (ok:false, droppedEdges non-empty)', () => {
  const ids = { 'tpl:a': 1, 'inst:a::0': 2 };
  const before = { ledger: { next: 3, ids }, graph: { edges: [edge('element:1', 'request:GET /x'), edge('element:1', 'request:POST /y')] } };
  const after = { ledger: { next: 3, ids }, graph: { edges: [edge('element:1', 'request:GET /x')] } };
  const d = diffIdentity(before, after);
  assert.equal(d.ok, false, 'a dropped edge must fail the gate');
  assert.equal(d.droppedEdges.length, 1, 'exactly the removed edge is reported dropped');
  assert.deepEqual(d.droppedEdges[0], { from: 'element:1', to: 'request:POST /y', type: 'triggers' });
  assert.deepEqual(d.churnedTemplates, []);
  assert.deepEqual(d.churnedInstances, []);
});

// (c2) A dropped template KEY: a 'tpl:' key present in before is gone in after (an element
// lost its identity). The churn loop iterates only after's keys, so this reverse-pass catch
// is what makes the gate complete.
// FAIL-ON-REVERT: delete the `for (const key of Object.keys(bIds))` dropped-key pass in
//   diffIdentity → droppedTemplates stays [] → ok flips true → this test's ok:false +
//   droppedTemplates assertions go red.
test('a dropped template key is churn (ok:false, key in droppedTemplates)', () => {
  const before = { ledger: { next: 5, ids: { 'tpl:button.a': 1, 'inst:button.a::0': 2, 'tpl:button.b': 3 } }, graph: { edges: [] } };
  const after = { ledger: { next: 3, ids: { 'tpl:button.a': 1, 'inst:button.a::0': 2 } }, graph: { edges: [] } };
  const d = diffIdentity(before, after);
  assert.equal(d.ok, false, 'a dropped template key must fail the gate');
  assert.deepEqual(d.droppedTemplates, [{ key: 'tpl:button.b', id: 3 }], 'the removed template key is reported dropped');
  assert.deepEqual(d.droppedInstances, [], 'no instance key was dropped');
  assert.deepEqual(d.churnedTemplates, [], 'a dropped key is not a churn (id did not change)');
});

// (d) Empty/missing before (first run): everything in after is added, nothing churns.
// FAIL-ON-REVERT: drop the safeIds/safeEdges fallbacks → diffIdentity({}, after) reads
//   `.ids`/`.edges` off undefined and THROWS → this test errors out (red).
test('an empty or missing before adds everything and stays ok', () => {
  const after = {
    ledger: { next: 5, ids: { 'tpl:x': 1, 'tpl:y': 2, 'inst:x::0': 3, 'inst:y::0': 4 } },
    graph: { edges: [edge('element:1', 'request:GET /x')] },
  };
  for (const before of [{ ledger: { next: 1, ids: {} }, graph: { edges: [] } }, {}, undefined]) {
    const d = diffIdentity(before, after);
    assert.equal(d.ok, true, 'a first run (no prior identity) has nothing to churn');
    assert.deepEqual(d.churnedTemplates, []);
    assert.deepEqual(d.churnedInstances, []);
    assert.deepEqual(d.droppedEdges, []);
    assert.equal(d.addedTemplates, 2);
    assert.equal(d.addedInstances, 2);
    assert.equal(d.addedEdges, 1);
  }
});

// (e) The CLI gate must fail LOUD on a corrupt --before/--after: loadStrict returns the empty
// fallback for a MISSING file (a first run) but THROWS for a present-but-unparseable file. The
// crawl's loadLedger/loadGraph swallow a parse error and start fresh; the churn GATE must NOT —
// a corrupt state would otherwise read as empty and pass falsely green, hiding real movement.
// FAIL-ON-REVERT: make loadStrict swallow the parse error and return the fallback → a corrupt
//   file reads as empty (no throw) → the `assert.throws` below goes red.
test('loadStrict: missing file → empty fallback; corrupt file → throws (no false green)', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'iddiff-'));
  try {
    assert.deepEqual(loadStrict(path.join(dir, 'nope.json'), { sentinel: true }), { sentinel: true }, 'a missing file yields the empty fallback');
    const corrupt = path.join(dir, 'bad.json');
    writeFileSync(corrupt, '{ this is : not json ]');
    assert.throws(() => loadStrict(corrupt, { sentinel: true }), /not valid JSON/, 'a present-but-corrupt file must throw, never read as empty');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
