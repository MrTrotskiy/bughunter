// pipeline-view — the «Конвейер» tab of the admin viewer: the run's whole pipeline as a
// vertical narrative, one row per event, read top to bottom, in the OPERATOR's language.
// It answers "что делал агент, каким действием, как долго и из чего это время состояло".
//
// It renders `derivePipeline(events)` rows (scrub-math.mjs) — that module owns the model and
// its time conservation (Σ durMs === last.ts − first.ts) and is NOT touched here. This file
// adds only presentation: category colours, Russian labels, per-kind budgets, route folding.
//
// HONESTY (binding, not style):
//  - THERE IS NO MODEL-THINKING STAGE IN THE TRAIL. The live driver decides in script, so the
//    literal answer to "сколько думает агент" is "такой стадии нет". DECISION_KINDS is a real
//    lookup that currently matches nothing in any run on disk — the claim is derived from the
//    data, not hardcoded, and the day a trail stamps such a stage it lights up by itself.
//  - The unexplained bucket is NEVER «размышление» and never implies the crawler thinks. On the
//    three surviving runs it is 68.6% / 74.9% / 90.0% of wall clock, and calling that latency
//    agent cognition would be exactly the inflated number this project keeps walking back.
//  - IT IS ALSO NOT NAVIGATION (corrected 2026-07-20). The bucket used to be labelled
//    «навигация / простой», which put a flat contradiction on one screen: the top KPI read
//    `0.0% НАВИГАЦИЯ` (honest — this run has ONE route event) while EVERY row read
//    `навигация / простой 100%`. An ACT's unaccounted time is not navigation; it is time the step
//    declared no stage for. The bucket now says exactly that, so the row and the navigation KPI
//    measure visibly different quantities and cannot be read as one.
//  - A row that declares no timings draws NO stage bar and reads '—'. A zero-width bar would
//    read as "fast"; the truth is "nobody measured it".
//  - THE SCREEN STATES ITS CONCLUSIONS. An even list of 288 grey rows hid both a single 3m23s
//    click and seven consecutive 6.3s failures — the two most informative facts in the run. An
//    outlier is MARKED and a run of identical rows is COLLAPSED into one row that says so; the
//    reader is not asked to notice a pattern the page already computed.
//
// The pure half (fold / budget / segments / KPIs) is unit-tested. The render half is DOM and
// is NOT unit-tested — there is no DOM harness in this project and inventing one to assert
// innerHTML would guard markup, not behaviour. It is verified by opening the page.

import { classify, explainFailure, displayName, anchorSource, plural } from './failure-hints.mjs';

/* ------------------------------------------------------------------ pure model */

// ONE lookup drives the whole visual system: a 3px left stripe + a small badge, per category.
//
// PALETTE PROVENANCE (corrected 2026-07-20). This used to read "lifted verbatim from
// packages/test-kit/ui/TimelineRow" — the warm-stone tokens (#1c1917 / #292524 / #44403c). That is a
// WIDGET-INTERNAL palette for one component. The operator's actual shipped operator-tool shell is
// @aeye-os/admin-ui (packages/admin-ui/src/styles/base.css), whose neutral dark values every pod's
// web-admin/index.html hardcodes inline as `background-color:#0a0a0a;color:#fafafa`. The viewer now
// follows THAT one, end to end, and the warm-stone tokens are gone — see SHELL_CSS below. Two
// palettes in one tool was the "не так, как у нас" the operator reported.
//
// Category colours are the house categorical ramp (--chart-1..5 + --destructive), not invented hues.
//
// `act.failed` is styled by its FAILURE CLASS, not by the bare kind — see rowStyle below. The flat
// red «сбой» here is only the fallback for a row whose error cannot be classified: a danger refusal
// and a firewall block are the safety mechanism WORKING, and painting them red reports our own guard
// rails as breakage. failure-hints.mjs owns that judgement; this file only colours it.
export const KIND_STYLE = {
  act:             { cat: 'interaction', color: '#009689', badge: 'клик',    verb: 'клик' },
  'act.failed':    { cat: 'error',       color: '#ff6467', badge: 'сбой',    verb: 'клик не удался' },
  route:           { cat: 'navigation',  color: '#2593ba', badge: 'переход', verb: 'переход' },
  'route.visit':   { cat: 'navigation',  color: '#2593ba', badge: 'переход', verb: 'переход' },
  observe:         { cat: 'snapshot',    color: '#f54900', badge: 'вывод',   verb: 'записан вывод' },
  'frontier.emit': { cat: 'metric',      color: '#fe9a00', badge: 'счёт',    verb: 'пересчёт фронтира' },
};
// An unrecognized kind is still a row (same rule derivePipeline follows) — amber "capture".
const DEFAULT_STYLE = { cat: 'capture', color: '#ffb900', badge: 'этап', verb: '' };
export function kindStyle(kind) { return KIND_STYLE[kind] || DEFAULT_STYLE; }

// Per-tone colours for a failed act, so the pipeline agrees with the Walk tab instead of
// contradicting it. ПО ПЛАНУ and НАХОДКА are deliberately NOT red. The four tones map onto the
// house status vocabulary (warn / info / idle / error) — same four values SHELL_CSS gives .ochip.
const TONE_COLOR = { planned: '#ffb900', finding: '#2593ba', unreached: '#737373', broken: '#ff6467' };

// The style for ONE row: the kind's style, refined by the failure class when the row reports a
// non-OK outcome. derivePipeline exposes that as `outcome` (p.code preferred, else the error's first
// line), so it is passed as BOTH code and message — classify tries the code map first and falls back
// to prose matching, which is exactly right for either shape. A successful row classifies to null and
// keeps its kind style untouched. `rowTitle`/`segmentsOf` are unaffected: colour and badge only.
export function rowStyle(row) {
  const base = kindStyle(row && row.kind);
  const out = row && row.outcome ? String(row.outcome) : null;
  const cls = out ? classify({ error: out, code: out }) : null;
  if (!cls) return base;
  return { ...base, color: TONE_COLOR[cls.tone.key] || base.color, badge: cls.chip };
}

// Kinds that would represent a MODEL decision consuming wall clock. Empty of matches today on
// every run on disk — see the honesty note above. Never renamed to imply the crawler thinks.
export const DECISION_KINDS = new Set(['agent.think', 'llm', 'judge']);

