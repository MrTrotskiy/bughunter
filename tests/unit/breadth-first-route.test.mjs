// BREADTH ALLOCATION — the drained path must consult the BFS queue BEFORE a with-work re-visit.
//
// `stateful-loop` takes the "where next" decision at TWO seams and they disagreed about the order:
//   - the BUDGET-YIELD path (a route still holds work but has spent its ROUTE_ACT_BUDGET quantum) asks
//     `takeQueuedRoute` FIRST and falls back to `pickRoute`. Its own comment records why: draining a route
//     to fixpoint before the queue got a turn meant the queue never got one (49 routes discovered, 3
//     visited), and decisions.md carries the same lesson.
//   - the DRAINED path (nothing resolvable left on the current route) did the INVERSE — `pickRoute` first,
//     the queue only as a fallback — so it structurally preferred a page it had already been to.
//
// The drained path DOMINATES: measured on run hunt3 (200 acts, --stateful --explore-all), 39 `drained`
// drain-outcomes against 2 `budget`, so the inverted seam WAS the crawl's breadth policy. Consequences,
// all read off that run's trail: 30 of 35 route transitions used `least-visited` and only 5 `bfs-queue`;
// the final graph held 13 routes visited against 53 pending, and those 53 were 52 DISTINCT first-segment
// sections (/groups, /events, /items, /setting, /reports, /media, /articles, /billing, /earnings,
// /membership …) — not one a variant of a page already seen; 33 navigations produced no act at all
// (`pick-empty`), 16 of them on profile pages and 12 on the dashboard.
//
// NO VISIT CAP HERE, DELIBERATELY. A per-pattern repeat cap belongs with the URL-masker change that is
// sequenced next, not with this reorder, and the evidence is arithmetic: the pages the diagnosis cites are
// `/profile/<base64>`, and `toUrlPattern` masks only digit / uuid / long-hex segments — so it returns
// each of those routes UNCHANGED and each profile is its own pattern. A cap keyed on today's masker would
// group nothing and never fire on the very case it was proposed for. GOAL.md also requires such a cap to
// WIDEN when pages disagree, and the disagreement signal (`contentSig`) is written only by
// `route-frontier.visitRoute` — the stateful driver's `goToRoute` never writes one, so on this path the
// widening rule has no input to read. Fix the ordering, re-measure, then decide whether a cap is still owed.
//
// Guards: the drained path prefers a NEVER-OPENED page over a re-visit; the with-work fallback still fires
//   when the queue is empty (the recorded regression where an early breadth yield consulted only the queue
//   and refunded its budget on the spot — runs of 38 consecutive acts under a declared cap of 20); and the
//   single-drain property of `takeQueuedRoute` (the ONE queue drain) holds across both callers.
//
// FAIL-ON-REVERT (one lever per test, each PROVEN red and recorded on its assertion):
//   - restore the old order on the drained path (`pickRoute` first, queue only as the `!next` fallback)
//     → "a page the crawl has NEVER OPENED" reds with `chose /b`.
//   - drop the with-work fallback (`const next = null`, queue-only) → "the with-work fallback must survive
//     the reorder" reds with `chose null`.
//   - consume a route off the queue and skip the travel (`if (queued === '/q2') continue;` before the
//     trace) → "each queued page was opened, and only the queued ones" reds with `["/q1","/q3"]`.
//     The related lever — deleting `markRouteVisited` from `takeQueuedRoute` — is load-bearing in a way no
//     assertion can catch: `nextPendingRoute` re-returns the route we are STANDING on, `rk !== cur` keeps
//     rejecting it and the `for(;;)` never exits. It SPINS rather than reds, which is precisely the
//     failure that function's own comment claims it prevents; the silent-drop lever above is used instead
//     because a hang proves the code matters without telling a reader what broke.
//
// NO BROWSER (layer rule): the loop is driven with an injected step + a page stub, exactly as
// decision-trail.test.mjs / route-timings.test.mjs do. Every value asserted is Node-side — no page.evaluate,
// no CDP call, no navigation, so no causal window is opened and attribution is untouched.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { statefulLoop } from '../../lib/recon/stateful-loop.mjs';
import { makeGraph, mergeSnapshot } from '../../lib/graph/graph-store.mjs';
import { openRun, runDir } from '../../lib/debug/trace.mjs';

