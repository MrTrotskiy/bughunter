// THE DECISION CHAIN IN THE TRAIL — "what did the script do, how, and why did it choose that?"
//
// The question has been asked four different ways across this project and four viewer iterations failed
// to answer it. The reason was never the UI: the decisions were COMPUTED AND DISCARDED, so there was
// nothing to render. Three seams in `stateful-loop` and one in `explore-policy` each took a choice and
// wrote down only its aftermath:
//   - `pickLive` ranked every eligible control on the route and probed them in order. Only the EMPTY
//     scan traced (`pick-empty`); a SUCCESSFUL pick recorded nothing — not how many were eligible, not
//     what ranked this one first, not what lost.
//   - `pickRoute` filtered the routes still holding work through four rules and chose least-visited.
//     The eligible set, the rule and every rejection were thrown away, so "why did it travel there" and
//     "why not to the page holding 25 untouched controls" had no answer on disk.
//   - `retireLeftovers` decided churn / unreachable / deferred per leftover and recorded none of it.
//   - `explore-policy.decide` surfaced only REFUSALS, and only because a refusal throws. Measured on run
//     `raw1`: 8 refusals recorded against ~279 permits that left no trace at all — so on ~97% of acts the
//     trail could not show that a decision had even been taken.
//
// NOTHING HERE IMPLIES COGNITION. `recon-run` → `statefulLoop` has no model stage: the rank is a
// comparator, the route is a min over a visit counter, the stop is a budget comparison, the permit is a
// rule table. The events say what was eligible, what ranked how, what was chosen, and what was rejected
// by which rule — that is the whole of what happened.
//
// Guards: a successful pick names its candidate count + the chosen element; a PERMIT is traced, not only
//   a refusal; a route yield names the rule that ended work on the page it left; and truncation is honest
//   (the true total plus a `truncated` marker whenever the sample list is capped).
//
// FAIL-ON-REVERT (one lever per test, each recorded on its assertion):
//   - delete the traceEvent(runId,'pick',…) block in pickLive → "a SUCCESSFUL pick must be traced" reds.
//   - delete the tracePolicy() call in explore-policy.decide → "a PERMIT must be traced" reds.
//   - drop the traceRouteChoice call on the `outcome === 'budget'` yield → "the breadth budget" reds.
//   - hard-code `truncated: false` / drop `rejectedTotal` in the pick payload → "the true total" reds.
//
// NO BROWSER (layer rule): every value emitted is Node-side and already in memory — array lengths, Map
// lookups, graph fields the driver just read. That is also the causal argument: these events add no
// page.evaluate, no screenshot, no CDP call and no navigation, so no causal window is opened and
// attribution stays exactly what statefulStep produced. The loop is driven with an injected step + a
// page stub, as `route-timings.test.mjs` and `reveal-recency.test.mjs` do.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { statefulLoop } from '../../lib/recon/stateful-loop.mjs';
import { decide, OWNERSHIP } from '../../lib/recon/explore-policy.mjs';
import { makeGraph, mergeSnapshot } from '../../lib/graph/graph-store.mjs';
import { openRun, runDir } from '../../lib/debug/trace.mjs';

// ONE return value serves every page.evaluate the driver makes: waitSettled reads {total, inflight},
// snapshotDom reads {elements, opaque}, dismissOverlays ignores its result.
const EVAL_RESULT = { elements: [], opaque: [], total: 1, inflight: 0 };
const handle = { isVisible: async () => true, evaluate: async () => true };

function elem(templateSelector, name, role = 'button') {
  return { templateSelector, instanceKey: '#1', instanceSelector: templateSelector, name, role, visible: true, locator: null };
}

// `resolvable` decides which stored selectors produce a live handle. Everything else answers null, and
// with no getByRole/getByText on the stub the durable ladder throws into resolveWithAttempts' own catch
// — the same honest null a genuinely absent control produces.
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

// Point the trail at a temp dir and publish a run id, restoring both afterwards. Returns the run id.
function useRun(t, id) {
  const stateDir = mkdtempSync(path.join(tmpdir(), 'bughunter-decision-'));
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
  const f = path.join(runDir(runId), 'events.ndjson');
  return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean)
    .map((l) => JSON.parse(l)).filter((e) => e.kind === kind);
}

