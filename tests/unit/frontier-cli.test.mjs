// frontier-cli — the recon agent's "what to study next" tool. Pure graph read, no
// browser: it must surface the honest denominator and never hand the agent more than
// the receptive-field ceiling (2-5 elements), whatever --size is asked for.
//
// Guards: (1) the emitted denominator does not collapse — discovered stays constant as
//   templates are explored (honest coverage through the tool boundary); (2) the batch
//   is capped at the receptive-field ceiling so a bad --size can't blow the agent's
//   context (the founding failure of bughunt-agents); (3) emit surfaces instanceStats + a
//   progress verdict, drains to a DRAINED verdict, and writes instanceStats onto the
//   frontier.emit trail ONLY under --tick so the stall detector's MONOTONE progress signal
//   (walked + unreachable + walkable) flows back through readFrontierProgress as ONE sample
//   per DRIVER iteration — a non-tick emit (the subagent's own call) is history-neutral;
//   (4) INC.1b — emit surfaces the BFS route-queue depth (pendingRoutes/routeFrontierStats)
//   and threads it into the verdict, so an empty template batch with a queued page yields
//   'visit-route' (drain the route queue) instead of a premature 'drained'.
// FAIL-ON-REVERT: drop the `Math.min(size, MAX_SIZE)` clamp in frontier-cli.mjs → a
//   --size=50 request returns the whole frontier → "batch exceeded receptive-field
//   ceiling". Remove `instanceStats` from the traceEvent payload in frontier-cli.mjs →
//   readFrontierProgress goes blind → the tick trail-progress assertion reds ([] != [4]). Sum
//   only `walkable` (or read `remaining`) in readFrontierProgress → [3] / [2] != [4]. Remove
//   the `if (opts.tick)` gate (always write instanceStats) → a non-tick emit carries
//   instanceStats and readFrontierProgress returns [4] → the history-neutral assertion reds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeGraph, mergeSnapshot, markExplored, saveGraph } from '../../lib/graph/graph-store.mjs';
import { emit } from '../../lib/recon/frontier-cli.mjs';
import { runDir, readFrontierProgress } from '../../lib/debug/trace.mjs';

function withStateDir(t, n) {
  const dir = mkdtempSync(path.join(tmpdir(), 'bughunter-fcli-'));
  const prev = process.env.BUGHUNTER_STATE_DIR;
  process.env.BUGHUNTER_STATE_DIR = dir;
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    if (prev === undefined) delete process.env.BUGHUNTER_STATE_DIR; else process.env.BUGHUNTER_STATE_DIR = prev;
  });
  const g = makeGraph();
  const els = [];
  for (let i = 1; i <= n; i++) {
    els.push({
      templateId: i, instanceId: i * 100, templateSelector: `button.b${i}`,
      role: 'button', name: `B${i}`, instanceKey: `#${i}`, instanceSelector: `button.b${i}:nth-child(${i})`,
    });
  }
  mergeSnapshot(g, '/', els);
  return { dir, g, graphPath: path.join(dir, 'graph.json') };
}

test('emitted denominator does not collapse as templates are explored', (t) => {
  const { g, graphPath } = withStateDir(t, 3);
  saveGraph(graphPath, g);
  assert.deepEqual(emit().stats, { discovered: 3, explored: 0, unreachable: 0, remaining: 3, routes: 1 });

  markExplored(g, 1);
  markExplored(g, 2);
  saveGraph(graphPath, g);
  assert.deepEqual(emit().stats, { discovered: 3, explored: 2, unreachable: 0, remaining: 1, routes: 1 }, 'discovered must not shrink');
});

test('batch is capped at the receptive-field ceiling regardless of --size', (t) => {
  const { g, graphPath } = withStateDir(t, 8);
  saveGraph(graphPath, g);
  const batch = emit({ size: 50 }).batch;
  assert.ok(batch.length <= 5, `batch exceeded receptive-field ceiling: ${batch.length}`);
});

test('emit returns instanceStats and a progress verdict', (t) => {
  const { g, graphPath } = withStateDir(t, 3);
  saveGraph(graphPath, g);
  const res = emit();
  assert.ok(res.instanceStats, 'instanceStats present');
  assert.equal(res.instanceStats.remaining, 3, '3 plain templates → 3 walkable instances remaining');
  assert.ok(res.progress, 'progress verdict present');
  // 3 remaining, non-empty batch, no runId ⇒ no history ⇒ never stalled ⇒ continue.
  assert.equal(res.progress.action, 'continue');
});

test('drained verdict on a fully-explored graph', (t) => {
  const { g, graphPath } = withStateDir(t, 1);
  markExplored(g, 1);
  saveGraph(graphPath, g);
  const res = emit();
  assert.equal(res.batch.length, 0, 'nothing left to hand out');
  assert.equal(res.progress.action, 'drained');
});

