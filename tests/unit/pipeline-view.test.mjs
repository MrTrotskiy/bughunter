// The «Конвейер» tab's pure model: how a run's pipeline rows are folded, budgeted, split into
// phase segments, and summed into KPIs. Pure over arrays — no DOM, no fs, no browser.
//
// The RENDER half of pipeline-view.mjs is deliberately NOT tested here. There is no DOM harness
// in this project, and asserting innerHTML would guard markup rather than behaviour — it would
// go green on a page that renders a wrong number just as happily. Everything that decides a
// NUMBER the operator reads is pulled out into the pure functions below; the drawing is verified
// by opening the page.
//
// Guards:
//  - foldPipeline collapses consecutive same-pattern NAVIGATION rows only (a 50-row listing does
//    not become 50 lines) while NEVER folding acts — the acts are the narrative — and CONSERVES
//    time: Σ durMs after folding equals Σ durMs before. A view that loses wall clock is exactly
//    the defect derivePipeline exists to prevent.
//  - pipelineKpis is Number.isFinite-guarded on every accumulator: a failed act carries
//    `timings:{attemptMs}` with no actMs, and the un-guarded `tot += undefined` rendered the whole
//    run's average as NaN. `avgActMs` stays the average over COMPLETED acts — attempt time is a
//    SEPARATE number, because folding it in would silently redefine the metric.
//  - the model-decision bucket is derived, not asserted: DECISION_KINDS matches nothing in any
//    trail on disk, so decisionMs is null and the tab shows '—'. It must never be 0 (which reads
//    as "the agent thought instantly") and the unexplained bucket must never be labelled thinking.
//  - segmentsOf never draws a bar for a row that measured nothing: a zero-width segment reads as
//    "fast" when the truth is "nobody measured it".
//  - newestRunWithTrail defaults to the newest run that HAS events; zero-event runs stay listed.
//  - THE SHELL (the left rail + the honest placeholders). NAV_ITEMS is the one section list, and the
//    four sections with no screen yet MUST be marked `stub` — an unmarked stub is a rail that
//    promises a screen the tool does not have. navCount renders a missing number as the house '—'
//    and NEVER as 0: 0 is a claim ("we looked, there are none"), '—' is the absence of one, and
//    inventing the former is the exact dishonesty this whole section exists to correct.
//  - every stub page NAMES what is missing and what would fix it, rather than rendering blank.
//  - rowTitle truncates through displayName, so a concatenated-subtree element name cannot stretch
//    a pipeline row; rowTitleFull keeps the whole string for the tooltip.
//
// FAIL-ON-REVERT: drop the `FOLDABLE.has(r.kind)` condition in foldPipeline → "acts are never
//   folded" reds; drop a Number.isFinite guard in pipelineKpis → "no KPI is NaN" reds; make
//   pipelineKpis return `decisionMs: 0` instead of null → "no model-decision stage exists" reds;
//   make segmentsOf emit a segment for a zero-duration row → "a row that measured nothing draws
//   no bar" reds; make newestRunWithTrail return list[0] unconditionally → "the newest run with
//   a trail is selected" reds; make navCount fall back to 0 instead of '—' → "a missing count is
//   '—', never 0" reds; drop `stub: true` from a NAV_ITEMS entry → "every unbuilt section is
//   marked" reds; make rowTitle return the raw label → "rowTitle truncates a subtree name" reds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { derivePipeline } from '../../lib/debug/scrub-math.mjs';
import {
  foldPipeline, routePattern, budgetOf, segmentsOf, pipelineKpis, pipelineScale,
  newestRunWithTrail, isEmptyRun, kindStyle, fmtMs, rowTitle, rowTitleFull, UNEXPLAINED_LABEL, DECISION_KINDS,
  runThresholds, foldIdenticalRuns, foldAll, RUN_MIN,
  NAV_ITEMS, STUB_IDS, STUBS, navCount, stubHtml, SHELL_CSS,
} from '../../lib/debug/pipeline-view.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