test('a successful pick names the candidate count and the element it chose', async (t) => {
  const runId = useRun(t, 'r-20260720000000-dc01');

  // Three eligible controls on one route; all resolve, so the FIRST in rank order is picked and the
  // other two lose on rank without ever being probed.
  const graph = makeGraph();
  mergeSnapshot(graph, '/a', [
    { ...elem('main > button.a', 'Alpha'), templateId: 1, instanceId: 1 },
    { ...elem('main > button.b', 'Beta'), templateId: 2, instanceId: 2 },
    { ...elem('main > button.c', 'Gamma'), templateId: 3, instanceId: 3 },
  ]);

  const acted = [];
  const step = async (_g, target) => { acted.push(target.templateId); return { newElements: [], requests: [], route: '/a' }; };
  await statefulLoop(graph, {
    page: fakePage('https://x.test/a'), origin: 'https://x.test', ledger: {}, step, runId, budget: { steps: 1 },
  });

  assert.equal(acted.length, 1, 'exactly one act ran (else the assertions below describe a different pick)');
  const picks = events(runId, 'pick');
  // FAIL-ON-REVERT: a SUCCESSFUL pick must be traced
  assert.equal(picks.length, 1, 'a SUCCESSFUL pick must be traced — before this, only the EMPTY scan '
    + '(`pick-empty`) wrote anything, so the trail could never say why an element was the one clicked');

  const p = picks[0].payload;
  assert.equal(p.candidates, 3, `the event names how many candidates were eligible on the route (got ${p.candidates})`);
  assert.equal(p.chosen.templateId, acted[0], 'the event names the element that was actually acted');
  assert.equal(p.route, '/a', 'the decision is scoped to the route it was taken on');
  assert.equal(typeof p.chosen.rule, 'string', 'the chosen element carries the RULE that ranked it, not just a number');
  assert.equal(p.probed + p.outranked, p.candidates,
    `every candidate is accounted for: probed (${p.probed}) + outranked (${p.outranked}) must equal `
    + `candidates (${p.candidates}) — a decision record whose parts do not sum hides the ones it dropped`);
});

test('a PERMIT is traced, not only a refusal', async (t) => {
  const runId = useRun(t, 'r-20260720000000-dc02');

  // An ordinary, fully-permitted act — the ~97% case that produced no record at all.
  const v = decide({ name: 'Save changes', route: '/settings', ownership: OWNERSHIP.OWN });
  assert.equal(v.allow, true, 'precondition: this control is permitted (else the test asserts nothing)');

  const verdicts = events(runId, 'policy-verdict');
  // FAIL-ON-REVERT: a PERMIT must be traced
  assert.equal(verdicts.length, 1, 'a PERMIT must be traced — run raw1 recorded 8 refusals against ~279 '
    + 'invisible permits, so the trail could not show a decision had been taken on almost any act');
  const p = verdicts[0].payload;
  assert.equal(p.allow, true, 'the verdict records that the act was ALLOWED');
  assert.equal(p.code, 'ALLOWED', `the verdict names the rule code that permitted it (got ${p.code})`);
  assert.equal(p.ownership, OWNERSHIP.OWN, 'the live ownership proof the rail was applied to is recorded');
  assert.equal(p.name, 'Save changes', 'the control the decision was about is named');
  assert.equal(p.calls, 1, 'the monotone decision count rides along, so folded repeats stay recoverable');

  // The fold is LOSSLESS, not a sample: an identical consecutive verdict emits nothing, and the NEXT
  // distinct one carries a `calls` that says exactly how many were folded.
  decide({ name: 'Save changes', route: '/settings', ownership: OWNERSHIP.OWN });
  assert.equal(events(runId, 'policy-verdict').length, 1, 'an identical consecutive verdict folds into the first');
  decide({ name: 'Delete post', route: '/settings', ownership: OWNERSHIP.FOREIGN });
  const after = events(runId, 'policy-verdict');
  assert.equal(after.length, 2, 'a DIFFERENT verdict emits its own record');
  assert.equal(after[1].payload.calls - after[0].payload.calls - 1, 1,
    'the folded count is exactly recoverable from `calls` — the denominator never silently collapses');
});

