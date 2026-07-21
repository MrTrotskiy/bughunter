// walk-view — every SENTENCE and NUMBER the admin walk prints, extracted out of admin.html so this
// test can execute it. The six defects audited on run `fix1` were each an inconsistency BETWEEN the
// writer, the projection (scrub-math.deriveSteps) and the renderer (walk-view). This file runs all
// three together against fix1-SHAPED payloads — the exact field shapes verified against the live
// run — so a reverted projection or a reverted renderer goes red naming the count.
//
// Guards: the walk renders the six resolver attempts on a failure card (projection carries
//   `target`); the KPI headline is the INSTANCE number with the policy-vs-owed split, not the
//   template count; a DISABLED act is a FINDING and never called unreachable; a request row carries
//   its response status.
// FAIL-ON-REVERT, each verified RED by hand:
//   (a) drop `target` from scrub-math.deriveSteps → the failure card prints «резолвер не оставил
//       списка попыток» and «стратегий в цепочке» disappears → test 1 reds ("attempts must render").
//   (b) point kpiHtml back at run.stats (template counts) instead of instanceStats → the headline
//       reads 118/295 → test 2 reds ("headline must be the instance number 148/693").
//   (c) restore the old unconditional verdict «Отмечен недостижимым…: N» on every class → test 3
//       reds ("DISABLED must not be called unreachable").
//   (d) drop `status` from walk-view.requestRowsHtml → test 4 reds ("row must carry status 500").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSteps } from '../../lib/debug/scrub-math.mjs';
import * as W from '../../lib/debug/walk-view.mjs';
import { frontierInstanceStats } from '../../lib/recon/frontier.mjs';

/* -------------------------------------------------------------------- fix1-shaped fixtures */

// One `act.failed` event, shaped EXACTLY as trace writes it on fix1 (verified against the live
// trail): `target` carries the six per-strategy resolver records + hadRevealPath, `skeleton` names
// the DOM skeleton file, `shots` are null (the run had no BUGHUNTER_VIEW). `strategies` lets a test
// dial which one resolved.
function failedAct(seq, code, { name = '', role = 'combobox', route = '/form-a', hadRevealPath = false, ranStrategy = 'selector', revealReplay = null } = {}) {
  const STRATS = ['selector', 'testid', 'id', 'role-name', 'label', 'text'];
  const attempts = STRATS.map((strategy) => strategy === ranStrategy
    ? { strategy, ran: true, raw: 1, visible: 1, sameTemplate: null }
    : { strategy, ran: false, raw: 0, visible: 0, sameTemplate: null });
  return {
    seq, ts: 1784613900000 + seq, kind: 'act.failed',
    payload: {
      templateId: 400 + seq, instance: '#1', instanceKey: '#1', name, role, requested: route,
      instanceSelector: '#device', code, clicked: false, message: `elementHandle.click: Timeout`,
      error: `elementHandle.click: Timeout 5000ms exceeded.`,
      target: { templateId: 400 + seq, instanceKey: '#1', selector: '#device', attempts, hadRevealPath, locatorType: 'id' },
      ...(revealReplay ? { revealReplay } : {}),
      requests: [], revealed: 0, timings: { attemptMs: 2200 },
      shots: { before: null, after: null, rect: { x: 1062, y: 368, width: 273, height: 30 }, viewport: { width: 1440, height: 900 } },
      skeleton: `skel/f${String(seq).padStart(4, '0')}-t${400 + seq}-fail.json`,
    },
  };
}

// A successful `act` carrying a causally-attributed request WITH a response status — the seven-field
// shape verified on fix1 (method/urlPattern/origin/startedAt/status/resourceType/durationMs).
function act(seq, requests, route = '/form-a') {
  return {
    seq, ts: 1784613900000 + seq, kind: 'act',
    payload: { templateId: 100 + seq, name: 'btn', role: 'button', route, requests, revealed: 1, timings: { actMs: 700, settleMs: 120, snapMs: 60 } },
  };
}
const req = (method, urlPattern, status, durationMs = 150) => ({ method, urlPattern, origin: 'https://devapi.example.com', startedAt: 1784614000000, status, resourceType: 'XHR', durationMs });