// derivePipeline-shaped rows: three consecutive listing routes under ONE pattern, an act between
// two more acts on the same route, and a failed act carrying attempt-only timings.
function rows() {
  return [
    { seq: 0, ts: 0, kind: 'route', label: 'route /', route: '/', requested: null, durMs: 0, declaredMs: 0, idleMs: 0, overDeclared: false, stages: [], outcome: null, requests: 0 },
    { seq: 1, ts: 900, kind: 'route', label: 'route /item/1', route: '/item/1', requested: null, durMs: 900, declaredMs: 0, idleMs: 900, overDeclared: false, stages: [], outcome: null, requests: 0 },
    { seq: 2, ts: 1700, kind: 'route', label: 'route /item/2', route: '/item/2', requested: null, durMs: 800, declaredMs: 0, idleMs: 800, overDeclared: false, stages: [], outcome: null, requests: 0 },
    { seq: 3, ts: 2400, kind: 'route', label: 'route /item/3', route: '/item/3', requested: null, durMs: 700, declaredMs: 0, idleMs: 700, overDeclared: false, stages: [], outcome: null, requests: 0 },
    { seq: 4, ts: 3400, kind: 'act', label: 'act Save', route: '/item/3', requested: null, durMs: 1000, declaredMs: 800, idleMs: 200, overDeclared: false, stages: [{ name: 'act', ms: 300 }, { name: 'settle', ms: 400 }, { name: 'snap', ms: 100 }], outcome: null, requests: 2 },
    { seq: 5, ts: 4400, kind: 'act', label: 'act Next', route: '/item/3', requested: null, durMs: 1000, declaredMs: 900, idleMs: 100, overDeclared: false, stages: [{ name: 'act', ms: 500 }, { name: 'settle', ms: 300 }, { name: 'snap', ms: 100 }], outcome: null, requests: 0 },
    // The NaN lever: attempt-only timings, no actMs anywhere in the payload.
    { seq: 6, ts: 9400, kind: 'act.failed', label: 'act failed Create', route: null, requested: '/item/9', durMs: 5000, declaredMs: 812, idleMs: 4188, overDeclared: false, stages: [{ name: 'attempt', ms: 812 }], outcome: 'NO_INSTANCE', requests: 0 },
  ];
}
const sumDur = (list) => list.reduce((s, r) => s + r.durMs, 0);

test('a listing folds to one line; acts are never folded; time is conserved', () => {
  const src = rows();
  const folded = foldPipeline(src);

  // /item/1..3 share one pattern and are consecutive → one row carrying all three.
  assert.equal(routePattern('/item/12'), '/item/:param', 'a numeric segment is masked');
  const listing = folded.find((r) => r.pattern === '/item/:param');
  assert.ok(listing, 'the three listing routes folded into one row');
  assert.equal(listing.count, 3, `a 3-page listing is ONE line, not 3 — got count ${listing && listing.count}`);
  assert.equal(listing.durMs, 2400, 'the folded row carries the summed wall time');
  assert.equal(listing.members.length, 3, 'the concrete routes stay reachable in the inspector');

  // THE lever: acts must survive as individual rows — folding them hides what the agent did.
  const acts = folded.filter((r) => r.kind === 'act');
  assert.equal(acts.length, 2, `acts are never folded, even back-to-back on one route — got ${acts.length}`);
  assert.ok(acts.every((r) => r.count === 1), 'each act is its own row');

  // Conservation across the fold: the tab cannot quietly lose a run's wall clock.
  assert.equal(sumDur(folded), sumDur(src), `Σ durMs must survive folding — got ${sumDur(folded)} vs ${sumDur(src)}`);
  // Order is preserved: the first row is still the run's first event.
  assert.equal(folded[0].seq, 0, 'folding preserves order');
  assert.deepEqual(foldPipeline(null), [], 'a non-array input yields no rows');
});

test('no KPI is NaN when a failed act carries attempt-only timings', () => {
  const k = pipelineKpis(foldPipeline(rows()));
  for (const [name, v] of Object.entries(k)) {
    if (v === null) continue;
    assert.ok(Number.isFinite(v), `KPI ${name} must be a finite number, never NaN — got ${v}`);
  }
  // `avg act` stays the average over acts that COMPLETED a causal window: (300 + 500) / 2.
  assert.equal(k.avgActMs, 400, `avg act averages COMPLETED acts only — got ${k.avgActMs}`);
  // Attempt time is its own number. Folding it in (avg over 300/500/812 = 537) would silently
  // redefine the metric — the exact defect class this project keeps walking back.
  assert.equal(k.avgAttemptMs, 812, 'failed-attempt time is reported separately, not folded in');
  assert.notEqual(k.avgActMs, 537, 'attempt time must not leak into avg act');
});

