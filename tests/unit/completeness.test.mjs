// Unit proof of the Chao2 COMPLETENESS ORACLE (completeness.mjs) — the mark-recapture estimate of the
// undetected tail over ≥2 independent crawls. Deterministic math + pure graph reads (no browser).
//
// FAIL-ON-REVERT:
//   - drop the (T-1)/T finite-sample correction (corr → 1) → the f0/Ŝ assertions in "Q2>0" and "T=3" red.
//   - swap the estimator core Q1²/(2·Q2) → the "Q2>0" Ŝ≈4.5 assertion reds.
//   - key templateItemKeys on templateId instead of templateSelector → the "cross-graph key stability"
//     test reds (the same control across two graphs would count as two Q1 uniques, not one Q2 shared).
//   - let completenessOf fake an estimate for <2 graphs → the "refuses a single sample" test reds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chao2, routeItemKeys, templateItemKeys, completenessOf } from '../../lib/recon/completeness.mjs';

const approx = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

test('chao2: Q2>0 uses ((T-1)/T)·Q1²/(2·Q2)', () => {
  // A={r1,r2,r3} B={r2,r3,r4} → r1,r4 unique (Q1=2); r2,r3 shared (Q2=2); sObs=4; T=2.
  const r = chao2([['r1', 'r2', 'r3'], ['r2', 'r3', 'r4']]);
  assert.equal(r.sObs, 4);
  assert.equal(r.q1, 2);
  assert.equal(r.q2, 2);
  // corr=0.5 · f0 = 0.5·(2²)/(2·2) = 0.5 → Ŝ=4.5 · C = 4/4.5.
  assert.ok(approx(r.undetected, 0.5), `f0=${r.undetected}`);
  assert.ok(approx(r.estimated, 4.5), `Ŝ=${r.estimated}`);
  assert.ok(approx(r.completeness, 4 / 4.5), `C=${r.completeness}`);
  assert.equal(r.converged, false);
});

test('chao2: Q2=0 uses the bias-corrected ((T-1)/T)·Q1·(Q1-1)/2', () => {
  // A={r1} B={r2} → both unique (Q1=2, Q2=0); sObs=2; T=2.
  const r = chao2([['r1'], ['r2']]);
  assert.equal(r.q1, 2);
  assert.equal(r.q2, 0);
  // corr=0.5 · f0 = 0.5·(2·1)/2 = 0.5 → Ŝ=2.5 · C=2/2.5=0.8.
  assert.ok(approx(r.undetected, 0.5), `f0=${r.undetected}`);
  assert.ok(approx(r.completeness, 0.8), `C=${r.completeness}`);
});

test('chao2: identical exhaustive samples converge to 100% (Q1=0, flagged)', () => {
  const r = chao2([['a', 'b'], ['a', 'b']]);
  assert.equal(r.q1, 0);
  assert.equal(r.undetected, 0);
  assert.equal(r.completeness, 1);
  assert.equal(r.converged, true); // the honest "not informative" flag
});

test('chao2: T=3 carries the (T-1)/T=2/3 correction', () => {
  // A={a,b,c} B={a,b,d} C={a,e}: a→3, b→2, c/d/e→1 → Q1=3, Q2=1, sObs=5, T=3.
  const r = chao2([['a', 'b', 'c'], ['a', 'b', 'd'], ['a', 'e']]);
  assert.equal(r.sObs, 5);
  assert.equal(r.q1, 3);
  assert.equal(r.q2, 1);
  // corr=2/3 · f0 = (2/3)·(3²)/(2·1) = 3 → Ŝ=8 · C=5/8.
  assert.ok(approx(r.undetected, 3), `f0=${r.undetected}`);
  assert.ok(approx(r.estimated, 8), `Ŝ=${r.estimated}`);
  assert.ok(approx(r.completeness, 5 / 8), `C=${r.completeness}`);
});

test('chao2: fewer than 2 samples is undefined and throws', () => {
  assert.throws(() => chao2([['a', 'b']]), /COMPLETENESS_NEEDS_2/);
});

test('routeItemKeys: visited routes only — pending and :param patterns excluded', () => {
  const graph = {
    routes: {
      '/dashboard': { url: '/dashboard' },                       // visited
      '/events': { url: '/events', pending: true },              // discovered, not visited
      '/user/:id': { url: '/user/:id', unreachable: 'param-pattern' },
      '/settings': { url: '/settings', unreachable: '404' },     // visited then unreachable — still a detection
    },
  };
  const keys = routeItemKeys(graph);
  assert.ok(keys.has('/dashboard'));
  assert.ok(keys.has('/settings'));
  assert.ok(!keys.has('/events'), 'a pending route is not a detection');
  assert.ok(!keys.has('/user/:id'), 'a :param pattern is a denominator, not a detection');
});

test('templateItemKeys: cross-graph STABLE key — same control, different templateId, counts as shared', () => {
  // Two independent crawls: the SAME physical control (route + templateSelector) is minted under a
  // DIFFERENT incremental templateId in each graph. A correct oracle keys on the selector, so the
  // control is Q2 (shared-by-2), NOT two separate Q1 uniques.
  const g1 = { elements: { 3: { templateId: 3, route: '/dashboard', templateSelector: 'nav>button.groups', role: 'button', name: 'Groups' } } };
  const g2 = { elements: { 7: { templateId: 7, route: '/dashboard', templateSelector: 'nav>button.groups', role: 'button', name: 'Groups' } } };
  const k1 = templateItemKeys(g1);
  const k2 = templateItemKeys(g2);
  assert.equal(k1.size, 1);
  assert.deepEqual([...k1], [...k2], 'the same control yields the same key across graphs (not the templateId)');
  const r = chao2([k1, k2]);
  assert.equal(r.q2, 1, 'the shared control is counted once as a doubleton');
  assert.equal(r.q1, 0);
});

test('completenessOf: refuses a single sample instead of faking 100%', () => {
  const res = completenessOf([{ routes: {}, elements: {} }]);
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'COMPLETENESS_NEEDS_2');
});

test('completenessOf: two graphs → both route and template dimensions estimated', () => {
  const g1 = { routes: { '/a': { url: '/a' }, '/b': { url: '/b' } }, elements: { 1: { route: '/a', templateSelector: 's1' } } };
  const g2 = { routes: { '/a': { url: '/a' }, '/c': { url: '/c' } }, elements: { 1: { route: '/a', templateSelector: 's1' } } };
  const res = completenessOf([g1, g2]);
  assert.equal(res.ok, true);
  assert.equal(res.route.sObs, 3);       // /a /b /c
  assert.equal(res.route.q1, 2);         // /b /c unique
  assert.equal(res.route.q2, 1);         // /a shared
  assert.equal(res.template.sObs, 1);    // one shared control
  assert.equal(res.template.converged, true);
});
