// Unit test for toUrlPattern: the url-pattern mask that collapses per-request
// variance so N concrete requests share one graph node. It masks query VALUES and
// numeric/uuid/long-hex path SEGMENTS to :param while preserving the path shape
// and the query KEYS. Contract asserted here matches the real implementation
// (query keys kept verbatim, each value rewritten to `<key>=:param`).
//
// Guards: toUrlPattern masking — query values and volatile path segments become
//   :param, path shape and query keys survive, so the graph groups correctly.
// FAIL-ON-REVERT: break the query-value mask (`${k}=:param` -> `${k}=VALUE`)
//   -> actual '/api/search?q=VALUE' !== expected '/api/search?q=:param'.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { toUrlPattern, makeGraph, mergeSnapshot, recordSemantics, loadGraph, saveGraph, SCHEMA_VERSION } from '../../lib/graph/graph-store.mjs';
import { makeLedger } from '../../lib/graph/ids.mjs';
import { idify } from '../../lib/recon/step.mjs';
import { diffIdentity } from '../../lib/graph/identity-diff.mjs';

test('query value is masked to :param, key is kept', () => {
  assert.equal(toUrlPattern('/api/search?q=hello'), '/api/search?q=:param');
});

test('multiple query keys are each kept, values each masked', () => {
  assert.equal(toUrlPattern('/api/search?q=hello&page=2'), '/api/search?q=:param&page=:param');
});

test('numeric path segment is masked, path shape kept', () => {
  assert.equal(toUrlPattern('/api/item/42'), '/api/item/:param');
});

test('uuid path segment is masked', () => {
  assert.equal(
    toUrlPattern('/api/user/550e8400-e29b-41d4-a716-446655440000/edit'),
    '/api/user/:param/edit',
  );
});

test('stable path with no volatile parts is returned unchanged', () => {
  // Nothing to mask: proves the mask does not over-collapse a plain path.
  assert.equal(toUrlPattern('/api/config'), '/api/config');
});

// Guards: recordSemantics attaches the agent's observation to the RIGHT element node
//   and leaves `explored` untouched (observe.mjs owns that), and an unknown template
//   is a safe no-op — so a bad templateId can never corrupt the graph.
// FAIL-ON-REVERT: make recordSemantics a no-op (never set node.semantics) → the
//   semantics readback fails with "semantics not recorded".
const semEl = {
  templateId: 7, instanceId: 70, templateSelector: 'button.x', role: 'button',
  name: 'X', instanceKey: '#1', instanceSelector: 'button.x:nth-child(1)',
};

test('recordSemantics writes onto the right node without touching explored', () => {
  const g = makeGraph();
  mergeSnapshot(g, '/', [{ ...semEl }]);
  const r = recordSemantics(g, 7, { purpose: 'does x', danger: 'safe', effect: 'request', acted: true, stateChange: false });
  assert.equal(r.recorded, true);
  assert.equal(g.elements[7].semantics?.purpose, 'does x', 'semantics not recorded');
  assert.equal(g.elements[7].explored, false, 'recordSemantics must NOT flip explored');
});

test('recordSemantics on an unknown template is a no-op', () => {
  const g = makeGraph();
  const r = recordSemantics(g, 999, { purpose: 'x' });
  assert.equal(r.recorded, false);
  assert.equal(g.elements[999], undefined);
});