// THE THRESHOLD IS DERIVED FROM THE RUN, NOT CHOSEN (corrected 2026-07-20).
//
// It used to be a fixed per-kind constant — act 1000ms, route 2000ms — anchored on the p75 of two
// LOCAL-FIXTURE runs (951ms / 985ms / 1564ms). Against a real target that number carries no
// information whatever: on run `raw1`, 287 of 288 rows breached it (99.7%), the KPI read
// «287 НАД БЮДЖЕТОМ», and the panel itself had to admit «Бюджет — порог, который выбрали мы». A
// threshold that flags everything ranks nothing and paints an ordinary run as an emergency.
//
// The column is KEPT rather than deleted, because "is this step slow compared with its peers" is a
// real question and the only ranking signal on the page. It is now answered against THIS RUN's own
// distribution: p95 within the row's own category (a navigation and a click have different natural
// costs), so ~5% of rows are flagged BY CONSTRUCTION however fast or slow the target is, and the
// label everywhere names what it is measured against — «медленнее p95 прогона», never «бюджет».
//
// A category with too few rows to have a distribution falls back to the whole run; a run too small
// for even that yields NO threshold and the column reads '—'. A missing number is the house '—',
// never a fabricated default: that substitution is how the old constant survived this long.
export const MIN_SAMPLE = 8;
// An OUTLIER is a stronger claim than "slow" and must stay STRICTLY stronger on EVERY distribution
// — otherwise the two words mean the same thing and «аномалия» stops carrying information.
//
// The rule is a robust one: median + OUTLIER_FACTOR × (p95 − median). It is the median plus a
// multiple of the run's own upper spread, so it scales with how varied the run actually is and is
// always above p95 whenever p95 > median (i.e. always, outside a degenerate all-equal run).
//
// Two rules were tried and rejected against real data, and both failures are the reason for this one:
//  - max(p95, k × median) COLLAPSED ONTO p95 on a wide distribution. Run raw3 (median 147ms because
//    263 of its rows are sub-100ms decision events, p95 5.3s because its acts are seconds) had
//    4×median far below p95, so "outlier" degenerated to "slow" and 19 of 435 rows were called
//    anomalous. A tail is not an anomaly.
//  - max(p99, k × median) SATURATES AT THE SAMPLE MAXIMUM. On 41 rows, p99 IS the largest row, so
//    `dur > p99` is false for the very row the flag exists to catch — the rule silently excluded its
//    own target. Caught by the unit test, not by reading the code.
export const OUTLIER_FACTOR = 4;
// A spread estimated from a handful of rows is noise. Below this sample the outlier claim is not
// made at all — the slow flag still works, because p95 on a small sample is a comparison, not a claim.
export const OUTLIER_MIN_SAMPLE = 20;

// The duration a row is COMPARABLE at. A folded row's `durMs` is a SUM (time is conserved through
// both folds), and comparing a sum to a per-row threshold is a category error: the seven collapsed
// 6.3s failures summed to 44s and were flagged «аномалия» — an alarm about a number no single step
// ever took. A folded row is judged at its per-member duration; an ordinary row at its own.
export function comparableMs(row) {
  if (!row) return 0;
  if (row.count > 1 && Number.isFinite(row.repeatMs)) return row.repeatMs;
  if (row.count > 1 && Array.isArray(row.members) && row.members.length) {
    const each = row.members.map((m) => (Number.isFinite(m.durMs) ? m.durMs : 0)).sort((a, b) => a - b);
    return each[Math.floor(each.length / 2)];
  }
  return Number.isFinite(row.durMs) ? row.durMs : 0;
}

function quantile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}
function statsOf(durations) {
  const s = [...durations].sort((a, b) => a - b);
  const medianMs = quantile(s, 0.5);
  const p95Ms = quantile(s, 0.95);
  return {
    n: s.length, medianMs, p95Ms, slowMs: p95Ms,
    outlierMs: medianMs + OUTLIER_FACTOR * Math.max(0, p95Ms - medianMs),
    outlierClaimable: s.length >= OUTLIER_MIN_SAMPLE,
  };
}

// The run's own thresholds, per row category plus a whole-run fallback. Pure over the rows the tab
// is about to draw, so the numbers on screen are always derived from the numbers on screen.
export function runThresholds(rows) {
  // Measured on comparableMs, so a folded row contributes ONE representative duration rather than a
  // sum that would drag the whole distribution upward.
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && comparableMs(r) > 0);
  const cats = {};
  const byCat = new Map();
  for (const r of list) {
    const c = kindStyle(r.kind).cat;
    if (!byCat.has(c)) byCat.set(c, []);
    byCat.get(c).push(comparableMs(r));
  }
  for (const [c, arr] of byCat) if (arr.length >= MIN_SAMPLE) cats[c] = statsOf(arr);
  return { cats, all: list.length >= MIN_SAMPLE ? statsOf(list.map(comparableMs)) : null };
}
// The stats a given row is judged against: its own category, else the whole run, else nothing.
export function thresholdFor(th, row) {
  if (!th) return null;
  return th.cats[kindStyle(row && row.kind).cat] || th.all || null;
}
// A row's verdict against the run. `derived:false` means no threshold could be computed — the
// caller must render '—' and make no claim at all.
export function budgetOf(row, th) {
  const dur = comparableMs(row);
  const t = thresholdFor(th, row);
  if (!t || !(t.slowMs > 0)) return { ms: null, over: false, outlier: false, ratio: 0, derived: false, n: 0 };
  return {
    ms: t.slowMs, medianMs: t.medianMs, n: t.n, derived: true,
    ratio: dur / t.slowMs,
    over: dur > t.slowMs,
    outlier: !!t.outlierClaimable && dur > t.outlierMs,
    medianRatio: t.medianMs > 0 ? dur / t.medianMs : 0,
  };
}

// Stage names as derivePipeline emits them (the `Ms` suffix already stripped), in the operator's
// words. An unknown stage keeps its raw name rather than being dropped.
const STAGE_RU = {
  goto: 'переход', act: 'нажатие', settle: 'ожидание сети',
  overlay: 'баннеры', snap: 'снимок DOM', attempt: 'попытка (сбой)',
};
// The remainder of a row's wall clock that no declared stage covers. It is time INSIDE this step
// that nobody measured — not navigation (the navigation KPI is a separate quantity, summed over
// route rows only), and emphatically not model thinking (there is no such stage; see the honesty
// note at the top of this file).
export const UNEXPLAINED_LABEL = 'не измерено внутри шага';
const UNEXPLAINED_COLOR = '#525252'; // house neutral, deliberately not a category colour