// A graph whose instance-level partition matches fix1's numbers closely enough to exercise the split
// (walked/remaining/declined sum to the denominator with zero residue). Built through the real
// graph-store so frontierInstanceStats runs on genuine nodes, not a hand-mocked stats object.
async function fix1LikeStats() {
  const { makeGraph, mergeSnapshot, markInstanceExplored, markOpener } = await import('../../lib/graph/graph-store.mjs');
  const g = makeGraph();
  // 6 plain single-instance templates: 3 explored, 3 remaining.
  const els = [];
  for (let i = 1; i <= 6; i++) els.push({ templateId: i, instanceId: i * 100, templateSelector: `button.b${i}`, instanceSelector: `button.b${i}`, role: 'button', name: `b${i}`, route: '/x', instanceKey: `#${i}`, visible: true });
  mergeSnapshot(g, '/x', els);
  for (let i = 1; i <= 3; i++) markInstanceExplored(g, i, 0);
  let instances = 0; for (const el of Object.values(g.elements)) instances += (el.instances || []).length;
  return { ...frontierInstanceStats(g), instances, templates: Object.keys(g.elements).length };
}

/* -------------------------------------------------------------------- 1. attempts render */

test('the failure card renders the six resolver attempts (projection carries target)', () => {
  const events = [failedAct(1, 'ACT_FAILED', { ranStrategy: 'selector' })];
  const [step] = deriveSteps(events);
  // The projection MUST carry target — this is the dropped field. If deriveSteps drops it, the panel
  // falls to its "no list recorded" branch and the assertions below fail naming the count.
  assert.ok(step.target && Array.isArray(step.target.attempts), 'deriveSteps must carry target.attempts');
  assert.equal(step.target.attempts.length, 6, 'all six strategy records survive the projection');

  const html = W.attemptsHtml(step.target);
  assert.match(html, /стратегий в цепочке: 6/, 'the six-strategy chain is named');
  assert.match(html, /запустилось: 1/, 'exactly the one strategy that ran is counted');
  assert.ok(!/резолвер не оставил списка попыток/.test(html), 'the "no list recorded" lie must NOT appear');

  const panel = W.failurePanel(step, null, W.outcomeOf(step), { steps: [step] });
  assert.ok(!/список попыток не записан/.test(panel), 'the card must not claim the attempt list is absent');
  assert.match(panel, /CSS-селектор/, 'the resolved strategy is named on the card');
});

test('hadRevealPath survives the projection and the two tabs agree', () => {
  const [withPath] = deriveSteps([failedAct(2, 'NO_INSTANCE', { hadRevealPath: true })]);
  const [noPath] = deriveSteps([failedAct(3, 'NO_INSTANCE', { hadRevealPath: false })]);
  assert.equal(withPath.target.hadRevealPath, true, 'hadRevealPath:true carried');
  assert.equal(noPath.target.hadRevealPath, false, 'hadRevealPath:false carried');
  const p1 = W.failurePanel(withPath, null, W.outcomeOf(withPath), { steps: [withPath] });
  assert.match(p1, /путь к контролу был записан/, 'a recorded path is stated (matches the pipeline tab)');
  const p2 = W.failurePanel(noPath, null, W.outcomeOf(noPath), { steps: [noPath] });
  assert.match(p2, /пути к контролу записано не было/, 'an absent path is stated, opposite of p1');
});

// L1: the reveal-replay OUTCOME is carried by the projection and rendered ONLY for the informative case —
// the recovery pass reopened the container and the act STILL failed. Guards: deriveSteps carries
// `revealReplay`, and failurePanel prints the "reopened, acted, still failed" line for replayed:true while a
// main-pass failure (replayed:false / absent) prints nothing about reopening.
// FAIL-ON-REVERT: drop `revealReplay: ...` from deriveSteps (scrub-math) OR the `rr` block in failurePanel
//   (walk-view) → the reopened-and-still-failed line vanishes → "the reopened-but-failed line is rendered" reds.
test('a recovery failure states the container reopened and the act still failed; a main-pass failure does not', () => {
  const [recovered] = deriveSteps([failedAct(7, 'NO_INSTANCE', { hadRevealPath: true, revealReplay: { replayed: true, ok: true, rung: 'in-place' } })]);
  assert.equal(recovered.revealReplay?.replayed, true, 'deriveSteps carries the revealReplay outcome');
  const pr = W.failurePanel(recovered, null, W.outcomeOf(recovered), { steps: [recovered] });
  assert.match(pr, /контейнер переоткрыли.*акт всё равно не прошёл/s, 'the reopened-but-failed line is rendered');

  const [mainPass] = deriveSteps([failedAct(8, 'NO_INSTANCE', { hadRevealPath: true })]);
  const pm = W.failurePanel(mainPass, null, W.outcomeOf(mainPass), { steps: [mainPass] });
  assert.ok(!/контейнер переоткрыли/.test(pm), 'a main-pass failure says nothing about reopening a container');
});

