// matchParamPattern / tagParamInstance — the STRUCTURAL reconcile that links a concrete route to its
// declared `:param` pattern (GOAL 2). Pure over graph.routes. Guards: it aligns by SEGMENT STRUCTURE (not
// toUrlPattern equality), so a STRING-keyed param (/user/:handle → /user/alice, which toUrlPattern leaves
// unmasked) links correctly; a wrong segment count / a non-matching literal / a pattern-as-input does not.
// FAIL-ON-REVERT: require toUrlPattern equality instead of segment-align → /user/alice no longer matches
//   /user/:handle → the string-keyed assertion reds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { matchParamPattern, tagParamInstance, isParamPath } from '../../lib/graph/graph-store.mjs';

const graph = () => ({ routes: {
  '/nugget/:id': { url: '/nugget/:id', unreachable: 'param-pattern' },
  '/user/:handle': { url: '/user/:handle', unreachable: 'param-pattern' },
  '/a/:x/edit': { url: '/a/:x/edit', unreachable: 'param-pattern' },
  '/dashboard': { url: '/dashboard' }, // a static route — never a param target
} });

test('matchParamPattern aligns a concrete to its :param pattern by segment structure', () => {
  const g = graph();
  assert.equal(matchParamPattern(g, '/nugget/123'), '/nugget/:id', 'numeric concrete');
  assert.equal(matchParamPattern(g, '/user/alice'), '/user/:handle', 'STRING-keyed concrete (toUrlPattern would miss it)');
  assert.equal(matchParamPattern(g, '/a/5/edit'), '/a/:x/edit', 'a param slot in the middle, literal tail');
  assert.equal(matchParamPattern(g, '/nugget/1/2'), null, 'wrong segment count → no match');
  assert.equal(matchParamPattern(g, '/other/1'), null, 'no declared pattern for this shape');
  assert.equal(matchParamPattern(g, '/dashboard'), null, 'a static route is not a param instance');
  assert.equal(matchParamPattern(g, '/nugget/:id'), null, 'a pattern literal is not itself a concrete instance');
});

test('matchParamPattern prefers the MOST-LITERAL (most specific) pattern over a bare catch-all', () => {
  const g = { routes: {
    '/user/:handle': { url: '/user/:handle', unreachable: 'param-pattern' },
    '/:a/:b': { url: '/:a/:b', unreachable: 'param-pattern' },
  } };
  assert.equal(matchParamPattern(g, '/user/alice'), '/user/:handle', 'the 1-literal pattern beats the 0-literal /:a/:b');
});

// MUST FIX (bughunter review, invariant #3): a manifest-DECLARED static that shares a param's shape
// (/user/settings beside /user/:handle; any static under a /:slug catch-all) must NEVER be tagged a param
// proxy — else it vanishes from `sections` and fabricates pattern coverage (denominator collapse).
// FAIL-ON-REVERT: drop the `node.declared === true` guard in tagParamInstance → /user/settings is tagged →
//   routeCoverageOf excludes it from sections → the "declared static stays a section" assertion reds.
test('tagParamInstance NEVER tags a declared static section (denominator-collapse guard)', () => {
  const g = { routes: {
    '/user/:handle': { url: '/user/:handle', unreachable: 'param-pattern' },
    '/user/settings': { url: '/user/settings', declared: true },  // a declared static matching the param shape
    '/:slug': { url: '/:slug', unreachable: 'param-pattern' },     // a catch-all
    '/dashboard': { url: '/dashboard', declared: true },
  } };
  assert.equal(matchParamPattern(g, '/user/settings'), '/user/:handle', 'the matcher aligns structurally...');
  assert.equal(tagParamInstance(g, '/user/settings'), null, '...but tagParamInstance REFUSES a declared static');
  assert.equal(g.routes['/user/settings'].paramInstanceOf, undefined, 'no paramInstanceOf written on the declared static');
  assert.equal(tagParamInstance(g, '/dashboard'), null, 'a declared 1-segment static is NOT collapsed into /:slug');
  assert.equal(g.routes['/dashboard'].paramInstanceOf, undefined, 'the static stays its own section');
});

test('tagParamInstance links only a present, untagged, matching concrete node', () => {
  const g = graph();
  g.routes['/nugget/7'] = { url: '/nugget/7' };
  assert.equal(tagParamInstance(g, '/nugget/7'), '/nugget/:id', 'tags a matching concrete');
  assert.equal(g.routes['/nugget/7'].paramInstanceOf, '/nugget/:id', 'the paramInstanceOf link is written');
  assert.equal(tagParamInstance(g, '/nugget/7'), null, 'idempotent — an already-tagged node is a no-op');
  assert.equal(tagParamInstance(g, '/missing/1'), null, 'an absent node is a no-op');
  assert.equal(tagParamInstance(g, '/nugget/:id'), null, 'a pattern node is never tagged');
});

// SOME ROUTERS WRITE `$id`, NOT `:id` — and reading only `:` made a param route look STATIC.
//
// MEASURED on a live target whose router is file-based, turning `<entity>.$id.tsx` into `/<entity>/$id`.
// `extractRoutes` pulled the path out of the bundle correctly, then classified it by
// `c.includes(':')` — false — so it was seeded as a CONCRETE pending route, navigated to LITERALLY, and
// answered 200 by the SPA shell (a client-routed app serves its shell for any path). The graph recorded
// four such routes as visited-with-zero-controls, including the richest page in the application at 321
// controls. It was "visited" without ever having existed.
//
// Guards: a `$`-sigil path is a parameter pattern in BOTH the manifest split and the segment matcher, so
//   it is counted in the denominator and never navigated literally; concrete instances reconcile to it.
// FAIL-ON-REVERT: restore `isParamSegment` to `s.startsWith(':')` only → "/employees/$id is a param
//   pattern" reds, and the concrete employee page stops reconciling to its pattern.
test('a $-sigil dynamic segment is a param slot, exactly like :id', () => {
  assert.equal(isParamPath('/entity/$id'), true, 'a $-sigil segment is a parameter slot');
  assert.equal(isParamPath('/section/sub/$id'), true);
  assert.equal(isParamPath('/entity/:id'), true, 'the : form still works');
  // The over-classification direction: an ordinary path must NOT become a pattern, or real sections
  // would leave the pending queue and never be visited at all.
  assert.equal(isParamPath('/entity'), false);
  assert.equal(isParamPath('/section/action'), false);
  assert.equal(isParamPath('/'), false);
});

test('a concrete page reconciles to its $-sigil pattern', () => {
  const graph = { routes: {
    '/entity/$id': { url: '/entity/$id', unreachable: 'param-pattern' },
    '/listing': { url: '/listing' },
  } };
  assert.equal(matchParamPattern(graph, '/entity/ebc62a90-2909-476c-87bc-9064e74141f8'), '/entity/$id',
    'the concrete detail page is an INSTANCE of the pattern, not a section of its own');
  assert.equal(matchParamPattern(graph, '/listing'), null, 'a static route reconciles to nothing');
});