test('no model-decision stage exists, and the unexplained time is never called thinking', () => {
  const k = pipelineKpis(foldPipeline(rows()));
  // Derived, not hardcoded: the lookup is real and simply matches nothing any trail writes.
  assert.ok(DECISION_KINDS.size > 0, 'the decision-kind lookup is real, not a stub');
  assert.equal(k.decisionRows, 0, 'no run on disk contains a model-decision stage');
  assert.equal(k.decisionMs, null, 'a stage that does not exist reports null (renders "—"), never 0');

  // The unexplained bucket names UNMEASURED TIME INSIDE THE STEP. Two things it must never say:
  //  - cognition. Naming it thinking is the inflated number this project has walked back three
  //    times, so the label is asserted rather than left to a reviewer's eye.
  //  - navigation. It used to read «навигация / простой», which put a flat contradiction on one
  //    screen: the KPI said `0.0% НАВИГАЦИЯ` (one route event in the whole run) while EVERY row
  //    said `навигация / простой 100%`. An act's unaccounted time is not navigation, and the two
  //    quantities must not be expressible in the same words.
  assert.equal(UNEXPLAINED_LABEL, 'не измерено внутри шага');
  assert.doesNotMatch(UNEXPLAINED_LABEL, /размышл|думает|дума|thinking|когни/i, 'the unexplained bucket must not imply cognition');
  assert.doesNotMatch(UNEXPLAINED_LABEL, /навигац|переход/i,
    'the per-row unexplained bucket must not be expressible as navigation — the navigation KPI is a different quantity');
  for (const kind of ['route', 'act', 'act.failed']) {
    assert.doesNotMatch(kindStyle(kind).verb + kindStyle(kind).badge, /размышл|дума/i, `${kind} must not be labelled as thinking`);
  }
  // Navigation really is the majority here (2400 of 9400ms), which is what makes it legible.
  assert.ok(k.navPct > 25, `navigation share is reported — got ${k.navPct}`);
  assert.equal(Math.round(k.unexplainedMs), 6888, 'the unexplained bucket is summed, never clamped away');
});

test('a row that measured nothing draws no bar; a measured row splits into stages + unexplained', () => {
  const [first, , , , act] = rows();

  // The run's first row invents no duration (derivePipeline's contract). A zero-width segment
  // would read as "instant"; the truth is "not measured", so nothing is drawn at all.
  const f = segmentsOf(first);
  assert.equal(f.empty, true, 'the first row measured nothing');
  assert.equal(f.segments.length, 0, 'a row that measured nothing draws no bar');
  assert.equal(f.explained, false);

  const a = segmentsOf(act);
  assert.equal(a.explained, true, 'an act with stages explains itself');
  assert.deepEqual(a.segments.map((s) => s.key), ['act', 'settle', 'snap', 'idle'], 'stages then the unexplained remainder');
  assert.equal(a.segments.at(-1).label, UNEXPLAINED_LABEL);
  assert.equal(a.segments.at(-1).measured, false, 'the unexplained segment is marked as NOT measured');
  assert.equal(Math.round(a.segments.reduce((s, x) => s + x.pct, 0)), 100, 'the segments fill the bar exactly');

  // A route with no timings at all (every route event in all three surviving runs): the WHOLE
  // gap is unexplained, and that must render as one honest bar rather than vanish.
  const r = segmentsOf(rows()[1]);
  assert.equal(r.explained, false, 'a route event stamped no stage timings');
  assert.deepEqual(r.segments.map((s) => s.key), ['idle'], 'the whole measured gap is the unexplained bucket');
  assert.equal(r.segments[0].ms, 900);
});