// A row's stacked phase bar: the measured stages, then the unexplained remainder. `explained`
// is false when the row measured NOTHING — the renderer must then draw no bar at all.
export function segmentsOf(row) {
  const stages = (row && Array.isArray(row.stages) ? row.stages : []).filter((s) => s && Number.isFinite(s.ms));
  const idle = row && Number.isFinite(row.idleMs) ? Math.max(0, row.idleMs) : 0;
  const dur = row && Number.isFinite(row.durMs) ? row.durMs : 0;
  const segments = stages.map((s) => ({ key: s.name, label: STAGE_RU[s.name] || s.name, ms: s.ms, measured: true }));
  if (idle > 0) segments.push({ key: 'idle', label: UNEXPLAINED_LABEL, ms: idle, measured: false });
  const totalMs = segments.reduce((sum, s) => sum + s.ms, 0);
  for (const s of segments) s.pct = totalMs > 0 ? (s.ms / totalMs) * 100 : 0;
  // No stage AND no measured gap (the first row, which invents nothing) → nothing to draw.
  return { segments, totalMs, explained: stages.length > 0, empty: totalMs === 0 && dur === 0 };
}

// Mask the volatile parts of a route so a 50-row listing folds to one line. A local, deliberately
// small masker: graph-store's toUrlPattern is server code and is not served to the page.
export function routePattern(route) {
  if (route == null) return '';
  return String(route).split('/')
    .map((s) => (/^\d+$/.test(s) || /^[0-9a-f]{8}-[0-9a-f-]{8,}$/i.test(s) || /^[0-9a-f]{16,}$/i.test(s) ? ':param' : s))
    .join('/');
}

// Only NAVIGATION folds HERE. Acts are the narrative the operator came to read — collapsing three
// consecutive clicks on one page would hide exactly what he asked to see. (The one exception is a
// run of acts that are identical in outcome AND duration, which is a single systematic effect
// rather than a narrative; that is a SEPARATE fold — foldIdenticalRuns below — and it is
// expandable, so nothing the operator asked to see is destroyed.)
const FOLDABLE = new Set(['route', 'route.visit']);

// Fold CONSECUTIVE navigation rows sharing a url pattern into one row carrying the count and the
// summed time. Order is preserved and time is CONSERVED (Σ durMs across the folded list equals
// Σ durMs of the input), so the tab cannot quietly lose a run's wall clock the way a filter would.
export function foldPipeline(rows) {
  const out = [];
  for (const r of Array.isArray(rows) ? rows : []) {
    if (!r || typeof r !== 'object') continue;
    const key = FOLDABLE.has(r.kind) ? r.kind + '|' + routePattern(r.route) : null;
    const prev = out[out.length - 1];
    if (key && prev && prev.foldKey === key) {
      prev.count++;
      prev.durMs += Number.isFinite(r.durMs) ? r.durMs : 0;
      prev.declaredMs += Number.isFinite(r.declaredMs) ? r.declaredMs : 0;
      prev.idleMs += Number.isFinite(r.idleMs) ? r.idleMs : 0;
      prev.requests += Number.isFinite(r.requests) ? r.requests : 0;
      prev.members.push(r);
      for (const s of r.stages || []) {          // stages merge by name, not by position
        const hit = prev.stages.find((x) => x.name === s.name);
        if (hit) hit.ms += s.ms; else prev.stages.push({ ...s });
      }
      continue;
    }
    out.push({
      ...r,
      stages: (r.stages || []).map((s) => ({ ...s })),
      durMs: Number.isFinite(r.durMs) ? r.durMs : 0,
      declaredMs: Number.isFinite(r.declaredMs) ? r.declaredMs : 0,
      idleMs: Number.isFinite(r.idleMs) ? r.idleMs : 0,
      requests: Number.isFinite(r.requests) ? r.requests : 0,
      foldKey: key, count: 1, members: [r], pattern: routePattern(r.route),
    });
  }
  return out;
}

/* ------------------------------------------------------------------ identical-run collapse */

// Rows 19-25 of run `raw1` are seven consecutive steps at 6.3s that ALL failed the same way. An
// identical duration plus an identical outcome, seven times running, is ONE systematic effect —
// almost certainly a fixed timeout — and the screen rendered it as seven independent grey rows and
// said nothing. «Страница показывает данные, но не делает выводов» was the exact criticism.
//
// So a run of ≥ RUN_MIN rows sharing kind + FAILURE CLASS + duration (within tolerance) collapses
// into one row that STATES the repeat count, and the reader can expand it.
//
// Deliberate scope limits, each one load-bearing:
//  - Only rows carrying a failure CLASS group. A run of SUCCESSFUL acts is the narrative — three
//    different controls clicked in a row are three facts, not one — and must never collapse.
//  - The key is the failure CLASS, not the raw outcome string. The seven rows above carry seven
//    DIFFERENT selectors inside one NO_INSTANCE message, so string equality finds nothing (measured:
//    it split the seven into a 2 and a 4 and dropped one). classify() is the right granularity.
//  - Duration is compared with a TOLERANCE against the run's first row. A fixed timeout jitters by
//    tens of milliseconds (6313/6284/6295/6280/6264/6274/6307 — a 0.8% spread), never by a second.
//  - Time is CONSERVED, exactly as in foldPipeline: the collapsed row carries the summed durMs.
export const RUN_MIN = 3;
export const RUN_TOLERANCE = 0.08;

// The grouping key, or null for a row that must never be collapsed.
export function repeatKeyOf(row) {
  if (!row || !row.outcome) return null;
  const cls = classify({ error: String(row.outcome), code: String(row.outcome) });
  if (!cls) return null;
  return row.kind + '|' + cls.code;
}
const withinTolerance = (a, b) => {
  const hi = Math.max(Math.abs(a), Math.abs(b));
  return hi === 0 ? true : Math.abs(a - b) / hi <= RUN_TOLERANCE;
};

