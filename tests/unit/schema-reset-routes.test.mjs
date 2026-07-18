// ROUTE CARRY-FORWARD across a schema reset — the regression that shrank the crawl to one page.
//
// A schemaVersion bump invalidates the ELEMENT identity scheme. It says nothing about routes, which are
// keyed by URL and carry navigation METADATA only (route-frontier is explicitly "the ONE other graph.routes
// writer — METADATA only, NEVER elements/edges"). loadGraph nevertheless returned a bare makeGraph(), so the
// v4→v5 bump silently deleted 81 `declared:true` manifest-seeded routes. Combined with the stateful driver
// having no cold route seeder, the route universe collapsed from 85 distinct patterns to 3 — /groups,
// /events, /chats, /profile and /setting were never queued again, two of the six user flows produced zero
// acts, and the runner printed "everything reachable is collected" over the shrunken denominator.
//
// The subtlety that makes a naive carry-forward WORSE than the bug: `visited` is represented by the ABSENCE
// of `pending` (route-frontier.markRouteVisited deletes the flag). Copying routes verbatim would mark every
// one already-visited while its elements had just been discarded — discovery kept, collection skipped, and a
// denominator that looks honest and is empty. So the carry-forward must RE-ARM.
//
// Guards: route discovery survives an element-identity re-key, re-armed for collection; an unreachable route
//   keeps that verdict (a 404 is a fact about the server, not about our identity scheme).
// FAIL-ON-REVERT (two levers):
//   (a) `return { ...makeGraph(), routes: rearmRoutes(raw.routes) }` → `return makeGraph()` in loadGraph →
//       "the declared route survived the re-key" fails.
//   (b) drop the re-arm (`routes: raw.routes || {}`) → "a carried-forward route is re-armed for collection"
//       fails, because the visited route stays pending-less and is never re-snapshotted.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadGraph } from '../../lib/graph/graph-store.mjs';

test('a schema reset discards elements but carries routes forward, re-armed for collection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bh-schema-'));
  const path = join(dir, 'graph.json');
  try {
    // A graph written under an OLDER identity scheme, holding the three route states that matter.
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      routes: {
        '/groups':   { type: 'route', url: '/groups', declared: true, pending: true },
        '/events':   { type: 'route', url: '/events', declared: true, pattern: '/events', siblings: 3 }, // visited
        '/ghost':    { type: 'route', url: '/ghost', unreachable: 'http-4xx' },
      },
      elements: { 7: { type: 'element', name: 'stale-identity', route: '/groups' } },
      requests: { 'GET /api/x': { type: 'request' } },
      edges: [{ from: 'element:7', to: 'request:GET /api/x' }],
    }));

    const g = loadGraph(path);

    // The element scheme IS discarded — that is what the bump is for.
    assert.deepEqual(Object.keys(g.elements), [], 'elements from the old identity scheme are dropped');
    assert.deepEqual(g.edges, [], 'and so are their edges');

    // The routes are NOT. This is the regression under guard.
    assert.deepEqual(Object.keys(g.routes).sort(), ['/events', '/ghost', '/groups'],
      'the declared route survived the re-key — route discovery is not element identity');
    assert.equal(g.routes['/groups'].declared, true, 'declared-ness is preserved, not re-derived');
    assert.equal(g.routes['/events'].siblings, 3, 'census metadata rides along');

    // Re-armed: a route that had been visited must be collected AGAIN, because its elements are gone.
    assert.equal(g.routes['/events'].pending, true,
      'a carried-forward route is re-armed for collection — its elements went with the reset');
    assert.equal(g.routes['/groups'].pending, true, 'an already-pending route stays pending');

    // Except an unreachable one: that verdict is about the server, and it stays counted-not-covered.
    assert.equal(g.routes['/ghost'].unreachable, 'http-4xx', 'an unreachable route keeps its verdict');
    assert.ok(!g.routes['/ghost'].pending, 'and is not re-queued for a pointless second visit');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a current-scheme graph is loaded untouched (the carry-forward is reset-only)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bh-schema-'));
  const path = join(dir, 'graph.json');
  try {
    const g0 = loadGraph(path);            // makeGraph() → current schemaVersion
    g0.routes['/a'] = { type: 'route', url: '/a' };   // visited: no pending flag
    g0.elements[1] = { type: 'element', name: 'keep-me' };
    writeFileSync(path, JSON.stringify(g0));

    const g = loadGraph(path);
    assert.equal(g.elements[1].name, 'keep-me', 'a matching-scheme graph keeps its elements');
    assert.ok(!g.routes['/a'].pending,
      'and its visited routes are NOT re-armed — re-arming is the schema-reset path only, never a re-walk of a good graph');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