test('the slow/outlier threshold is DERIVED from the run, and a run with no distribution gets none', () => {
  // The old threshold was a fixed constant (act 1s, route 2s) taken from two LOCAL-FIXTURE runs.
  // Against a real target it carried no information whatever: 287 of 288 rows on run raw1 breached
  // it, the KPI read «287 НАД БЮДЖЕТОМ», and everything on screen was painted as alarming.
  // Deriving it from the run's own p95 makes the flag ~5% of rows BY CONSTRUCTION, whatever the
  // target's speed, and makes the number checkable (it is printed beside the count).
  const many = [];
  for (let i = 0; i < 40; i++) many.push({ kind: 'act', durMs: 800 + i * 60, stages: [], seq: i });   // 800..3140
  many.push({ kind: 'act', durMs: 300000, stages: [], seq: 40 });    // the 3m23s class
  const th = runThresholds(many);
  assert.ok(th.all.slowMs > 0 && th.all.medianMs > 0, `derived from the rows themselves: ${JSON.stringify(th.all)}`);
  assert.equal(budgetOf(many[20], th).over, false, 'a median row is not flagged');
  assert.equal(budgetOf(many[40], th).over, true, 'the longest row is over the run\'s own p95');
  assert.equal(budgetOf(many[40], th).outlier, true, 'and past median + 4x the upper spread it is an OUTLIER, a stronger claim');
  assert.equal(budgetOf(many[20], th).outlier, false);
  assert.equal(budgetOf(many[38], th).outlier, false, 'merely being in the slow tail is not an outlier');

  // THE OUTLIER CLAIM IS STRICTLY STRONGER THAN THE SLOW FLAG, on every distribution. On a WIDE one
  // (run raw3: median 147ms, p95 5.3s) an outlier rule keyed on p95 collapses onto the slow rule and
  // the two words stop meaning different things — measured, it called 19 of 435 rows anomalous.
  const wide = [];
  for (let i = 0; i < 300; i++) wide.push({ kind: 'act', durMs: 40 + (i % 7) * 15, stages: [], seq: i });   // the decision-event mass
  for (let i = 0; i < 100; i++) wide.push({ kind: 'act', durMs: 1000 + i * 50, stages: [], seq: 300 + i }); // the act mass
  const wth = runThresholds(wide);
  const wideSlow = wide.filter((r) => budgetOf(r, wth).over).length;
  const wideOut = wide.filter((r) => budgetOf(r, wth).outlier).length;
  assert.ok(wideOut < wideSlow, `an outlier must be rarer than "slow" — ${wideOut} vs ${wideSlow}`);
  assert.ok(wideOut <= wide.length * 0.02, `"аномалия" names a handful, not a tail — ${wideOut}/${wide.length}`);

  // And it is not claimed at all on a sample too small for a p99 to mean anything.
  const nine = Array.from({ length: 9 }, (_, i) => ({ kind: 'act', durMs: 100 + i * 100, stages: [], seq: i }));
  const nth = runThresholds(nine);
  assert.equal(nine.filter((r) => budgetOf(r, nth).outlier).length, 0,
    'the slowest of nine rows is not an anomaly — a spread estimated from nine samples is noise');

  // THE RULE MUST NOT SATURATE AT THE SAMPLE MAXIMUM. A p99-based threshold on ~40 rows IS the
  // largest row, so `dur > threshold` was false for exactly the row the flag exists to catch.
  const th2 = runThresholds(many);
  assert.ok(th2.all.outlierMs < many[40].durMs,
    `the threshold must sit BELOW the anomaly it is meant to catch — ${th2.all.outlierMs} vs ${many[40].durMs}`);
  assert.ok(th2.all.outlierMs > th2.all.slowMs, 'and strictly above the slow threshold');
  const flagged = many.filter((r) => budgetOf(r, th).over).length;
  assert.ok(flagged <= Math.ceil(many.length * 0.12),
    `a derived threshold flags a tail, not the whole run — got ${flagged} of ${many.length}`);

  // NO DISTRIBUTION → NO CLAIM. A four-row run cannot have a p95, and inventing a default there is
  // exactly how the old constant survived. `derived:false` must reach the renderer as '—'.
  const tiny = runThresholds(rows().slice(0, 4));
  assert.equal(tiny.all, null, 'too few rows for a distribution');
  assert.equal(budgetOf(rows()[4], tiny).derived, false, 'no threshold means no verdict');
  assert.equal(budgetOf(rows()[4], tiny).ms, null, 'and no fabricated number');
  assert.equal(budgetOf(rows()[4], tiny).over, false);
  assert.equal(budgetOf({ kind: 'act' }, th).over, false, 'a row with no duration is never flagged');
  const k = pipelineKpis(many);
  assert.equal(k.slow, flagged, 'the KPI counts exactly the rows the rows themselves report');
  assert.equal(k.slowMs, th.all.slowMs, 'and publishes the threshold it measured against');
  assert.equal(k.outliers, 1, 'the outlier count is separate from the slow count');
});

