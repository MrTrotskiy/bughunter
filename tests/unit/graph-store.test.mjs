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
import { toUrlPattern, makeGraph, mergeSnapshot, recordSemantics } from '../../lib/graph/graph-store.mjs';

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
