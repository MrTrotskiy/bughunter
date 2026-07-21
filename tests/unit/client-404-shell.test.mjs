// CLIENT-404 WITH A NON-EMPTY SHELL (INC.6e) — a phantom route counted as a collected section.
//
// The client-404 label exists so a constant-URL SPA's dead routes (declared by the router, never
// implemented, rendering a shared Not-Found shell under a 200) leave the collectable denominator instead of
// masquerading as content-starved sections. Both consumers restricted the check to visited-but-EMPTY routes,
// on the stated reasoning that a Not-Found page carries no controls, so the restriction could only ever
// prevent a false collapse of a real section.
//
// That assumption is false on the live target. Its Not-Found shell renders ONE control, so every dead route
// had content, landed in `collected`, and never reached the empty-only 404 filter. Measured: 18 declared
// routes — /groups, /feed, /reports, /engine.io, /articles, /teams, … — all carry the probe's sig
// (2110f3b4) with exactly 1 own control each, and all 18 were reported as genuinely collected sections. That
// inflates the numerator AND the collectable base, which is the coverage lie the honesty invariant is about.
//
// The sig is now decisive, checked BEFORE any content count: contentSig is structural (text-free,
// attr-free), so matching a random nonexistent path byte-for-byte means the same shell rendered, whatever it
// contains. The residual risk runs the other way — a real page whose skeleton matched the shell would leave
// `collectable` — which is why every one stays LISTED in `clientNotFound`: counted, named, never dropped.
//
// Guards: a route that renders the Not-Found shell is a phantom EVEN WHEN THE SHELL HAS CONTROLS, in both
//   the standalone probe's verdict and the crawl's own route-coverage report; a real section with a distinct
//   sig is untouched, and a genuinely content-starved route stays visited-but-empty (never relabelled dead).
// FAIL-ON-REVERT (two levers, one per consumer):
//   (a) restore `if (contentInteractive > 0) verdict = 'collected'` ahead of the sig test in
//       render-probe.deriveVerdict → "a Not-Found shell WITH a control is still a phantom" fails.
//   (b) restore the empty-only filter in route-coverage (`client404 = empty.filter(...)`) → "a dead route
//       whose shell has a control must not count as collected" fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveVerdict } from '../../lib/recon/render-probe.mjs';
import { routeCoverageOf } from '../../lib/recon/route-coverage.mjs';

test('the Not-Found signature decides before any content count', () => {
  // The live shape: the shell has one control, so the old content-first rule called it collected.
  assert.equal(deriveVerdict({ contentInteractive: 1, sigMatchesNotFound: true }), 'client-404',
    'a Not-Found shell WITH a control is still a phantom — the sig is the label, not the control count');
  assert.equal(deriveVerdict({ contentInteractive: 0, sigMatchesNotFound: true }), 'client-404',
    'an empty shell is a phantom too (the case that always worked)');

  // The converse must not regress: a real section is judged on its own content.
  assert.equal(deriveVerdict({ contentInteractive: 6, sigMatchesNotFound: false }), 'collected',
    'a real section with a distinct sig is collected');
  assert.equal(deriveVerdict({ contentInteractive: 0, sigMatchesNotFound: false }), 'visited-empty',
    'a content-starved route with a distinct sig stays visited-but-empty — a real gap, not a phantom');
});

test('a dead route whose shell carries a control leaves the collectable denominator', () => {
  const SHELL = 'sig-not-found';
  const graph = {
    notFoundSig: SHELL,
    routes: {
      '/dashboard': { type: 'route', url: '/dashboard', declared: true, contentSig: 'sig-dash' },
      '/setting':   { type: 'route', url: '/setting', declared: true, contentSig: 'sig-setting' },
      // The phantom: declared, visited, renders the shell — and the shell has a control, so an element
      // IS attributed to it. This is exactly /groups on the live target.
      '/groups':    { type: 'route', url: '/groups', declared: true, contentSig: SHELL },
      // A genuinely content-starved section: no elements, but its OWN structure. Must stay collectable.
      '/inbox':     { type: 'route', url: '/inbox', declared: true, contentSig: 'sig-inbox' },
    },
    elements: {
      1: { type: 'element', route: '/dashboard' },
      2: { type: 'element', route: '/setting' },
      3: { type: 'element', route: '/groups' },   // the shell's single "go home" control
    },
    requests: {}, edges: [],
  };

  const rc = routeCoverageOf(graph);

  assert.ok(!rc.collected || !String(rc.clientNotFound).includes('/dashboard'), 'sanity: the real pages are not phantoms');
  assert.deepEqual(rc.clientNotFound, ['/groups'],
    'the shell-rendering route is labelled a phantom and LISTED — counted, named, never silently dropped');
  assert.equal(rc.collected, 2,
    'a dead route whose shell has a control must not count as collected (/dashboard + /setting only)');
  assert.equal(rc.collectable, 3,
    'and it leaves the collectable base: 4 declared − 1 phantom');
  assert.deepEqual(rc.visitedEmpty, ['/inbox'],
    'the real content-starved section stays an honest gap, never relabelled dead');
});
