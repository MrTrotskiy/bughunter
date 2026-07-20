// A reopen hop must be on the target's own page, and the ladder must not spend budget on paths it cannot walk.
//
// WHY THIS TEST EXISTS. `reopen-policy.mjs` decides which recorded hops the crawler will re-click in order to
// get back to a control it lost. It had NO test at all — a policy module that fires real clicks on the
// operator's stand, guarded by nothing.
//
// The measured failure it now refuses: `reopenContainer` navigates to the TARGET's route before walking its
// hops, but a stateful breadcrumb is a SESSION HISTORY rather than a route — the chain resets only when
// `routeKey` changes, so acts performed on an earlier page survive into a later page's recorded path. In one
// run, 9 failures were the control `Export` (recorded on /people) being replayed after the driver had
// navigated to /projects. It cannot resolve there, and each attempt burns a full click timeout before
// admitting that.
//
// The wider lesson, established by architectural review against this run and recorded here because it
// contradicts an attractive fix: raising `REOPEN_MAX_HOPS` does NOT help. All 15 successful reopens in that
// run used exactly ONE hop; rungs 2 and 3 of the ladder never paid. Simulated over the real graph, admission
// is IDENTICAL at maxHops 3, 8 and 20 (1100 of 1120) — a longer suffix only prepends more session history,
// including breadcrumbs that navigate back out of the very container being opened.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { admitHop, reopenAttempts, REOPEN_MAX_HOPS } from '../../lib/recon/reopen-policy.mjs';

// A graph whose recorded path mixes two pages, exactly as a session history does.
function graph() {
  return {
    elements: {
      10: { templateId: 10, name: 'Export', route: '/people' },
      20: { templateId: 20, name: 'Open board', route: '/boards' },
      30: { templateId: 30, name: 'New task', route: '/boards', instances: [{ instanceKey: '#1' }] },
    },
  };
}

test('a hop recorded on another page is refused before it can burn a click timeout', () => {
  const g = graph();
  const offRoute = admitHop(g, { templateId: 10 }, new Set(), null, '/boards');
  assert.equal(offRoute.ok, false);
  assert.equal(offRoute.code, 'REOPEN_HOP_OFFROUTE',
    'Export lives on /people; the driver has navigated to /boards, so it cannot be on this path');

  const onRoute = admitHop(g, { templateId: 20 }, new Set(), null, '/boards');
  assert.equal(onRoute.ok, true, 'a hop on the target page is still admitted — the gate is scoped, not blanket');
});

test('the route gate is opt-in: a caller that does not know the target route keeps the old behaviour', () => {
  const g = graph();
  const noTarget = admitHop(g, { templateId: 10 }, new Set(), null, null);
  assert.equal(noTarget.ok, true,
    'passing no target route must not start refusing hops that were previously admitted');
});

test('reopenAttempts threads the target route, so a cross-page suffix is never attempted', () => {
  const g = graph();
  // The path a stateful walk records for a /boards control after acting on /people first.
  g.elements[30].instances[0].reveal = { statePath: [{ templateId: 10 }, { templateId: 20 }] };
  const attempts = reopenAttempts(g, g.elements[30], g.elements[30].instances[0]);

  const two = attempts.find((a) => a.hops.length === 2);
  assert.ok(two, 'the two-hop suffix is still enumerated — it is refused, not hidden');
  assert.equal(two.admitted, false, 'the suffix reaching back to /people is refused');
  assert.equal(two.code, 'REOPEN_HOP_OFFROUTE');

  const one = attempts.find((a) => a.hops.length === 1);
  assert.equal(one.admitted, true, 'the one-hop suffix is on-route and stays admitted — this is the rung that pays');
});

test('a repeated template in a path is refused — a cyclic history is not a route', () => {
  const g = graph();
  // Measured: one live template carried statePath [35, 35] — the same control acted twice in a row.
  g.elements[30].instances[0].reveal = { statePath: [{ templateId: 20 }, { templateId: 20 }] };
  const two = reopenAttempts(g, g.elements[30], g.elements[30].instances[0]).find((a) => a.hops.length === 2);
  assert.equal(two.admitted, false);
  assert.equal(two.code, 'REOPEN_HOP_REPEAT');
});

test('the ladder stays short on purpose', () => {
  // Pinned so a future "just raise it" change has to argue with the measurement rather than slip through:
  // every success in the audited run used one hop, and admission is unchanged at 3, 8 and 20.
  assert.equal(REOPEN_MAX_HOPS, 3);
});

test('an instance with no recorded path yields no attempts, never a bare guess', () => {
  const g = graph();
  assert.deepEqual(reopenAttempts(g, g.elements[30], g.elements[30].instances[0]), [],
    'nothing to work from must be reported honestly as nothing, not approximated');
});