test('on the real run raw1 the derived threshold flags a tail, the 3m23s click is the outlier, and the seven 6.3s failures are ONE row',
  { skip: !fs.existsSync(path.join(REPO, 'state/runs/raw1/events.ndjson')) }, () => {
    // Ground truth, not a fixture — every number the operator complained about is in this file.
    const ev = fs.readFileSync(path.join(REPO, 'state/runs/raw1/events.ndjson'), 'utf8')
      .split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const raw = derivePipeline(ev);
    const th = runThresholds(raw);

    // THE OLD CONSTANT: 287 of 288. A threshold 99.7% of rows breach ranks nothing.
    const oldConstant = raw.filter((r) => r.durMs > (r.kind.startsWith('route') ? 2000 : 1000)).length;
    assert.ok(oldConstant > raw.length * 0.9, `the fixed budget really did flag everything — ${oldConstant}/${raw.length}`);
    const flagged = raw.filter((r) => budgetOf(r, th).over).length;
    assert.ok(flagged < raw.length * 0.15,
      `the derived threshold flags a tail, not the run — ${flagged}/${raw.length} (was ${oldConstant})`);

    // THE OUTLIER: one click took 3m23s and rendered as an ordinary grey bar among 1.1s rows.
    const outliers = raw.filter((r) => budgetOf(r, th).outlier);
    assert.equal(outliers.length, 1, `exactly one row in this run is anomalous — got ${outliers.map((r) => r.durMs)}`);
    assert.equal(outliers[0].durMs, 203378, 'and it is the 3m23s first act');

    // THE SEVEN: consecutive NO_INSTANCE failures at ~6.3s, seven DIFFERENT selectors in the text.
    const folded = foldAll(raw);
    const groups = folded.filter((r) => r.foldKind === 'repeat');
    assert.ok(groups.some((g) => g.count === 7), `the seven identical failures collapse to one row — got ${groups.map((g) => g.count)}`);
    assert.ok(sumDur(folded) === sumDur(raw), 'and the run wall clock survives both folds');
  });

test('a run of identical failures collapses into ONE row that states the repeat count', () => {
  // Rows 19-25 of run raw1: seven consecutive steps at ~6.3s that ALL failed the same way. An
  // identical duration plus an identical outcome is one systematic effect (a fixed timeout), and
  // the screen rendered seven independent grey rows and drew no conclusion at all.
  const seven = [];
  for (let i = 0; i < 7; i++) {
    // Deliberately DIFFERENT selector text inside one NO_INSTANCE message, exactly as raw1 has it:
    // string equality on `outcome` finds nothing here, which is why the key is the failure CLASS.
    seven.push({ seq: 10 + i, ts: i * 6300, kind: 'act', label: 'act x', durMs: 6300 + i * 7, declaredMs: 0,
      idleMs: 6300, overDeclared: false, stages: [], requests: 0, outcome: `cannot resolve instance #a${i} > #b${i}` });
  }
  const folded = foldIdenticalRuns(seven);
  assert.equal(folded.length, 1, `seven identical failures are one row — got ${folded.length}`);
  assert.equal(folded[0].count, 7, 'the row states how many it stands for');
  assert.equal(folded[0].foldKind, 'repeat');
  assert.equal(folded[0].members.length, 7, 'and keeps every member so the reader can expand');
  assert.equal(folded[0].durMs, seven.reduce((s, r) => s + r.durMs, 0), 'time is CONSERVED, exactly as in foldPipeline');
  assert.ok(folded[0].repeatSpreadMs < 100, 'the spread is reported, so "identical" is checkable');

  // THE NARRATIVE IS NOT COLLAPSED. Three consecutive SUCCESSFUL acts are three facts.
  const wins = [0, 1, 2].map((i) => ({ seq: i, kind: 'act', label: 'act ok', durMs: 1000, stages: [], outcome: null, requests: 0 }));
  assert.equal(foldIdenticalRuns(wins).length, 3, 'a run of successful acts must never fold — it is the narrative');
  // Two is a coincidence, not a pattern.
  assert.equal(foldIdenticalRuns(seven.slice(0, 2)).length, 2, `fewer than ${RUN_MIN} rows stay separate`);
  // Different failure CLASSES never merge, however close their durations.
  const mixed = [seven[0], { ...seven[1], outcome: 'is visible but disabled' }, seven[2]];
  assert.equal(foldIdenticalRuns(mixed).length, 3, 'a different diagnosis is a different row');
  // Conservation across the whole two-stage fold, on the shared fixture.
  assert.equal(sumDur(foldAll(rows())), sumDur(rows()), 'foldAll conserves the run wall clock');
});