// ONE return value serves every page.evaluate the driver makes: waitSettled reads {total, inflight},
// snapshotDom reads {elements, opaque}, dismissOverlays ignores its result. A queued page therefore
// snapshots as EMPTY — which is the point: it must be chosen on being unopened, not on being rich.
const EVAL_RESULT = { elements: [], opaque: [], total: 1, inflight: 0 };
const handle = { isVisible: async () => true, evaluate: async () => true };

const elem = (templateSelector, name) => ({
  templateSelector, instanceKey: '#1', instanceSelector: templateSelector,
  name, role: 'button', visible: true, locator: null,
});

function fakePage(startUrl, resolvable = () => true) {
  let url = startUrl;
  return {
    url: () => url,
    goto: async (to) => { url = to; return null; },
    evaluate: async () => EVAL_RESULT,
    keyboard: { press: async () => {} },
    $: async (sel) => (resolvable(sel) ? handle : null),
    $$: async () => [],
  };
}

function useRun(t, id) {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-breadth-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const prevState = process.env.BUGHUNTER_STATE_DIR;
  const prevRun = process.env.BUGHUNTER_RUN_ID;
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  process.env.BUGHUNTER_RUN_ID = id;
  t.after(() => {
    if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState;
    if (prevRun === undefined) delete process.env.BUGHUNTER_RUN_ID; else process.env.BUGHUNTER_RUN_ID = prevRun;
  });
  openRun({ runId: id, target: 'https://x.test/a' });
  return id;
}

function events(runId, kind) {
  return fs.readFileSync(path.join(runDir(runId), 'events.ndjson'), 'utf8')
    .split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.kind === kind);
}

// /a: one control, acted then drained. /b: a route still holding an unexplored control (the with-work
// candidate). Pending routes are added by the caller — mergeSnapshot mints route nodes WITHOUT `pending`,
// so nothing enters the BFS queue except what a test puts there.
function graphWithWork(pending = []) {
  const graph = makeGraph();
  mergeSnapshot(graph, '/a', [{ ...elem('main > button.a', 'Alpha'), templateId: 1, instanceId: 1 }]);
  mergeSnapshot(graph, '/b', [{ ...elem('main > button.b', 'Beta'), templateId: 2, instanceId: 2 }]);
  for (const rk of pending) graph.routes[rk] = { type: 'route', url: rk, pending: true, pattern: rk, siblings: 0 };
  return graph;
}

const noopStep = async (_g, target) => ({ newElements: [], requests: [], route: target.route });

test('the drained path takes the QUEUED route even when a with-work route is available', async (t) => {
  const runId = useRun(t, 'r-20260720000000-bf01');

  const graph = graphWithWork(['/queued-page']);
  const res = await statefulLoop(graph, {
    page: fakePage('https://x.test/a'), origin: 'https://x.test', ledger: {},
    step: noopStep, runId, budget: { steps: 2 },
  });

  const drained = events(runId, 'route-choice').filter((e) => e.payload.trigger === 'drained');
  assert.ok(drained.length >= 1, 'precondition: the drained path took at least one destination decision');
  const first = drained[0].payload;

  // The lever. With `pickRoute` consulted first this reads source 'with-work' / chosen '/b'.
  // FAIL-ON-REVERT: a page the crawl has NEVER OPENED
  assert.equal(first.chosen, '/queued-page',
    `the drained path must travel to a page the crawl has NEVER OPENED before re-visiting one it has `
    + `already drained (chose ${first.chosen}) — consulting the with-work set first is how run hunt3 spent `
    + '30 of 35 transitions on already-visited routes while 52 distinct sections stayed pending');
  assert.equal(first.source, 'queue', `the destination came off the BFS queue (got ${first.source})`);
  assert.equal(first.rule, 'bfs-queue', `the rule that supplied it is named (got ${first.rule})`);

  // Without this the assertion above is vacuous: it must be a CHOICE, not the only option there was.
  // FAIL-ON-REVERT: a with-work route really was available and LOST
  assert.ok(first.eligible >= 1,
    `a with-work route really was available and LOST to the queue (eligible: ${first.eligible}) — if the `
    + 'census were empty the queue would have won by default and this test would guard nothing');
  assert.equal(first.censused, true,
    'the with-work census is still recorded on the queue-first decision — "which pages holding untouched '
    + 'controls did we walk past" is the substance of a breadth choice, and the dominant path must not be '
    + 'the one with no record');
  assert.equal(first.travelled, true, 'the move was actually made, not merely chosen');
  assert.ok(res.steps.length >= 1, 'the run acted (else no drained decision could have been reached)');
});