test('a route yield names the rule that ended work on the page it left', async (t) => {
  const runId = useRun(t, 'r-20260720000000-dc03');

  // 21 controls on /a and one on /b: the breadth quantum (ROUTE_ACT_BUDGET = 20) is spent on /a while /a
  // still holds work, so the driver YIELDS to /b. That yield is the decision under test.
  const graph = makeGraph();
  const rich = [];
  for (let i = 0; i < 21; i++) rich.push({ ...elem(`main > button.a${i}`, `A${i}`), templateId: 10 + i, instanceId: 10 + i });
  mergeSnapshot(graph, '/a', rich);
  mergeSnapshot(graph, '/b', [{ ...elem('main > button.b', 'Beta'), templateId: 500, instanceId: 500 }]);

  const step = async (_g, target) => ({ newElements: [], requests: [], route: target.route });
  await statefulLoop(graph, {
    page: fakePage('https://x.test/a'), origin: 'https://x.test', ledger: {}, step, runId, budget: { steps: 22 },
  });

  const drains = events(runId, 'drain-outcome');
  assert.ok(drains.some((e) => e.payload.outcome === 'budget'),
    'precondition: the breadth budget was actually spent (else no yield happened to observe)');

  const choices = events(runId, 'route-choice');
  // FAIL-ON-REVERT: the breadth budget
  const yielded = choices.find((e) => e.payload.trigger === 'budget');
  assert.ok(yielded, 'a route yield must record WHICH rule ended work on the page — the breadth budget '
    + '(ROUTE_ACT_BUDGET) spent while the route still held unexplored controls');
  const p = yielded.payload;
  assert.equal(p.chosen, '/b', `the destination is named (got ${p.chosen})`);
  assert.equal(p.source, 'with-work', 'where the destination came from is named (a route still holding work)');
  assert.equal(p.rule, 'least-visited', 'the rule that picked it among the eligible is named');
  assert.equal(p.travelled, true, 'the record says whether the move was actually made');
  assert.equal(p.censused, true, 'the eligible/rejected census was computed for this decision');
});

test('truncation is honest: the true total and a truncation marker when the sample is capped', async (t) => {
  const runId = useRun(t, 'r-20260720000000-dc04');

  // Eight controls rank ahead of the ninth and NONE of them resolves; only `.hit` does. The scan probes
  // eight losers before its hit — more than the 5-wide sample cap, so the event must truncate and say so.
  const graph = makeGraph();
  const els = [];
  for (let i = 0; i < 8; i++) els.push({ ...elem(`main > button.dead${i}`, `Dead ${i}`), templateId: 10 + i, instanceId: 10 + i });
  els.push({ ...elem('main > button.hit', 'Live'), templateId: 900, instanceId: 900 });
  mergeSnapshot(graph, '/a', els);

  const acted = [];
  const step = async (_g, target) => { acted.push(target.templateId); return { newElements: [], requests: [], route: '/a' }; };
  await statefulLoop(graph, {
    page: fakePage('https://x.test/a', (sel) => sel === 'main > button.hit'),
    origin: 'https://x.test', ledger: {}, step, runId, budget: { steps: 1 },
  });

  assert.deepEqual(acted, [900], 'precondition: only the resolvable control was acted');
  const p = events(runId, 'pick')[0].payload;
  // FAIL-ON-REVERT: the true total
  assert.equal(p.rejectedTotal, 8, `the event carries the true total of what was probed and lost `
    + `(got ${p.rejectedTotal}) — a capped list that did not say how much it dropped would recreate, one `
    + 'level up, exactly the silent-collapse defect this record exists to remove');
  assert.equal(p.truncated, true, 'the event is marked truncated when the sample list is capped');
  assert.ok(p.rejected.length < p.rejectedTotal,
    `the sample really is capped (${p.rejected.length} listed of ${p.rejectedTotal}) — else the marker is vacuous`);
  assert.ok(p.rejected.every((r) => r.why === 'no-live-handle'),
    'every listed loser carries the reason it lost, not merely its name');
});