// Guards (panel reach, backend SHOULD FIX): the reveal fill's genuine-coverage guard. A baseline-
//   hidden instance that was GENUINELY reached (explored, NOT unreachable, no reveal — it appeared by
//   its OWN means and was acted) is NEVER reset by a later opener's fill; only a NOT_VISIBLE-drained
//   (explored+unreachable) or not-yet-acted hidden instance acquires the opener's reveal path + reopens.
// FAIL-ON-REVERT: drop `if (inst.explored && !inst.unreachable) return false;` in fillRevealIfHidden
//   → the genuinely-reached instance is reset (reveal stamped, explored cleared, listed in filled) →
//   the "genuine coverage survives" assertions go red.
test('the reveal fill protects genuine coverage, fills only a drained/unacted hidden instance', () => {
  const g = makeGraph();
  const hidden = (key) => ({
    templateId: 5, instanceId: 50, templateSelector: 'button.tab', role: 'button', name: 'Tab',
    instanceKey: key, instanceSelector: `button.tab[data-k="${key}"]`, visible: false,
  });
  // Two hidden-at-baseline instances of ONE template (hiddenWhenSeen=true, pathless). [0] is #genuine.
  mergeSnapshot(g, '/', [hidden('#genuine'), hidden('#drained')]);
  const node = g.elements[5];
  const genuine = node.instances.find((i) => i.instanceKey === '#genuine');
  const drained = node.instances.find((i) => i.instanceKey === '#drained');
  assert.ok(genuine.hiddenWhenSeen && drained.hiddenWhenSeen, 'both captured hidden at baseline');

  // #genuine: appeared by its OWN means and was genuinely acted (explored, reachable, no reveal).
  genuine.explored = true;
  // #drained: acted but NOT_VISIBLE-drained (explored + unreachable, no reveal).
  drained.explored = true; drained.unreachable = 'NOT_VISIBLE';

  // A later opener act makes BOTH visible and offers a reveal path.
  const now = (key) => ({ ...hidden(key), visible: true });
  const res = mergeSnapshot(g, '/', [now('#genuine'), now('#drained')], { revealPath: [{ templateId: 9, instanceKey: '#more' }] });

  // #genuine survives untouched — real coverage is never discarded, no bogus reveal stamped.
  assert.equal(genuine.reveal, undefined, 'genuine coverage keeps its null reveal (no bogus path)');
  assert.equal(genuine.explored, true, 'genuine coverage stays explored (not reopened)');
  assert.ok(!res.filled.some((f) => f.instanceKey === '#genuine'), 'genuine instance is NOT in filled');

  // #drained is legitimately filled — it was never really reached, so it acquires the path + reopens.
  assert.ok(drained.reveal && drained.reveal.statePath.length === 1, 'drained instance acquired the [More] reveal path');
  assert.equal(drained.explored, false, 'drained instance is reopened for a genuine attempt');
  assert.equal(drained.unreachable, undefined, 'drained instance shed its unreachable flag');
  assert.ok(res.filled.some((f) => f.instanceKey === '#drained'), 'drained instance IS in filled');
});

// Guards (DRILL_PER_LIST honesty): mergeSnapshot sets a write-once node.listRow when an instance's
//   element sits in a list row (el.inRow === true) — a template with ANY row-resident instance is a
//   list-of-rows, so frontier.drillSkipped can count its non-representative rows. inRow:false / absent
//   (older snapshot) leaves listRow UNSET (safe default), and once true it never flips back to false.
// FAIL-ON-REVERT: (a) drop the `if (el.inRow === true) node.listRow = true` line → the row-resident
//   template's `listRow === true` assertion reds; (b) change it to `node.listRow = el.inRow === true`
//   (not write-once) → a later inRow:false instance flips it → the "stays true" assertion reds.
test('mergeSnapshot sets node.listRow write-once for a row-resident instance; false/absent inRow leaves it unset', () => {
  const g = makeGraph();
  const rowEl = (i) => ({
    templateId: 1, instanceId: 100 + i, templateSelector: 'li button.edit', role: 'button',
    name: 'Edit', instanceKey: `#${i}`, instanceSelector: `li:nth-child(${i}) button.edit`, inRow: true,
  });
  mergeSnapshot(g, '/', [rowEl(1), rowEl(2)]);
  assert.equal(g.elements[1].listRow, true, 'a row-resident instance flags the template listRow');

  // Write-once: a LATER inRow:false instance of the SAME template must NOT flip listRow back to false.
  mergeSnapshot(g, '/', [{ ...rowEl(3), inRow: false }]);
  assert.equal(g.elements[1].listRow, true, 'listRow is write-once — a later non-row instance never clears it');

  // A NON-row template (inRow:false) → listRow stays unset (safe default, not false).
  mergeSnapshot(g, '/', [{
    templateId: 2, instanceId: 200, templateSelector: 'button.x', role: 'button', name: 'X',
    instanceKey: '#1', instanceSelector: 'button.x', inRow: false,
  }]);
  assert.equal(g.elements[2].listRow, undefined, 'inRow:false leaves listRow unset');

  // Absent inRow (older snapshot, no field) → listRow stays unset, exactly like hiddenWhenSeen.
  mergeSnapshot(g, '/', [{
    templateId: 3, instanceId: 300, templateSelector: 'button.y', role: 'button', name: 'Y',
    instanceKey: '#1', instanceSelector: 'button.y',
  }]);
  assert.equal(g.elements[3].listRow, undefined, 'absent inRow leaves listRow unset');
});