export function foldIdenticalRuns(rows) {
  const list = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
  const out = [];
  let i = 0;
  while (i < list.length) {
    const key = repeatKeyOf(list[i]);
    let j = i;
    if (key) {
      while (j + 1 < list.length && repeatKeyOf(list[j + 1]) === key
        && withinTolerance(list[i].durMs || 0, list[j + 1].durMs || 0)) j++;
    }
    const n = j - i + 1;
    if (!key || n < RUN_MIN) { for (let k = i; k <= j; k++) out.push(list[k]); i = j + 1; continue; }
    const members = list.slice(i, j + 1);
    const merged = { ...members[0], stages: (members[0].stages || []).map((s) => ({ ...s })) };
    merged.durMs = 0; merged.declaredMs = 0; merged.idleMs = 0; merged.requests = 0;
    merged.stages = [];
    for (const m of members) {
      merged.durMs += Number.isFinite(m.durMs) ? m.durMs : 0;
      merged.declaredMs += Number.isFinite(m.declaredMs) ? m.declaredMs : 0;
      merged.idleMs += Number.isFinite(m.idleMs) ? m.idleMs : 0;
      merged.requests += Number.isFinite(m.requests) ? m.requests : 0;
      for (const s of m.stages || []) {
        const hit = merged.stages.find((x) => x.name === s.name);
        if (hit) hit.ms += s.ms; else merged.stages.push({ ...s });
      }
    }
    const each = members.map((m) => (Number.isFinite(m.durMs) ? m.durMs : 0)).sort((a, b) => a - b);
    merged.foldKind = 'repeat';
    merged.count = n;
    merged.members = members;
    merged.repeatMs = each[Math.floor(each.length / 2)];      // the shared duration, as a median
    merged.repeatSpreadMs = each[each.length - 1] - each[0];  // how far from identical they really are
    out.push(merged);
    i = j + 1;
  }
  return out;
}

// The two folds, in the one order that works: navigation patterns first (they collapse route rows
// that would otherwise sit between two failures and break a genuine repeat run), identical
// outcomes second. Rows already collapsed by the first fold carry count>1 and no `outcome`, so the
// second never re-folds them.
export function foldAll(rows) { return foldIdenticalRuns(foldPipeline(rows)); }

// The bar scale: 100% of the track = the p95 row duration, so the long rows stand out without
// one 134s outlier flattening everything else. Reported in the legend — a scale nobody can see
// is a scale nobody can check.
export function pipelineScale(rows) {
  const ds = (Array.isArray(rows) ? rows : []).map((r) => (r && Number.isFinite(r.durMs) ? r.durMs : 0)).sort((a, b) => a - b);
  if (!ds.length) return 1;
  return Math.max(1, ds[Math.min(ds.length - 1, Math.floor(ds.length * 0.95))]);
}

// Run-level numbers for the tab's KPI strip. EVERY accumulator is Number.isFinite-guarded: a
// failed act carries `timings:{attemptMs}` with no actMs, and a bare `tot += undefined` renders
// the whole run as NaN. `avgActMs` stays the average over acts that COMPLETED a causal window —
// attempt time is reported separately and never folded in, which would redefine the metric.
export function pipelineKpis(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const th = runThresholds(list);
  let wallMs = 0, navMs = 0, unexplainedMs = 0, slow = 0, outliers = 0, requests = 0;
  let actN = 0, actMs = 0, attemptN = 0, attemptMs = 0, decisionN = 0, decisionMs = 0, failed = 0;
  let repeatGroups = 0, repeatRows = 0;
  for (const r of list) {
    if (!r || typeof r !== 'object') continue;
    const d = Number.isFinite(r.durMs) ? r.durMs : 0;
    wallMs += d;
    if (kindStyle(r.kind).cat === 'navigation') navMs += d;
    if (Number.isFinite(r.idleMs)) unexplainedMs += Math.max(0, r.idleMs);
    if (Number.isFinite(r.requests)) requests += r.requests;
    const b = budgetOf(r, th);
    if (b.over) slow++;
    if (b.outlier) outliers++;
    if (r.foldKind === 'repeat' && r.count > 1) { repeatGroups++; repeatRows += r.count; }
    if (r.kind === 'act.failed') failed++;
    if (DECISION_KINDS.has(r.kind)) { decisionN++; decisionMs += d; }
    for (const s of r.stages || []) {
      if (!s || !Number.isFinite(s.ms)) continue;
      if (s.name === 'act') { actMs += s.ms; actN++; }
      if (s.name === 'attempt') { attemptMs += s.ms; attemptN++; }
    }
  }
  const pct = (part) => (wallMs > 0 ? (part / wallMs) * 100 : 0);
  return {
    rows: list.length, wallMs, navMs, navPct: pct(navMs),
    unexplainedMs, unexplainedPct: pct(unexplainedMs), requests, failed,
    // `slow` is measured against the run's own p95 (see budgetOf), so it is ~5% of rows by
    // construction rather than the 99.7% the old fixed constant produced. `slowMs` is the number
    // it was measured against and is printed beside it — a threshold nobody can see is a threshold
    // nobody can check. Both are null when the run is too small to have a distribution.
    slow, slowMs: th.all ? th.all.slowMs : null, outliers,
    repeatGroups, repeatRows,
    avgActMs: actN ? Math.round(actMs / actN) : null,        // null → '—', never a fabricated 0
    avgAttemptMs: attemptN ? Math.round(attemptMs / attemptN) : null,
    decisionMs: decisionN ? decisionMs : null,               // null === the trail has no such stage
    decisionRows: decisionN,
  };
}

// Newest run that actually HAS a trail. The viewer defaulted to `runs[0]`, runs sort newest-first
// and the newest are aborted zero-event runs — so the operator opened the admin, got a blank
// screen and reasonably concluded nothing had been built. Empty runs stay LISTED (marked), never
// hidden; if every run is empty the newest is still selected rather than nothing.
export function newestRunWithTrail(runs) {
  const list = Array.isArray(runs) ? runs.filter(Boolean) : [];
  if (!list.length) return null;
  return list.find((r) => Number(r.trailBytes) > 0) || list[0];
}

export const isEmptyRun = (run) => !!run && !(Number(run.trailBytes) > 0);

/* ------------------------------------------------------------------ formatting */