test('with an EMPTY queue the with-work fallback still fires', async (t) => {
  const runId = useRun(t, 'r-20260720000000-bf02');

  // Same graph, nothing pending: the queue has nobody to offer, so a route still holding unexplored
  // controls must be chosen. This is the recorded regression — an early breadth yield consulted ONLY the
  // queue and fell through to `continue`, re-entering the drain with a FRESH budget on the same route
  // (runs of 38 and 37 consecutive acts under a declared cap of 20, and distinct routes acted 28 → 25).
  const graph = graphWithWork([]);
  await statefulLoop(graph, {
    page: fakePage('https://x.test/a'), origin: 'https://x.test', ledger: {},
    step: noopStep, runId, budget: { steps: 2 },
  });

  const drained = events(runId, 'route-choice').filter((e) => e.payload.trigger === 'drained');
  assert.ok(drained.length >= 1, 'precondition: the drained path took a destination decision');
  const first = drained[0].payload;

  // FAIL-ON-REVERT: the with-work fallback must survive the reorder
  assert.equal(first.chosen, '/b',
    `the with-work fallback must survive the reorder: with an empty queue the driver still travels to a `
    + `route holding unexplored controls (chose ${first.chosen}) — dropping it would strand every `
    + 'undrained page the moment the BFS queue runs dry');
  assert.equal(first.source, 'with-work', `the destination is named as a with-work route (got ${first.source})`);
  assert.equal(first.rule, 'least-visited', `the rule that picked it among the eligible is named (got ${first.rule})`);
  assert.equal(first.travelled, true, 'the move was actually made');
});

test('the single-drain property holds: no route is taken off the queue twice', async (t) => {
  const runId = useRun(t, 'r-20260720000000-bf03');

  const queued = ['/q1', '/q2', '/q3'];
  const graph = graphWithWork(queued);
  const res = await statefulLoop(graph, {
    page: fakePage('https://x.test/a'), origin: 'https://x.test', ledger: {},
    step: noopStep, runId, budget: { steps: 20 },
  });

  const fromQueue = events(runId, 'route-choice')
    .filter((e) => e.payload.source === 'queue').map((e) => e.payload.chosen);

  // FAIL-ON-REVERT: taken off the queue exactly once
  assert.equal(new Set(fromQueue).size, fromQueue.length,
    `every route is taken off the queue exactly once — got ${JSON.stringify(fromQueue)}. `
    + '`takeQueuedRoute` is the ONE queue drain precisely so its two callers cannot double-take; a repeat '
    + 'would mean markRouteVisited stopped clearing `pending` before travel and the driver can spin');
  assert.deepEqual([...fromQueue].sort(), queued,
    `each queued page was opened, and only the queued ones (got ${JSON.stringify(fromQueue)})`);

  const stillPending = Object.keys(graph.routes).filter((rk) => graph.routes[rk].pending);
  assert.deepEqual(stillPending, [],
    `the queue really drained (still pending: ${JSON.stringify(stillPending)}) — a route left pending while `
    + 'the loop reports a terminal is the phantom-denominator shape this driver must never produce');
  assert.equal(res.stopped, 'frontier-drained',
    `the loop terminates honestly once BOTH the queue and the with-work set are empty (got ${res.stopped})`);
});