// INC.1b: emit surfaces the BFS route-frontier queue (pendingRoutes + routeFrontierStats) so the
// /recon driver and decideProgress can drain queued PAGES after the template frontier empties. A
// fully-explored template frontier with a route still queued yields a 'visit-route' verdict, NOT
// 'drained' — the crawl is not done while a page waits to be snapshotted.
// Guards: the emit envelope carries the route-frontier queue depth (pendingRoutes/routeFrontierStats)
//   and threads it into the verdict so an empty batch + pending route → visit-route.
// FAIL-ON-REVERT: drop `pendingRoutes` from the decideProgress call in frontier-cli.mjs → an empty
//   batch with a pending route returns 'drained' → "an empty batch with a queued route must
//   visit-route" reds.
test('emit surfaces pendingRoutes + routeFrontierStats and yields a visit-route verdict', (t) => {
  const { g, graphPath } = withStateDir(t, 1);
  markExplored(g, 1); // template frontier empty
  // A page the BFS harvest discovered but has not yet snapshot-visited.
  g.routes['/beyond'] = { type: 'route', url: '/beyond', pending: true, pattern: '/beyond', siblings: 0 };
  saveGraph(graphPath, g);

  const res = emit();
  assert.equal(res.batch.length, 0, 'template frontier is empty');
  assert.equal(res.pendingRoutes, 1, 'the queued route is surfaced as pendingRoutes');
  assert.ok(res.routeFrontierStats, 'routeFrontierStats present in the emit envelope');
  assert.equal(res.routeFrontierStats.pending, 1, 'routeFrontierStats.pending counts the queued page');
  assert.equal(res.progress.action, 'visit-route', 'an empty batch with a queued route must visit-route, not drain');
});

// The --tick GATE: with a runId set, emit records instanceStats onto the frontier.emit trail — the
// per-window MONOTONE progress signal readFrontierProgress serves back to the stall detector — ONLY
// when the DRIVER passes --tick. Without --tick (the recon subagent's own --emit, on the SAME runId
// BEFORE it acts), the event carries candidates+stats but NO instanceStats, so it is history-neutral
// (readFrontierProgress skips it). This is the false-stall fix: if the subagent's --emit ALSO wrote a
// sample, one dead iteration would stamp TWO flat samples and trip STALL_WINDOWS=3 after a single
// dead pass. A discriminating fixture (one of 3 plain templates explored → walked=1) makes progress
// (walked+unreachable+walkable = 1+0+3 = 4) differ from remaining (2), so the tick assertion proves
// the SUM flows, not `remaining`. Removing the `if (opts.tick)` gate (always writing instanceStats)
// reds the history-neutral assertion; removing instanceStats entirely reds the tick assertion.
test('emit writes instanceStats onto the frontier.emit trail ONLY under --tick (else history-neutral)', (t) => {
  const { g, graphPath } = withStateDir(t, 3);
  markExplored(g, 1); // walked=1, so progress (4) != remaining (2) — the tick assertion distinguishes them
  saveGraph(graphPath, g);
  const runId = 'r-fcli-trail-test';
  const prev = process.env.BUGHUNTER_RUN_ID;
  process.env.BUGHUNTER_RUN_ID = runId;
  t.after(() => {
    if (prev === undefined) delete process.env.BUGHUNTER_RUN_ID; else process.env.BUGHUNTER_RUN_ID = prev;
  });

  const file = path.join(runDir(runId), 'events.ndjson');
  const readEvents = () => readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));

  // Non-tick emit (the subagent path): a frontier.emit event with NO instanceStats → history-neutral.
  emit();
  const nonTick = readEvents().find((e) => e.kind === 'frontier.emit');
  assert.ok(nonTick, 'a frontier.emit event was written on a non-tick emit');
  assert.equal(nonTick.payload.instanceStats, undefined, 'a non-tick emit carries NO instanceStats');
  assert.ok(nonTick.payload.stats, 'a non-tick emit still carries the template stats');
  assert.deepEqual(readFrontierProgress(runId), [], 'a non-tick emit is history-neutral (no progress sample)');

  // Tick emit (the DRIVER path): instanceStats present + readFrontierProgress surfaces the progress.
  emit({ tick: true });
  const tickEv = readEvents().reverse().find((e) => e.kind === 'frontier.emit' && e.payload.instanceStats);
  assert.ok(tickEv, 'a --tick emit writes a frontier.emit event carrying instanceStats');
  assert.equal(tickEv.payload.instanceStats.walked, 1, 'one template explored → walked=1');
  assert.equal(tickEv.payload.instanceStats.remaining, 2, 'remaining (2) differs from progress (4)');
  // The trail reader surfaces THIS window's PROGRESS (walked+unreachable+walkable = 4), the monotone
  // signal the stall detector reads — NOT the flat-prone `remaining` (2). Only the tick sample counts.
  assert.deepEqual(readFrontierProgress(runId), [4], 'exactly one progress sample — the driver tick');
});