// Guards (INVARIANT #2): inRow/listRow are ADDITIVE reporting fields — never identity inputs. Feeding
//   the SAME elements once WITHOUT and once WITH inRow must mint IDENTICAL template/instance ids (idify
//   keys on the selector strings + instanceKey only) and add ZERO edge churn — diffIdentity ok:true.
// FAIL-ON-REVERT: fold inRow into an identity key (e.g. idify keying on it, or mergeSnapshot minting a
//   new id when inRow differs) → the two ledgers diverge and diffIdentity reports churn → the
//   deepEqual(ledger maps) + ok:true assertions go red.
test('inRow/listRow add ZERO identity churn (ledger maps identical; diffIdentity ok)', () => {
  const rowEls = () => [
    { templateSelector: 'li button.edit', role: 'button', name: 'Edit', instanceKey: '#1', instanceSelector: 'li:nth-child(1) button.edit' },
    { templateSelector: 'li button.edit', role: 'button', name: 'Edit', instanceKey: '#2', instanceSelector: 'li:nth-child(2) button.edit' },
  ];
  // Run A: merge the elements WITHOUT inRow.
  const gA = makeGraph(); const ledgerA = makeLedger();
  mergeSnapshot(gA, '/', idify(ledgerA, rowEls()));
  // Run B: merge the SAME elements WITH inRow:true (flags listRow).
  const gB = makeGraph(); const ledgerB = makeLedger();
  mergeSnapshot(gB, '/', idify(ledgerB, rowEls().map((e) => ({ ...e, inRow: true }))));

  // The flag actually took effect in B and not A — the churn proof is not vacuous.
  assert.equal(gB.elements[1].listRow, true, 'run B flagged listRow');
  assert.equal(gA.elements[1].listRow, undefined, 'run A has no listRow');

  // The append-only ledger keys on the selector strings ONLY — inRow must never enter it.
  assert.deepEqual(ledgerB.ids, ledgerA.ids, 'template/instance ids identical with and without inRow');
  const d = diffIdentity({ ledger: ledgerA, graph: gA }, { ledger: ledgerB, graph: gB });
  assert.equal(d.ok, true, 'identity-diff reports no churn from inRow/listRow');
  assert.deepEqual(d.churnedTemplates, [], 'no template ids churned');
  assert.deepEqual(d.churnedInstances, [], 'no instance ids churned');
  assert.deepEqual(d.droppedEdges, [], 'no edges dropped');
});

// Guards (INC.1): the schemaVersion gate — a graph minted under a DIFFERENT identity scheme
//   (a pre-INC.1 graph has NO schemaVersion; its ids anchored on framework-noise selectors) is
//   RESET on load rather than co-mingled with current-scheme ids, while a current-scheme graph
//   loads intact. This is the safety net that keeps two id schemes from merging after INC.1
//   re-keyed every antd control.
// FAIL-ON-REVERT: drop the `if (raw.schemaVersion !== SCHEMA_VERSION) return makeGraph()` line
//   in loadGraph → the legacy graph loads with its stale element intact → the "reset drops the
//   stale element" assertion goes red.
test('loadGraph RESETS a legacy (no-schemaVersion) graph, PRESERVES a current one', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'bughunter-schema-'));
  try {
    const staleEl = {
      type: 'element', templateId: 1, templateSelector: '#rc-tabs-0-tab-0', role: 'tab',
      name: 'Legacy', route: '/', explored: true, instances: [{ instanceId: 2, instanceKey: '#1' }],
    };

    // A legacy graph (no schemaVersion, framework-anchored template) is RESET on load.
    const legacyPath = path.join(dir, 'legacy.json');
    writeFileSync(legacyPath, JSON.stringify({ routes: {}, elements: { 1: staleEl }, requests: {}, edges: [] }));
    const reset = loadGraph(legacyPath);
    assert.deepEqual(reset.elements, {}, 'the legacy graph is reset — its stale framework-anchored element is dropped');
    assert.equal(reset.schemaVersion, SCHEMA_VERSION, 'the reset graph carries the current schema version');

    // A current-scheme graph is preserved verbatim (the gate does not nuke valid state).
    const currentPath = path.join(dir, 'current.json');
    const g = makeGraph();
    mergeSnapshot(g, '/', [{ ...semEl }]);
    saveGraph(currentPath, g);
    const kept = loadGraph(currentPath);
    assert.ok(kept.elements[7], 'a current-scheme graph loads with its element intact');
    assert.equal(kept.elements[7].name, 'X', 'the preserved element is unchanged');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
