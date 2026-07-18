// Unit proof of the per-page coverage ledger — the CONTROLLER's core view: for every page, how many UI
// elements it holds, how many are collected (clicked), how many still remain. Pure over a synthetic graph
// (no browser — layer rule), so it guards the GROUPING + the counters, not a crawl.
//
// Guards: perRouteCoverage groups elements BY their own page (node.route) and reports honest per-page
//   done/left/total at the INSTANCE level, and surfaces a route that is queued-but-unvisited (pending) as a
//   zero-element page — so the operator sees "dashboard: 1 done / 1 left / 2 total, settings: not yet visited"
//   instead of a single lumped global number. coverageTotals rolls the rows back to the global tally.
// FAIL-ON-REVERT: in coverage-by-page.mjs replace `const rk = node.route || '(unknown)'` with a constant
//   (e.g. `const rk = '/all'`) → every element lumps onto ONE page → the distinct /dashboard + /profile rows
//   vanish → "the /dashboard row splits out" assertion reds (no such row / wrong counts).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { perRouteCoverage, coverageTotals, classifyStats, triggeredTemplates } from '../../lib/recon/coverage-by-page.mjs';

// Two pages with real elements + one page still queued (pending, no elements yet).
function graph() {
  return {
    elements: {
      1: { route: '/dashboard', role: 'button', explored: true, instances: [{ instanceKey: 'a', explored: true }] },
      2: { route: '/dashboard', role: 'button', explored: false, instances: [{ instanceKey: 'b' }] },
      3: { route: '/profile', role: 'link', explored: true, instances: [{ instanceKey: 'c', explored: true }] },
    },
    routes: {
      '/dashboard': { type: 'route', url: '/dashboard' },
      '/profile': { type: 'route', url: '/profile' },
      '/settings': { type: 'route', url: '/settings', pending: true },
    },
    requests: {},
  };
}

test('perRouteCoverage splits done/left/total per page and surfaces a pending page', () => {
  const rows = perRouteCoverage(graph());
  const by = Object.fromEntries(rows.map((r) => [r.route, r]));

  // The /dashboard row splits out with its OWN counts: 1 element clicked, 1 still to click, 2 total.
  assert.ok(by['/dashboard'], 'the /dashboard row splits out');
  assert.equal(by['/dashboard'].done, 1, '/dashboard: one element collected');
  assert.equal(by['/dashboard'].left, 1, '/dashboard: one element still to click');
  assert.equal(by['/dashboard'].total, 2, '/dashboard: two elements total');
  assert.equal(by['/dashboard'].visited, true);

  // /profile is fully walked.
  assert.equal(by['/profile'].done, 1);
  assert.equal(by['/profile'].left, 0);
  assert.equal(by['/profile'].total, 1);

  // A queued-but-unvisited page is shown as a zero-element pending row (not hidden, not counted collected).
  assert.equal(by['/settings'].pending, true, '/settings is surfaced as pending');
  assert.equal(by['/settings'].total, 0, '/settings has no elements yet');
});

test('coverageTotals rolls the per-page rows back into the global tally', () => {
  const rows = perRouteCoverage(graph());
  const t = coverageTotals(rows);
  assert.equal(t.done, 2, 'two elements collected across all pages');
  assert.equal(t.left, 1, 'one element remaining across all pages');
  assert.equal(t.total, 3, 'three elements total across all pages');
  assert.equal(t.pagesWithWork, 1, 'exactly one page still has work (/dashboard)');
  assert.equal(t.pagesPending, 1, 'exactly one page still to visit (/settings)');
});

// CLASSIFICATION LEDGER — "how many do we UNDERSTAND", which is NOT "how many did we click".
// Guards: clicking drains the frontier; only an `observe` writes node.semantics. The deterministic
//   node-loop acts without judging, so a page can be fully collected and entirely unexplained — the
//   ledger must show that gap, not average it away. Also: `inert` (acted, classified, caused no
//   request and revealed nothing) is the literal answer to "is this even an element?", and a causal
//   trigger edge must be told apart from a structural nav edge when deciding "it did something".
// FAIL-ON-REVERT: in coverage-by-page.mjs count a semantics-less but explored node as `known` (drop
//   the `if (sem)` branch) → "clicked-but-unclassified stays out of known" reds. Drop the
//   `e.provenance !== 'causal'` filter in triggeredTemplates → the nav-edge control counts as having
//   done something → "a nav-edge-only control is still inert" reds.
test('classification separates UNDERSTOOD from merely clicked, and flags inert controls', () => {
  const graph = {
    elements: {
      // Clicked AND explained, with a real causal request edge → known, not inert.
      1: { route: '/a', explored: true, semantics: { purpose: 'search', danger: 'safe', effect: 'request', acted: true } },
      // Clicked AND explained, but caused nothing and opened nothing → known AND inert.
      2: { route: '/a', explored: true, semantics: { purpose: 'decorative', danger: 'unknown', effect: 'none', acted: true } },
      // Clicked by the node-loop, never judged → clicked, NOT known.
      3: { route: '/a', explored: true },
      // Never touched.
      4: { route: '/a' },
      // Classified destructive, and it only has a STRUCTURAL nav edge — still inert (a nav edge is
      // reachability, not causation).
      5: { route: '/a', explored: true, semantics: { purpose: 'remove item', danger: 'destructive', effect: 'request', acted: true } },
    },
    edges: [
      { from: 'element:1', to: 'request:GET /api/s', type: 'triggers', provenance: 'causal' },
      { from: 'route:/a', to: 'route:/b', type: 'navigates', provenance: 'href' },
      { from: 'element:5', to: 'route:/b', type: 'navigates', provenance: 'act' },
    ],
    routes: { '/a': { type: 'route', url: '/a' } },
  };

  const c = classifyStats(graph.elements, triggeredTemplates(graph));
  assert.equal(c.known, 3, 'three templates carry recorded semantics');
  assert.equal(c.clicked, 1, 'clicked-but-unclassified stays OUT of known — the node-loop residual is visible');
  assert.equal(c.untouched, 1, 'never-clicked is its own bucket');
  assert.equal(c.inert, 2, 'the no-effect control AND the nav-edge-only control are both inert');
  assert.equal(c.byDanger.safe, 1);
  assert.equal(c.byDanger.destructive, 1);
  assert.equal(c.byDanger.unknown, 1, "'unknown' means the judge looked and could not tell — distinct from unjudged");

  // It rolls up per page and into the totals, so a summary can never claim walked === understood.
  const rows = perRouteCoverage(graph);
  const totals = coverageTotals(rows);
  assert.equal(totals.known, 3);
  assert.equal(totals.clicked, 1);
  assert.equal(totals.inert, 2);
});
