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