test('the viewer defaults to the newest run that HAS a trail, and empty runs stay listed', () => {
  // Newest-first, exactly as the server sorts them: the two newest are aborted zero-event runs.
  const runs = [
    { id: 'aborted-2', trailBytes: 0 }, { id: 'aborted-1', trailBytes: 0 },
    { id: 'hygge2', trailBytes: 412_000 }, { id: 'goal1', trailBytes: 380_000 },
  ];
  assert.equal(newestRunWithTrail(runs).id, 'hygge2',
    'the newest run WITH a trail is selected — a bare runs[0] opens the viewer on a blank screen');
  assert.equal(isEmptyRun(runs[0]), true, 'a zero-byte trail marks the run empty (so it can be chipped, not hidden)');
  assert.equal(isEmptyRun(runs[2]), false);
  assert.equal(isEmptyRun({ id: 'legacy' }), true, 'a run with no trailBytes field at all reads empty, never crashes');
  // Every run empty → still select the newest rather than nothing, so the tab is never dead.
  assert.equal(newestRunWithTrail([{ id: 'a', trailBytes: 0 }]).id, 'a');
  assert.equal(newestRunWithTrail([]), null);
  assert.equal(newestRunWithTrail(null), null, 'a missing runs list degrades instead of throwing');
});

test('row labels and durations read as prose, and a missing number is a single "—"', () => {
  assert.equal(rowTitle(rows()[4]), 'клик · Save', 'the English kind prefix is stripped; the badge already carries the kind');
  assert.equal(rowTitle(rows()[6]), 'клик не удался · Create');
  assert.equal(rowTitle(foldPipeline(rows()).find((r) => r.count === 3)), 'переход · /item/1 ×3', 'a folded row shows its count');
  assert.equal(fmtMs(null), '—', 'the single null placeholder');
  assert.equal(fmtMs(undefined), '—');
  assert.equal(fmtMs(NaN), '—', 'a NaN never reaches the operator as a number');
  assert.equal(fmtMs(812), '812 мс');
  assert.equal(fmtMs(6133), '6.1 с');
  assert.equal(fmtMs(134052), '2 м 14 с');
  assert.equal(pipelineScale(rows()), 5000, 'the bar scale is the p95 row duration, so one outlier cannot flatten the list');
  assert.equal(pipelineScale([]), 1, 'an empty run yields a safe scale, never a divide-by-zero');
});

// ---------------------------------------------------------------- the shell (rail + placeholders)

test('the rail lists every section once, and marks the ones with no screen', () => {
  const ids = NAV_ITEMS.map((i) => i.id);
  assert.equal(new Set(ids).size, ids.length, 'a duplicated id would make two rail items route to one view');
  assert.deepEqual(ids, ['runs', 'walk', 'pipe', 'graph', 'reqs', 'finds', 'cover', 'tests'],
    'the operator fixed this order; Прогоны first and Тесты last');
  // The four unbuilt sections MUST declare themselves. An unmarked stub is a rail promising a screen.
  assert.deepEqual([...STUB_IDS].sort(), ['cover', 'finds', 'reqs', 'walk']);
  for (const id of STUB_IDS) assert.ok(STUBS[id], `${id} is marked a stub but has no placeholder text`);
  // …and every stub id must be reachable from the rail, or the placeholder is dead code.
  for (const id of Object.keys(STUBS)) assert.ok(ids.includes(id), `${id} has placeholder text but no rail item`);
});