export function fmtMs(ms) {
  if (!Number.isFinite(ms)) return '—';
  if (ms < 1000) return Math.round(ms) + ' мс';
  if (ms < 60000) return (ms / 1000).toFixed(ms < 10000 ? 1 : 0) + ' с';
  return Math.floor(ms / 60000) + ' м ' + Math.round((ms % 60000) / 1000) + ' с';
}
const pct1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : '0.0') + '%';
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Human row title. derivePipeline's label is English and prefixed with its kind; the kind is
// already carried by the badge, so strip it and keep the WHO/WHERE the operator cares about.
//
// The `who` half is an element NAME, and a name is sometimes the concatenated text of a whole
// subtree (`Add GroupuploadCreatesearchConnections (0)No dataNo Connections Found`). displayName
// is the ONE truncator — the same one the Прогоны walk uses — so a row and its walk step never
// disagree about how long a name is. `rowTitleFull` keeps the untruncated string for the tooltip.
export function rowTitle(row, graph) {
  return displayName(rowTitleFull(row, graph), 72).text;
}
// `graph` is optional and only sharpens a NAMELESS control's anchor (anchorSource lifts the
// element's selector out of the snapshot when the payload carried none). Absent → same chain, one
// rung lower.
export function rowTitleFull(row, graph) {
  const st = kindStyle(row.kind);
  // A REPEAT GROUP is titled by what its members SHARE — the outcome — never by member 1. The seven
  // collapsed failures are seven different controls; «клик · General ×4» would assert something
  // false about the other three. The members themselves are listed in the inspector.
  if (row.foldKind === 'repeat' && row.count > 1) {
    const cls = classify({ error: String(row.outcome || ''), code: String(row.outcome || '') });
    return `${cls ? cls.chip : 'одинаковый исход'} ×${row.count} · по ${fmtMs(comparableMs(row))}`;
  }
  const what = rowWho(row, graph) || row.route || '—';
  const tail = row.count > 1 ? ` ×${row.count}` : '';
  return (st.verb ? st.verb + ' · ' : '') + what + tail;
}
// WHO the row is about. An act row used to fall back to `label`, which is `act <name || role>` —
// so a control with no accessible name rendered as «клик · button», a ROLE, which identifies
// nothing on a page with forty buttons. When the row carries the raw identity fields (every run
// written after scrub-math started copying them) the anchor chain answers properly: test-id,
// stable id, distinctive class, sibling position, template number. Older rows still have `label`.
function rowWho(row, graph) {
  if (row && (row.name || row.templateId != null || row.instanceSelector || row.error)) {
    const d = displayName(anchorSource(row, graph), 72);
    if (d.full) return d.full;
  }
  // The prefix strip must match a WHOLE token: without the trailing boundary, `route-choice`
  // (one of the new decision kinds) rendered as «-choice».
  return String(row.label || row.kind || '').replace(/^(act failed|act|observe|route\.visit|route)(\s+|$)/, '').trim();
}

/* ------------------------------------------------------------------ render */

// The pv-* tokens are now ALIASES of the shell tokens, not a second palette. Keeping the names
// means every rule below is untouched while the colours become the house ones.
const CSS = `
.pv { --pv-bg:var(--bg); --pv-card:var(--panel); --pv-line:var(--line); --pv-dim:var(--dim); --pv-mut:var(--mut); --pv-acc:var(--panel2);
      flex:1; min-height:0; display:flex; flex-direction:column; background:var(--pv-bg); color:var(--fg); overflow:hidden; }
.pv-kpis { display:flex; gap:18px; flex-wrap:wrap; padding:9px 14px; border-bottom:1px solid var(--pv-line); flex:0 0 auto; }
.pv-kpi b { font-size:14px; } .pv-kpi span { color:var(--pv-dim); font-size:11px; text-transform:uppercase; letter-spacing:.3px; }
.pv-note { padding:7px 14px; font-size:12px; color:var(--pv-dim); background:var(--pv-card); border-bottom:1px solid var(--pv-line); flex:0 0 auto; }
.pv-note b { color:#e7e5e4; }
.pv-main { flex:1; display:grid; grid-template-columns:1fr 340px; min-height:0; }
.pv-list { overflow-y:auto; overflow-x:hidden; }
.pv-insp { border-left:1px solid var(--pv-line); background:var(--pv-card); overflow-y:auto; padding:12px 14px; font-size:12px; }
.pv-row { height:30px; display:flex; align-items:center; gap:8px; padding:0 12px 0 0; border-bottom:1px solid rgba(255,255,255,.04);
          cursor:pointer; position:relative; overflow:hidden; }
.pv-row:hover { background:var(--panel2); }
/* selection is a hairline + a lift, never a filled accent block (house rule: no filled backgrounds) */
.pv-row.sel { background:var(--pv-acc); box-shadow:inset 2px 0 0 var(--fg); }
.pv-row.sel .pv-lbl, .pv-row.sel .pv-dur { color:var(--fg); }
.pv-stripe { width:3px; height:100%; flex:0 0 auto; background:var(--c); }
.pv-seq { width:44px; flex:0 0 auto; text-align:right; color:var(--pv-mut); font-size:11px; font-variant-numeric:tabular-nums; }
/* house StatusPill: border + text tint, NEVER a filled background */
.pv-badge { flex:0 0 auto; min-width:62px; text-align:center; font-size:10px; padding:0 6px; border-radius:2px;
            border:1px solid color-mix(in srgb, var(--c) 40%, transparent); color:var(--c); text-transform:uppercase; letter-spacing:.4px; }
.pv-lbl { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:12px; }
.pv-bar { width:190px; flex:0 0 auto; height:9px; border-radius:2px; background:rgba(255,255,255,.05); display:flex; overflow:hidden; }
.pv-bar i { display:block; height:100%; }
/* 128px, not 104: the house type is monospace, so "3 м 23 с / 1.0 с" is wider than it was in sans and wrapped */
.pv-dur { width:128px; flex:0 0 auto; text-align:right; font-size:11px; color:var(--pv-dim); white-space:nowrap; font-variant-numeric:tabular-nums; }
.pv-dur em { color:var(--pv-mut); font-style:normal; }
.pv-dur.over { color:var(--warn); }
/* an OUTLIER is the one thing on this list that must not read as ordinary: red text plus a word,
   never colour alone (the 3m23s row was invisible among 1.1s rows precisely because it was styled
   identically to them) */
.pv-dur.outlier { color:var(--bad); font-weight:600; }
.pv-row.outlier { background:color-mix(in srgb, var(--bad) 7%, transparent); }
.pv-flag { flex:0 0 auto; font-size:10px; text-transform:uppercase; letter-spacing:.4px; padding:0 6px;
           border-radius:2px; border:1px solid color-mix(in srgb,var(--bad) 45%,transparent); color:var(--bad); }
/* the repeat-group toggle: states the count in the row and expands to the members in place */
.pv-rep { flex:0 0 auto; font-size:11px; color:var(--pv-dim); border:1px solid var(--pv-line);
          border-radius:2px; padding:0 6px; cursor:pointer; font-variant-numeric:tabular-nums; }
.pv-rep:hover { color:var(--fg); border-color:var(--pv-mut); }
.pv-row.member { opacity:.72; } .pv-row.member .pv-seq { padding-left:10px; }
/* the stated conclusion — the point of the panel, so it sits above the raw fields, not under them */
.pv-verdict { margin:2px 0 10px; padding:8px 10px; border:1px solid var(--pv-line); border-left:2px solid var(--warn);
              border-radius:3px; background:var(--pv-bg); font-size:12px; line-height:1.5; }
.pv-verdict b { color:var(--fg); }
.pv-req { width:34px; flex:0 0 auto; text-align:right; font-size:11px; color:var(--pv-mut); font-variant-numeric:tabular-nums; }
.pv-insp h4 { margin:0 0 8px; font-size:13px; } .pv-insp h5 { margin:12px 0 5px; font-size:10px; text-transform:uppercase;
              letter-spacing:.4px; color:var(--pv-dim); font-weight:600; }
.pv-kv { display:flex; justify-content:space-between; gap:10px; padding:2px 0; border-bottom:1px solid rgba(255,255,255,.04); }
.pv-kv span { color:var(--pv-dim); } .pv-kv b { font-weight:500; font-variant-numeric:tabular-nums; }
.pv-seg { display:flex; align-items:center; gap:7px; padding:2px 0; }
.pv-seg i { width:9px; height:9px; border-radius:2px; flex:0 0 auto; }
.pv-seg .nm { flex:1; } .pv-seg .ms { color:var(--pv-dim); font-variant-numeric:tabular-nums; }
.pv-why { color:var(--pv-mut); font-size:11px; line-height:1.45; margin-top:6px; }
.pv-empty { padding:60px 24px; text-align:center; color:var(--pv-dim); line-height:1.7; }
.pv-mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
`;

