// certify-loop — the AUTONOMOUS self-terminating collection loop (GOAL 5 capstone). It re-crawls with a
// rotating seed until the Chao2 oracle CERTIFIES completeness (the re-crawls converge — Q1→0 — or both
// dimensions clear the target), else stops HONESTLY at a maxRuns cap (never a faked completion). Pure logic
// tested with an injected mock runCrawl (no browser). FAIL-ON-REVERT: make certifyDecision ignore `converged`
// AND drop the target check → identical exhaustive re-crawls never certify → the "certifies at run 2" test
// hangs to the cap → reds. Make the cap claim certified:true → the "always-new never certifies" test reds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { certifyDecision, certifyLoop } from '../../lib/recon/certify-loop.mjs';

// Build a synthetic crawl graph from a list of visited route keys + optional (route, selector) controls.
const g = (routes, els = []) => ({
  routes: Object.fromEntries(routes.map((r) => [r, { type: 'route', url: r }])),
  elements: Object.fromEntries(els.map((e, i) => [i + 1, { route: e.route, templateSelector: e.sel }])),
});

test('certifyDecision: needs ≥ minRuns, then certifies on convergence (Q1=0)', () => {
  const one = g(['/a', '/b'], [{ route: '/a', sel: '.x' }]);
  assert.equal(certifyDecision([one], { minRuns: 2 }).reason, 'need-more-runs', 'one sample cannot certify (mark-recapture needs ≥2)');

  // Two IDENTICAL exhaustive drains → every item seen in both → Q1=0 → converged → certified.
  const d = certifyDecision([one, one], { minRuns: 2 });
  assert.equal(d.certified, true, 'identical exhaustive re-crawls converge (Q1=0) → certified');
  assert.equal(d.reason, 'converged');
});

test('certifyDecision: differing re-crawls with a unique item are NOT certified below target', () => {
  // Many shared items + one unique-to-each → Q1 stays > 0, the estimated tail keeps completeness below target.
  const s1 = g(['/a', '/b', '/c', '/d', '/e', '/u1']);
  const s2 = g(['/a', '/b', '/c', '/d', '/e', '/u2']);
  const d = certifyDecision([s1, s2], { target: 0.99, minRuns: 2 });
  assert.equal(d.certified, false, 'a unique-per-run item keeps Q1>0 and completeness below a 0.99 target');
  assert.equal(d.reason, 'below-target');
});

test('certifyLoop: stops the instant the re-crawls converge (identical drains → run 2)', async (t) => {
  const fixed = g(['/a', '/b'], [{ route: '/a', sel: '.x' }]);
  let calls = 0;
  const res = await certifyLoop({ runCrawl: async () => { calls++; return fixed; }, minRuns: 2, maxRuns: 6 });
  assert.equal(res.certified, true, 'converged → certified');
  assert.equal(res.runs, 2, 'stopped at run 2 (minRuns) the instant Q1=0 — no wasted extra crawls');
  assert.equal(calls, 2, 'runCrawl was invoked exactly twice');
});

test('certifyLoop: an always-discovering crawl never certifies → honest cap, never a faked 100%', async () => {
  // Each run discovers a brand-new unique route the others never see → Q1 never drops, target never met.
  const res = await certifyLoop({
    runCrawl: async (seed) => g(['/a', '/b', `/unique-${seed}`]),
    target: 0.99, minRuns: 2, maxRuns: 4,
  });
  assert.equal(res.certified, false, 'still discovering → NOT certified');
  assert.equal(res.cappedAtMax, true, 'stopped at the runaway cap, honestly reported');
  assert.equal(res.runs, 4, 'ran the full maxRuns budget');
});