test("a count that cannot be derived renders '—', never 0", () => {
  // 0 is a claim ("we looked, there are none"); '—' is the absence of one. The house null is '—'.
  assert.equal(navCount({ runs: 0 }, 'runs'), '0', 'a real zero is still shown as zero');
  assert.equal(navCount({}, 'runs'), '—');
  assert.equal(navCount(null, 'runs'), '—');
  assert.equal(navCount({ runs: null }, 'runs'), '—');
  assert.equal(navCount({ runs: undefined }, 'runs'), '—');
  assert.equal(navCount({ runs: NaN }, 'runs'), '—', 'NaN is not a number the operator should read');
});

test('every placeholder explains itself instead of rendering blank', () => {
  for (const id of STUB_IDS) {
    const html = stubHtml(id, {});
    const s = STUBS[id];
    assert.ok(html.includes(s.title), `${id}: the placeholder does not name its section`);
    assert.match(html, /раздел не построен/, `${id}: the placeholder does not admit it is unbuilt`);
    assert.ok(html.includes('—'), `${id}: with no run loaded the count must be '—'`);
    // It must say what is MISSING and what would FIX it — an empty state that only says "empty" is
    // the failure this section exists to correct.
    assert.ok(s.blocks.length >= 2, `${id}: a placeholder needs at least the gap and the remedy`);
    for (const b of s.blocks) assert.ok(b.h && b.p && b.p.length > 40, `${id}: a block is a stub of a stub`);
  }
  // The counts that ARE derivable reach the page, so the rail and the placeholder cannot disagree.
  assert.match(stubHtml('reqs', { edges: 26 }), /<b>26<\/b>/);
  assert.match(stubHtml('cover', { cover: 117 }), /<b>117<\/b>/);
  assert.equal(stubHtml('nope', {}), '<div class="empty">—</div>', 'an unknown section degrades quietly');
});

test('rowTitle truncates a concatenated-subtree name; rowTitleFull keeps it', () => {
  // The reported defect: `generic "Add GroupuploadCreatesearchConnections (0)No dataNo Connections
  // Found"` rendered as if it were a label. Display-side only — the derivation is untouched.
  const long = 'Add GroupuploadCreatesearchConnections (0)No dataNo Connections Found and more text still';
  const row = { seq: 1, kind: 'act', label: `act ${long}`, route: '/x', durMs: 10, stages: [] };
  const short = rowTitle(row), full = rowTitleFull(row);
  assert.ok(short.length < full.length, 'a subtree-length name must be cut for display');
  assert.ok(short.endsWith('…'), 'truncation is marked, not silent');
  assert.ok(full.includes('No Connections Found'), 'the tooltip keeps the whole string');
  // A short name is left exactly alone — truncation must not fire on ordinary labels.
  const plain = { seq: 2, kind: 'act', label: 'act Save', route: '/x', durMs: 10, stages: [] };
  assert.equal(rowTitle(plain), rowTitleFull(plain));
  assert.equal(rowTitle(plain), 'клик · Save');
});

test('the theme is dark-only, monospace, and self-contained', () => {
  // CSP is `default-src 'none'` — one @import or url(https://…) and the page silently loses its skin.
  assert.doesNotMatch(SHELL_CSS, /@import|url\(\s*['"]?https?:/i, 'no external asset may enter the stylesheet');
  assert.match(SHELL_CSS, /--bg:#0a0a0a/, 'the house background, the same hex every aeye-os pod inlines');
  assert.match(SHELL_CSS, /font:13px\/1\.5 var\(--mono\)/, 'monospace is the default, not an accent');
  assert.match(SHELL_CSS, /tabular-nums/, 'counters must not jitter');
  // The active rail item is a hairline, never a filled block (house top-nav rule).
  assert.match(SHELL_CSS, /\.navitem\.on::before[^}]*background:var\(--fg\)/);
});