/* -------------------------------------------------------------------- 2. instance headline */

test('the KPI headline is the instance number with the policy-vs-owed split', async () => {
  const instanceStats = await fix1LikeStats();
  // Sanity: the partition is exact (no residual), the property the plan asks us to assert.
  const cov = W.coverageSplit(instanceStats);
  assert.equal(cov.residual, 0, 'the instance partition sums with zero residue');
  assert.equal(cov.total, instanceStats.instances, 'the denominator is every instance');

  // run.stats carries the TEMPLATE numbers — the ones the old headline printed, deliberately DISTINCT
  // from the instance numbers (118/295 vs 148/693 on fix1). The KPI must NOT use them for the
  // headline: reverting kpiHtml to read run.stats reds this assertion.
  const run = { stats: { explored: 118, discovered: 295, unreachable: 21, routes: 65 } };
  const steps = [act(1, [req('POST', '/x', 200)])];
  const kpi = W.kpiHtml({ run, steps, instanceStats });
  const text = kpi.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
  assert.match(text, new RegExp(`${cov.walked}/${cov.total}`), 'headline is walked/total instances');
  assert.match(text, /экземпляров, не шаблонов/, 'the caption says instances, not templates');
  assert.match(text, /осталось по-настоящему/, 'genuinely-owed is a separate number');
  assert.match(text, /отклонила наша же выборка/, 'policy-declined is a separate number');
  // The lie: the headline must not be the template fraction 118/295 under "изучено контролов".
  assert.ok(!/118\/295/.test(text), 'the template fraction must NOT be the headline');
});

test('coverageSplit flags a non-zero residual instead of hiding it', () => {
  // A stats object that does NOT partition (invented numbers) must surface the residual, never look tidy.
  const bad = { instances: 100, walked: 10, remaining: 10, siteRemainder: 10, drillSkipped: 0, widgetSkipped: 0, cappedRemainder: 0, churnSkipped: 0, unreachable: 0 };
  const cov = W.coverageSplit(bad);
  // declined = 10 (site) + 0 + 0 + 0 = 10; walked 10 + remaining 10 + declined 10 = 30; residual 70.
  assert.equal(cov.residual, 70, 'the unaccounted remainder is computed, not swallowed');
  const kpi = W.kpiHtml({ run: {}, steps: [], instanceStats: bad });
  assert.match(kpi.replace(/<[^>]+>/g, ' '), /Разбиение не сходится/, 'a non-summing partition says so');
});

/* -------------------------------------------------------------------- 3. tones respected */

test('a DISABLED act is a FINDING and is not called unreachable', () => {
  const [disabled] = deriveSteps([failedAct(4, 'DISABLED', { role: 'textbox' })]);
  const v = W.verdictOf(disabled, { steps: [disabled], instanceStats: { unreachable: 18 } });
  assert.match(v, /НАХОДКА/, 'DISABLED reads as a finding');
  assert.ok(!/Отмечен недостижимым/.test(v), 'a DISABLED finding is NOT labelled unreachable');
});

test('an OUTWARD_REFUSED act is a policy decision, not unreachable', () => {
  const [outward] = deriveSteps([failedAct(5, 'OUTWARD_REFUSED')]);
  const v = W.verdictOf(outward, { steps: [outward], instanceStats: { unreachable: 18 } });
  assert.match(v, /решение политики/, 'a refusal reads as our own policy decision');
  assert.ok(!/Отмечен недостижимым/.test(v), 'a policy refusal is NOT labelled unreachable');
});