function kpiStrip(k) {
  const kpi = (v, l, t, cls) => `<span class="pv-kpi ${cls || ''}" title="${esc(t || '')}"><b>${v}</b> <span>${esc(l)}</span></span>`;
  return [
    kpi(fmtMs(k.wallMs), 'всего', 'сумма всех шагов конвейера — ровно время прогона'),
    kpi(k.rows, 'шагов', 'строк после свёртки повторяющихся переходов и одинаковых сбоев'),
    // NAVIGATION and NOT-MEASURED are different quantities and must never read as one: the first
    // is wall clock spent in route rows, the second is the part of ANY row no stage accounted for.
    kpi(pct1(k.navPct), 'навигация', 'доля времени в переходах между страницами (только строки-переходы)'),
    kpi(pct1(k.unexplainedPct), 'не измерено', 'время внутри шагов, которое ни одна объявленная стадия не покрывает — это не навигация'),
    kpi(fmtMs(k.avgActMs), 'средний клик', 'среднее по актам, которые ДОШЛИ до конца; сбойные сюда не входят'),
    ...(k.avgAttemptMs != null ? [kpi(fmtMs(k.avgAttemptMs), 'средняя попытка', 'среднее по сбойным актам — считается отдельно')] : []),
    // The threshold is named IN the label, so the number can be checked rather than trusted.
    kpi(k.slowMs == null ? '—' : k.slow, k.slowMs == null ? 'медленных' : `медленнее p95 (${fmtMs(k.slowMs)})`,
      'порог взят из распределения ЭТОГО прогона, а не выбран заранее: p95 по строкам той же категории'),
    ...(k.outliers ? [kpi(k.outliers, plural(k.outliers, ['аномалия', 'аномалии', 'аномалий']),
      `шагов длиннее «медиана + ${OUTLIER_FACTOR}× верхний разброс» этого прогона — это не «медленно», а выброс`, 'bad')] : []),
    ...(k.repeatGroups ? [kpi(k.repeatGroups, plural(k.repeatGroups, ['серия повторов', 'серии повторов', 'серий повторов']),
      `${k.repeatRows} одинаковых шагов свёрнуты в ${k.repeatGroups} — один системный эффект, а не ${k.repeatRows} событий`)] : []),
    kpi(k.decisionMs == null ? '—' : fmtMs(k.decisionMs), 'решения модели',
      'в трейле нет ни одной стадии решения модели: маршрут выбирает скрипт'),
  ].join('');
}

function rowHtml(row, i, scale, selected, ctx) {
  const { th, idGraph, expanded } = ctx || {};
  const st = rowStyle(row);
  const { segments, empty } = segmentsOf(row);
  const b = budgetOf(row, th);
  const fill = Math.max(empty ? 0 : 2, Math.min(100, (row.durMs / scale) * 100));
  const bar = empty ? '' : segments.map((s) => {
    const w = (s.pct / 100) * fill;
    return `<i style="width:${w.toFixed(2)}%;background:${s.measured ? st.color : UNEXPLAINED_COLOR}" title="${esc(s.label)} ${esc(fmtMs(s.ms))}"></i>`;
  }).join('');
  // The threshold is shown per row too, and named. `—` when the run is too small to have one; a
  // fabricated default here is exactly what made the old column meaningless.
  const cmp = b.derived ? `<em>/ p95 ${esc(fmtMs(b.ms))}</em>` : '<em>/ —</em>';
  const dur = empty ? '—' : `${esc(fmtMs(row.durMs))}${row.count > 1 ? ' <em>всего</em>' : ''} ${cmp}`;
  // AN OUTLIER IS MARKED, not left for the reader to spot among 288 even grey rows.
  const mark = b.outlier && !empty ? '<span class="pv-flag">аномалия</span>' : '';
  const rep = row.foldKind === 'repeat' && row.count > 1
    ? `<span class="pv-rep" data-exp="${i}" title="${esc(`${row.count} одинаковых шагов — раскрыть`)}">${expanded ? '▾' : '▸'} ×${esc(row.count)}</span>` : '';
  return `<div class="pv-row ${i === selected ? 'sel' : ''} ${b.outlier && !empty ? 'outlier' : ''} ${ctx && ctx.member ? 'member' : ''}" data-i="${i}" style="--c:${st.color}">
    <span class="pv-stripe"></span><span class="pv-seq">${esc(row.seq)}</span>
    <span class="pv-badge">${esc(st.badge)}</span>
    <span class="pv-lbl" title="${esc(rowTitleFull(row, idGraph))}">${esc(rowTitle(row, idGraph))}</span>
    ${rep}${mark}
    <span class="pv-bar">${bar}</span>
    <span class="pv-dur ${b.outlier ? 'outlier' : b.over && !empty ? 'over' : ''}">${dur}</span>
    <span class="pv-req">${row.requests ? esc(row.requests) : ''}</span></div>`;
}

