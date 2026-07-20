// ROUTE-STAGE TIMINGS — the run's missing time is NAVIGATION, and the trail could not say so.
//
// Attributing every inter-event gap to the event that follows it, over two real runs:
//   hygge2 (wall 1504s): route n=662 gap=1032s (68.6%), act n=301 gap=312s (20.7%), act.failed n=54 gap=160s
//   goal1  (wall 2196s): route n=537 gap=1645s (74.9%), mean 3063ms, max 38279ms
// The act path is ~78% self-explained by the {actMs, settleMs, snapMs} timings step.mjs already emits.
// The route path was 0% explained across 1200 route events — `payload.timings` was undefined on every one
// of them, because `goToRoute` emitted its event with no durations at all. So the project's own record
// ("613 of 663 navigations produced neither an act nor a single new element — 64% of a 25-minute run")
// could be counted and never diagnosed: nobody could say WHERE that time went. Per this repo's log rule
// an uninformative trail is a defect to fix, not a limitation to work around.
//
// Guards: every `route` event carries {gotoMs, settleMs, overlayMs, snapMs, totalMs} — the same field
//   names step.mjs uses, so ONE renderer draws an act row and a route row — and `totalMs` is the whole
//   function's wall time, NEVER the sum of the parts. The difference is unaccounted work and the trail
//   must keep it visible; a summed total would report zero unaccounted time by construction.
// FAIL-ON-REVERT: drop the `timings` field from the traceEvent call in stateful-loop.mjs goToRoute (or
//   revert any stage bracket) → "the route event must carry stage timings" reds; fabricate
//   `totalMs` by summing the parts and the gap assertion below can no longer see unaccounted work
//   (it degenerates to equality), while removing the goto bracket reds "the navigation stage must be
//   measured into gotoMs".
//
// Timings are REPORTING ONLY. performance.now() is a Node-side clock read — no evaluate, no screenshot,
// no CDP call — so it opens no causal window; causal attribution stays token + CDP initiator and must
// never be fed by a wall clock. This test drives the loop with injected fakes and launches no browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { statefulLoop } from '../../lib/recon/stateful-loop.mjs';
import { makeGraph, mergeSnapshot } from '../../lib/graph/graph-store.mjs';
import { openRun, runDir } from '../../lib/debug/trace.mjs';

// How long the fake navigation takes. Not a wait — it FORCES a measurable stage so the assertion that
// `gotoMs` tracks the goto cannot pass on a field hard-wired to 0.
const GOTO_MS = 30;

function elem(templateSelector, name, role = 'button') {
  return { templateSelector, instanceKey: '#1', instanceSelector: templateSelector, name, role, visible: true, locator: null };
}

// ONE return value serves every page.evaluate the navigation path makes: waitSettled reads
// {total, inflight} (total>0 && inflight===0 → settled on the first poll), snapshotDom reads
// {elements, opaque}, and dismissOverlays only passes its result back to a caller that ignores it.
const EVAL_RESULT = { elements: [], opaque: [], total: 1, inflight: 0 };

function fakePage(startUrl) {
  let url = startUrl;
  const handle = { isVisible: async () => true, evaluate: async () => true };
  return {
    url: () => url,
    goto: async (to) => { await new Promise((r) => setTimeout(r, GOTO_MS)); url = to; return null; },
    evaluate: async () => EVAL_RESULT,
    keyboard: { press: async () => {} },
    $: async () => handle,
    $$: async () => [handle],
  };
}

test('a route event explains its own wall time: stage timings, with the unaccounted gap left visible', async (t) => {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-routetimings-'));
  t.after(() => rmSync(stateDir, { recursive: true, force: true }));
  const prevState = process.env.BUGHUNTER_STATE_DIR;
  process.env.BUGHUNTER_STATE_DIR = stateDir;
  t.after(() => { if (prevState === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prevState; });

  const runId = 'r-20260720000000-rt01';
  openRun({ runId, target: 'https://x.test/a' });

  // Two pages, one control each: the driver drains /a, finds /a has nothing resolvable left, and
  // BACKTRACKS to /b — which is the only way goToRoute runs.
  const graph = makeGraph();
  mergeSnapshot(graph, '/a', [{ ...elem('main > button.a', 'Alpha'), templateId: 1, instanceId: 1 }]);
  mergeSnapshot(graph, '/b', [{ ...elem('main > button.b', 'Beta'), templateId: 2, instanceId: 2 }]);

  const page = fakePage('https://x.test/a');
  const step = async (_g, target) => ({ newElements: [], requests: [], route: target.route });

  await statefulLoop(graph, {
    page, origin: 'https://x.test', ledger: {}, step, runId, budget: { steps: 2 },
  });

  const lines = fs.readFileSync(path.join(runDir(runId), 'events.ndjson'), 'utf8').split('\n').filter(Boolean);
  const routes = lines.map((l) => JSON.parse(l)).filter((e) => e.kind === 'route');
  // Non-vacuity: no navigation, no event, and every assertion below would be about nothing.
  assert.equal(routes.length, 1, 'the driver navigated to /b exactly once (else this test asserts nothing)');
  assert.equal(routes[0].payload.route, '/b', 'the event describes the backtrack navigation');

  const timings = routes[0].payload.timings;
  // FAIL-ON-REVERT: the route event must carry stage timings
  assert.ok(timings, 'the route event must carry stage timings — 1200 of 1200 audited route events had none, '
    + 'so 68-75% of both runs\' wall time was unexplained');

  for (const field of ['gotoMs', 'settleMs', 'overlayMs', 'snapMs', 'totalMs']) {
    assert.equal(typeof timings[field], 'number', `${field} is a number (got ${JSON.stringify(timings[field])})`);
    assert.ok(timings[field] >= 0, `${field} is non-negative (got ${timings[field]})`);
  }

  const parts = timings.gotoMs + timings.settleMs + timings.overlayMs + timings.snapMs;
  // THE SHAPE THAT MAKES THE FIELD USEFUL: the total is measured, not summed, so `totalMs - parts` is
  // real unaccounted work. Summing the parts into totalMs would make this hold as an identity and
  // silently delete the only signal that says "the time went somewhere we are not measuring".
  assert.ok(timings.totalMs >= parts,
    `totalMs (${timings.totalMs}) must cover the sum of its named stages (${parts}) — the difference is the `
    + 'unaccounted work the trail exists to expose');

  // The delayed stage lands in ITS OWN field: proof the five numbers measure the five stages rather than
  // being a constant or all folded into one bucket.
  assert.ok(timings.gotoMs >= GOTO_MS / 2,
    `the navigation stage must be measured into gotoMs — the fake goto took ~${GOTO_MS}ms, gotoMs reads ${timings.gotoMs}`);
  assert.ok(timings.totalMs >= timings.gotoMs, 'the whole is never smaller than its largest measured stage');
});