test('only a genuine reach-gap says "Отмечен недостижимым", and counts instances not failed acts', () => {
  const steps = deriveSteps([failedAct(6, 'NO_INSTANCE', { hadRevealPath: true }), failedAct(7, 'DISABLED'), failedAct(8, 'OUTWARD_REFUSED')]);
  const gap = steps[0];
  const v = W.verdictOf(gap, { steps, instanceStats: { unreachable: 18 } });
  assert.match(v, /Отмечен недостижимым/, 'a NO_INSTANCE reach-gap is the one class that is unreachable');
  // The old line printed the FAILED-ACT count (3 here) under an "unreachable controls" caption. It
  // must print the instance-level unreachable total (18), never the failed-act count.
  assert.match(v, /18/, 'the unreachable total is the instance count');
  assert.ok(!/недостижимых.*: 3\b/i.test(v), 'the failed-act count is NOT presented as the unreachable count');
});

/* -------------------------------------------------------------------- 4. request status */

test('a request row carries its response status and marks an anomaly', () => {
  const rows = W.requestRowsHtml([req('POST', '/api/groups', 500, 205), req('GET', '/api/chats', 200, 381)]);
  assert.match(rows, /500/, 'the 500 status is rendered — the field the render used to drop');
  assert.match(rows, /205мс/, 'the duration is rendered too');
  assert.match(rows, /200/, 'an ordinary status still renders');
  assert.match(rows, /anomaly/, 'the 5xx row is marked as an anomaly at a glance');

  // The anomaly detector over a step's requests (used by the finds count + the note).
  const step = act(9, [req('POST', '/api/list-b', 422)]);
  assert.equal(W.anomalousRequests(step.payload.requests).length, 1, 'a 422 is anomalous');
  const detail = W.stepDetailHtml(deriveSteps([step])[0]);
  assert.match(detail, /материал для Phase 2/, 'the anomaly is framed as Phase-2 data, not our defect');
});

/* -------------------------------------------------------------------- run-level frame notice */

test('the blank stage is explained at RUN level, not blamed on the step', () => {
  const steps = deriveSteps([act(1, []), failedAct(2, 'ACT_FAILED')]); // fix1 took zero shots on any step
  const notice = W.stageNotice(steps);
  assert.match(notice, /не снимались/, 'the run took no frames');
  assert.match(notice, /BUGHUNTER_VIEW=1/, 'it names the run-level cause');
  assert.match(notice, /2/, 'it carries the population (all N steps)');
  const f = W.framesInRun(steps);
  assert.deepEqual(f, { total: 2, withShot: 0 }, 'the frame census is exact');
});

test('the DOM skeleton renders as an SVG stage for a failed act', () => {
  // A minimal fix1-shaped skeleton: {v,w,h,truncated,nodes:[{d,tag,...,vis}]}.
  const skel = { v: 1, w: 1440, h: 900, truncated: 3, nodes: [
    { d: 4, tag: 'div', x: 0, y: 0, w: 1440, h: 69, vis: 1 },
    { d: 9, tag: 'p', name: 'Title', x: 605, y: 22, w: 76, h: 24, vis: 1 },
    { d: 9, tag: 'img', name: 'hidden', x: 0, y: 0, w: 0, h: 0, vis: 0 },
  ] };
  const svg = W.skeletonSvg(skel, { x: 1062, y: 368, width: 273, height: 30 });
  assert.match(svg, /<svg/, 'an SVG is produced');
  assert.match(svg, /<rect[^>]*class="sk /, 'visible nodes become rects');
  assert.ok(!/hidden/.test(svg), 'a zero-size hidden node is not drawn');
  assert.match(svg, /skmark/, 'the expected-control rect is marked');
  assert.match(svg, /3 узлов не поместилось/, 'the truncated count is stated, never hidden');
});

/* -------------------------------------------------------------------- section counts */

test('sectionCounts reports both finding classes and the instance coverage totals', async () => {
  const instanceStats = await fix1LikeStats();
  const steps = deriveSteps([failedAct(1, 'DISABLED'), act(2, [req('POST', '/api/groups', 500)])]);
  const c = W.sectionCounts({ runs: [{}], run: { stats: { routes: 65 } }, steps, instanceStats, pipeRows: 1092 });
  assert.equal(c.findsSplit.disabled, 1, 'a DISABLED finding is counted');
  assert.equal(c.findsSplit.anomalies, 1, 'a 5xx response is counted as a finding');
  assert.equal(c.finds, 2, 'the finds total sums both classes');
  assert.equal(c.cover, instanceStats.walked, 'cover is the instance-walked count');
  assert.equal(c.coverTotal, instanceStats.instances, 'coverTotal is every instance');
  assert.equal(c.routes, 65, 'pages VISITED comes from run.stats.routes');
});