// The row's outcome, EXPLAINED. `graph` is the snapshot the page fetched for THIS row (see
// mountPipeline's graphFor hook): with it, the NO_INSTANCE split states which of its two opposite
// diagnoses applies; without it the module degrades honestly and names the missing input rather
// than sending the reader to another tab. The raw outcome string stays visible underneath —
// replaced nothing, added a verdict.
function outcomeBlock(row, graph, idGraph) {
  const kv = (k, v) => `<div class="pv-kv"><span>${esc(k)}</span><b>${v}</b></div>`;
  if (!row || !row.outcome) return kv('исход', '—');
  // Prefer the row's OWN payload fields (templateId keys the graph join; target.hadRevealPath
  // answers the split with no graph at all). `outcome` is the fallback for archived rows.
  const step = {
    error: row.error || String(row.outcome), code: row.code || String(row.outcome),
    templateId: row.templateId, role: row.role, name: row.name,
    instanceSelector: row.instanceSelector, target: row.target,
  };
  const ex = explainFailure(anchorSource(anchorSource(step, graph), idGraph), graph);
  if (!ex) return kv('исход', esc(row.outcome));
  return kv('исход', `${esc(ex.toneLabel)} · ${esc(ex.chip)}`)
    + `<div class="pv-why">${esc(ex.sentence)}</div>`
    + `<div class="pv-why pv-mono">${esc(row.outcome)}</div>`;
}

// THE CONCLUSION, STATED. A debug screen that renders an even list and hopes the reader notices
// the pattern has not done its job; these two paragraphs say what the numbers mean.
function verdictBlock(row, b) {
  const out = [];
  if (b.outlier && b.derived) {
    const share = row.runWallMs > 0 ? (row.durMs / row.runWallMs) * 100 : 0;
    // A near-zero median (an all-fast distribution with one outlier) rounds the ratio to 0 and reads
    // "в 0 раз больше медианы", which is nonsense; floor the multiplier at 1 so the sentence stays honest.
    const k = Math.max(1, Math.round(b.medianRatio));
    out.push(`<div class="pv-verdict"><b>Это выброс, а не «медленно».</b> Шаг занял ${esc(fmtMs(row.durMs))} — в ${esc(k)} ${esc(plural(k, ['раз', 'раза', 'раз']))} больше медианы прогона (${esc(fmtMs(b.medianMs))})`
      + `${share >= 1 ? ` и съел ${esc(share.toFixed(0))}% всего времени прогона` : ''}. Остальные шаги этой категории укладываются в ${esc(fmtMs(b.ms))} (p95).</div>`);
  }
  if (row.foldKind === 'repeat' && row.count > 1) {
    const n = row.count, spread = row.repeatSpreadMs;
    out.push(`<div class="pv-verdict"><b>Эти ${esc(n)} ${esc(plural(n, ['шаг', 'шага', 'шагов']))} одинаковы.</b> Подряд, один и тот же исход, одна и та же длительность — ${esc(fmtMs(row.repeatMs))}`
      + `${Number.isFinite(spread) ? ` с разбросом ${esc(fmtMs(spread))}` : ''}. Совпадение длительности при совпадении исхода — это один системный эффект (так выглядит фиксированный таймаут), а не ${esc(n)} ${esc(plural(n, ['независимое событие', 'независимых события', 'независимых событий']))}.</div>`);
  }
  return out.join('');
}

function inspectorHtml(row, ctx) {
  const { th, graph, idGraph } = ctx || {};
  if (!row) return `<div class="pv-why">Выбери строку слева — здесь покажу, что это был за шаг, сколько он занял и из чего состояло это время.</div>`;
  const st = rowStyle(row);
  const { segments, explained, empty } = segmentsOf(row);
  const b = budgetOf(row, th);
  const kv = (k, v) => `<div class="pv-kv"><span>${esc(k)}</span><b>${v}</b></div>`;
  const when = Number.isFinite(row.ts) ? new Date(row.ts).toLocaleTimeString('ru-RU') : '—';
  const segRows = segments.map((s) => `<div class="pv-seg"><i style="background:${s.measured ? st.color : UNEXPLAINED_COLOR}"></i>
    <span class="nm">${esc(s.label)}</span><span class="ms">${esc(fmtMs(s.ms))} · ${esc(s.pct.toFixed(0))}%</span></div>`).join('');
  const timeBlock = empty
    ? `<div class="pv-why">Первый шаг прогона: до него ничего не было, поэтому длительность не измерена. Ноль здесь означал бы «мгновенно» — это неправда.</div>`
    : segRows + (explained ? '' : `<div class="pv-why">Этот шаг не сообщил о себе ни одной стадии — вся его длительность попала в «${esc(UNEXPLAINED_LABEL)}». Это не навигация и не работа модели: это время внутри шага, которое никто не замерил. Так во всех сохранившихся прогонах — события переходов писались без замеров стадий.</div>`);
  const folded = row.count > 1 && row.foldKind !== 'repeat'
    ? `<h5>свёрнуто</h5><div class="pv-why">${esc(row.count)} переходов по одному шаблону <span class="pv-mono">${esc(row.pattern)}</span>:</div>`
      + row.members.slice(0, 12).map((m) => `<div class="pv-kv"><span class="pv-mono">${esc(m.route || '—')}</span><b>${esc(fmtMs(m.durMs))}</b></div>`).join('')
      + (row.members.length > 12 ? `<div class="pv-why">…и ещё ${row.members.length - 12}</div>` : '')
    : '';
  const repeated = row.foldKind === 'repeat' && row.count > 1
    ? `<h5>свёрнутая серия</h5>`
      + row.members.slice(0, 12).map((m) => `<div class="pv-kv"><span class="pv-mono">${esc(String(rowTitle(m, idGraph)).slice(0, 40))}</span><b>${esc(fmtMs(m.durMs))}</b></div>`).join('')
      + (row.members.length > 12 ? `<div class="pv-why">…и ещё ${row.members.length - 12}</div>` : '')
    : '';
  return `<h4 title="${esc(rowTitleFull(row, idGraph))}">${esc(rowTitle(row, idGraph))}</h4>
    ${verdictBlock(row, b)}
    ${kv('шаг', esc(row.seq))}${kv('время', esc(when))}${kv('вид', esc(row.kind))}
    ${kv('страница', `<span class="pv-mono">${esc(row.route || '—')}</span>`)}
    ${row.requested ? kv('запрошено было', `<span class="pv-mono">${esc(row.requested)}</span>`) : ''}
    ${outcomeBlock(row, graph, idGraph)}${kv('запросов вызвано', esc(row.requests || 0))}
    <h5>сколько заняло</h5>
    ${kv('длительность', esc(empty ? '—' : fmtMs(row.durMs)))}
    ${kv('порог прогона (p95)', b.derived ? `${esc(fmtMs(b.ms))} ${b.over && !empty ? '· превышен' : ''}` : '—')}
    <div class="pv-why">${b.derived
      ? `Порог посчитан по ЭТОМУ прогону: p95 среди ${esc(b.n)} шагов той же категории (медиана ${esc(fmtMs(b.medianMs))}). Это сравнение с соседями, а не наш выбор — прежний фиксированный «бюджет» в 1&nbsp;с превышали 287 шагов из 288 и не значил ничего.`
      : 'Порога нет: в прогоне слишком мало шагов, чтобы у длительностей было распределение. Показывать здесь число значило бы выдумать его.'}</div>
    <h5>из чего состояло</h5>${timeBlock}
    ${row.overDeclared ? '<div class="pv-why">Шаг заявил больше времени, чем показали часы — расхождение показано, а не спрятано.</div>' : ''}
    ${folded}${repeated}`;
}

// Mount the tab into `el`. Returns { update(pipelineRows) } — the page owns run loading and
// hands over derivePipeline's rows, so this module never fetches and never parses a trail.
//
// TWO graph seams, because they answer two different kinds of question and must not be confused:
//
//  - `identityGraph()` — a run-STABLE fact: which selector/id/testid a templateId is. That does not
//    change during a run, so ONE snapshot names every row and the page loads it once. Naming only.
//  - `graphFor(row)` — a MOMENT-specific fact: whether a reveal path was recorded for this control
//    AT THIS STEP. A later snapshot would answer with a path that did not exist yet, so this is the
//    per-step snapshot and nothing else. It exists for the NO_INSTANCE split: the tab used to call
//    explainFailure with no graph at all, so every such row degraded to a hedge — and the hedge told
//    the operator to open a tab he was already on.
//
// Both are supplied by the page (which owns fetching and already caches snapshots for the
// scrubber); this module never fetches. `graphFor` may return a promise on a miss, and the tab
// repaints once when it lands — asked at most once per row, so a permanently-missing snapshot
// cannot spin.
export function mountPipeline(el, { graphFor, identityGraph } = {}) {
  if (!document.getElementById('pv-css')) {
    const s = document.createElement('style'); s.id = 'pv-css'; s.textContent = CSS; document.head.appendChild(s);
  }
  el.classList.add('pv');
  let rows = [], sel = 0;
  const expanded = new Set();   // repeat-group row keys the operator opened
  const asked = new Set();      // rows whose snapshot we already requested (loop guard)
  const rowKey = (r) => (r ? `${r.kind}:${r.seq}` : '');

  const graphForSelected = () => {
    const cur = rows[sel];
    if (!graphFor || !cur) return null;
    let res = null;
    try { res = graphFor(cur); } catch { return null; }
    if (res && typeof res.then === 'function') {
      const k = rowKey(cur);
      if (asked.has(k)) return null;
      asked.add(k);
      res.then(() => { if (rowKey(rows[sel]) === k) paint(); }).catch(() => {});
      return null;
    }
    return res || null;
  };

  const paint = () => {
    if (!rows.length) {
      el.innerHTML = `<div class="pv-empty">В этом прогоне нет событий.<br>Выбери слева прогон, помеченный не как «пустой», — или запусти новый: <span class="pv-mono">/recon &lt;url&gt;</span></div>`;
      return;
    }
    // A repeat group the operator opened is drawn as its members, in place. The fold is a reading
    // aid, never a filter: expanding restores every original row.
    const view = [];
    rows.forEach((r, i) => {
      if (r.foldKind === 'repeat' && r.count > 1 && expanded.has(rowKey(r))) {
        view.push({ row: r, i, head: true });
        r.members.forEach((m) => view.push({ row: m, i, member: true }));
      } else view.push({ row: r, i });
    });
    const scale = pipelineScale(rows);
    const th = runThresholds(rows);
    const wallMs = rows.reduce((s, r) => s + (Number.isFinite(r.durMs) ? r.durMs : 0), 0);
    for (const r of rows) r.runWallMs = wallMs;   // the outlier verdict needs the run total for its share
    let idg = null;
    try { idg = identityGraph ? identityGraph() : null; } catch { idg = null; }
    // The selected row's own snapshot answers the reveal split; the run's identity graph names
    // every row. Where both exist for the selected row, the step snapshot is the more specific.
    const ctx = { th, graph: graphForSelected(), idGraph: idg };
    el.innerHTML = `<div class="pv-kpis">${kpiStrip(pipelineKpis(rows))}</div>
      <div class="pv-note">Каждая строка — один шаг конвейера: что сделано, за сколько и из чего сложилось это время.
        <b>Модель здесь ничего не решает</b> — весь маршрут выбирает скрипт, поэтому неучтённое время помечено как «${esc(UNEXPLAINED_LABEL)}», а не как работа модели и не как навигация.
        Ширина полосы: 100% ≈ ${esc(fmtMs(scale))} (p95). Порог «медленно» и признак аномалии посчитаны по этому же прогону.</div>
      <div class="pv-main"><div class="pv-list">${view.map((v) => v.member
        ? rowHtml(v.row, v.i, scale, -1, { ...ctx, member: true })
        : rowHtml(v.row, v.i, scale, sel, { ...ctx, expanded: expanded.has(rowKey(v.row)) })).join('')}</div>
      <div class="pv-insp">${inspectorHtml(rows[sel], ctx)}</div></div>`;
    el.querySelectorAll('.pv-row').forEach((n) => { n.onclick = () => { sel = Number(n.dataset.i); paint(); }; });
    el.querySelectorAll('.pv-rep').forEach((n) => {
      n.onclick = (e) => {
        e.stopPropagation();
        const k = rowKey(rows[Number(n.dataset.exp)]);
        if (expanded.has(k)) expanded.delete(k); else expanded.add(k);
        paint();
      };
    });
  };
  return {
    // Returns the FOLDED row count — the same number this tab's own KPI strip reports, so the
    // sidebar's «Конвейер» badge can never disagree with the page it points at.
    update(pipelineRows) {
      rows = foldAll(pipelineRows);
      if (sel >= rows.length) sel = 0;
      paint();
      return rows.length;
    },
  };
}

// The viewer's CHROME lives in pipeline-shell.mjs (theme, sidebar, section stubs). Re-exported here so
// admin.html's single `import … from './pipeline-view.mjs'` keeps resolving; the browser fetches
// pipeline-shell.mjs transitively (admin-server serves it through its own allowlist branch).
export { SHELL_CSS, NAV_ITEMS, STUB_IDS, navCount, mountShell, STUBS, stubHtml } from './pipeline-shell.mjs';
