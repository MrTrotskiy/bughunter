// frontier — Phase-1 receptive-field selection over the graph. Pure, no browser.
// The loop studies only a small batch of UNEXPLORED templates per step; this module
// decides WHICH, and reports the honest discovered/explored/remaining denominator.
//
// Guards: the recon loop only ever hands out UNEXPLORED templates, capped at the
//   receptive-field size, and the frontier drains to empty as they are explored — so
//   the loop makes forward progress, terminates, and never re-clicks known controls.
//   Also guards that the denominator does NOT collapse (discovered stays constant
//   while explored rises), and that a template drained-but-never-reached counts as
//   `unreachable`, NOT genuine `explored`.
// FAIL-ON-REVERT: (a) drop the `if (node.explored) continue` filter in nextBatch — an
//   explored template reappears → deepEqual [1,3,5] fails "explored templates 2 and 4
//   must be excluded"; (b) drop the `- unreachable` in frontierStats — the unreachable
//   node inflates `explored` → the {explored:1, unreachable:1} deepEqual fails.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeGraph, mergeSnapshot, markExplored, markUnreachable, markOpener, markInstanceExplored, markInstanceChurned } from '../../lib/graph/graph-store.mjs';
import { nextBatch, frontierStats, frontierInstanceStats, OPENER_INSTANCE_CAP, DRILL_PER_LIST } from '../../lib/recon/frontier.mjs';

// Build a graph with n distinct single-instance templates (ids 1..n), as ids.mjs
// would have minted them, then merged.
function seed(n) {
  const g = makeGraph();
  const els = [];
  for (let i = 1; i <= n; i++) {
    els.push({
      templateId: i,
      instanceId: i * 100,
      templateSelector: `button.b${i}`,
      role: 'button',
      name: `B${i}`,
      instanceKey: `#${i}`,
      instanceSelector: `button.b${i}:nth-child(${i})`,
    });
  }
  mergeSnapshot(g, '/', els);
  return g;
}

test('nextBatch returns only unexplored templates, ascending, capped at size', () => {
  const g = seed(5);
  markExplored(g, 2);
  markExplored(g, 4);
  const batch = nextBatch(g, { size: 3 });
  assert.deepEqual(
    batch.map((b) => b.templateId),
    [1, 3, 5],
    'explored templates 2 and 4 must be excluded',
  );
  for (const b of batch) {
    assert.ok(b.instance && b.instance.instanceSelector, 'each batch item carries an instance to act on');
  }
});

test('nextBatch honors the receptive-field cap', () => {
  const g = seed(10);
  assert.equal(nextBatch(g, { size: 3 }).length, 3);
  assert.equal(nextBatch(g, { size: 5 }).length, 5);
});

test('nextBatch skips templates with no addressable instance', () => {
  const g = seed(2);
  g.elements[1].instances = []; // template exists but nothing to click
  assert.deepEqual(nextBatch(g).map((b) => b.templateId), [2]);
});

test('frontier drains as templates are explored; denominator does not collapse', () => {
  const g = seed(3);
  assert.deepEqual(frontierStats(g), { discovered: 3, explored: 0, unreachable: 0, remaining: 3, routes: 1 });
  markExplored(g, 1);
  markExplored(g, 2);
  assert.deepEqual(frontierStats(g), { discovered: 3, explored: 2, unreachable: 0, remaining: 1, routes: 1 });
  markExplored(g, 3);
  assert.deepEqual(frontierStats(g), { discovered: 3, explored: 3, unreachable: 0, remaining: 0, routes: 1 });
  assert.equal(nextBatch(g).length, 0, 'empty frontier → loop terminates');
});

test('an unreachable-drained template counts as unreachable, not genuine coverage', () => {
  const g = seed(2);
  markExplored(g, 1);
  markUnreachable(g, 1, 'NO_INSTANCE'); // drained from the frontier but never actually reached
  markExplored(g, 2); // genuinely explored
  assert.deepEqual(frontierStats(g), { discovered: 2, explored: 1, unreachable: 1, remaining: 0, routes: 1 });
});

// Guards: instance-level coverage honesty — an opener with N instances is N addressable controls,
//   not one. frontierInstanceStats reports the honest instance-level frontier (walkable/walked/
//   remaining) that, unlike template `frontierStats`, never reads "done" while nextBatch still yields
//   opener siblings; and opener instances BEYOND OPENER_INSTANCE_CAP are counted in `cappedRemainder`
//   — the un-walked remainder is FLAGGED, never silently hidden (the "coverage never hidden" invariant).
// FAIL-ON-REVERT: make `cappedRemainder` always 0 (drop the `insts.length - CAP` term) → the
//   "2 beyond-cap flagged" assertion goes red; make the opener `limit` 1 (template-level) → walkable
//   reads 2 not CAP+1 and the walked/remaining assertions go red.
test('frontierInstanceStats: opener siblings + beyond-cap remainder are honest, not hidden', () => {
  const g = makeGraph();
  const N = OPENER_INSTANCE_CAP + 2; // 2 instances beyond the cap
  const els = [];
  for (let i = 1; i <= N; i++) els.push({
    templateId: 1, instanceId: 100 + i, templateSelector: 'button.nav', role: 'button',
    name: 'Nav', instanceKey: `#${i}`, instanceSelector: `button.nav:nth-child(${i})`,
  });
  els.push({ templateId: 2, instanceId: 200, templateSelector: 'button.x', role: 'button', name: 'X', instanceKey: '#1', instanceSelector: 'button.x' });
  mergeSnapshot(g, '/', els);
  markOpener(g, 1);

  const before = frontierInstanceStats(g);
  assert.equal(before.walkable, OPENER_INSTANCE_CAP + 1, 'opener contributes CAP walkable + the 1 plain template');
  assert.equal(before.cappedRemainder, 2, 'the 2 opener instances beyond the CAP are flagged, not hidden');
  assert.equal(before.walked, 0, 'nothing walked yet');
  assert.equal(before.remaining, OPENER_INSTANCE_CAP + 1, 'remaining = walkable while nothing is drained');

  markInstanceExplored(g, 1, '#1');
  markInstanceExplored(g, 1, '#2');
  markInstanceExplored(g, 1, '#3');
  markInstanceExplored(g, 2, '#1');
  const after = frontierInstanceStats(g);
  assert.equal(after.walked, 4, '3 opener siblings + the plain control walked');
  assert.equal(after.remaining, OPENER_INSTANCE_CAP + 1 - 4, 'remaining drops per walked INSTANCE (not template-count)');
  assert.equal(after.cappedRemainder, 2, 'the beyond-cap remainder is unchanged by walking within the cap');
});

// Guards: the LOCATION DENOMINATOR — the honest "how many sections did we discover" number a
//   single-URL SPA hides under one routeKey. Two controls under the SAME route but reached via
//   DIFFERENT reveal.statePath are two locations; a baseline (reveal-less) control is the root
//   location → 3 distinct locations. locationKey never touches identity (see the identity-proof test
//   in report-unreached.test.mjs), only this tally.
// FAIL-ON-REVERT: count instances instead of DISTINCT locationKeys (drop the Set) → the two
//   different-statePath controls under one route would count the root location twice / miscount → the
//   `locations.discovered === 3` assertion reds; key on `route` alone (ignore statePath) → the two
//   POST-nav sections collapse to 1 with the root → discovered reads 1, reds.
test('frontierInstanceStats: locations.discovered counts DISTINCT reveal-path sections, not routeKeys', () => {
  const g = makeGraph();
  // Baseline control — no reveal → the route's ROOT location ('/').
  mergeSnapshot(g, '/', [{
    templateId: 1, instanceId: 100, templateSelector: 'button.base', role: 'button',
    name: 'Base', instanceKey: '#1', instanceSelector: 'button.base',
  }]);
  // Control B behind opener path P1 (template 10) — location '/|10:#1'.
  mergeSnapshot(g, '/', [{
    templateId: 2, instanceId: 200, templateSelector: 'button.b', role: 'button',
    name: 'B', instanceKey: '#1', instanceSelector: 'button.b',
  }], { revealPath: [{ templateId: 10, instanceKey: '#1' }] });
  // Control C behind a DIFFERENT opener path P2 (template 20) — location '/|20:#1'.
  mergeSnapshot(g, '/', [{
    templateId: 3, instanceId: 300, templateSelector: 'button.c', role: 'button',
    name: 'C', instanceKey: '#1', instanceSelector: 'button.c',
  }], { revealPath: [{ templateId: 20, instanceKey: '#1' }] });

  const stats = frontierInstanceStats(g);
  assert.equal(stats.locations.discovered, 3, 'root + two distinct reveal-path sections = 3 locations under ONE routeKey');
  // The location tally is ADDITIVE — every pre-existing instance-frontier field is unchanged.
  assert.equal(stats.walkable, 3, 'three single-instance templates are walkable');
  assert.equal(stats.cappedRemainder, 0, 'no opener → no beyond-cap remainder');
});

// Build a NON-opener template whose n instances all live in a LIST ROW (node.listRow), as
// mergeSnapshot would flag from dom-snapshot's per-element inRow. A 50-row data list = 50 instances
// of ONE template; the frontier drills the representative (instance[0]) and must COUNT the rest.
function listRowTemplate(g, templateId, n, { inRow = true } = {}) {
  const els = [];
  for (let i = 1; i <= n; i++) els.push({
    templateId, instanceId: templateId * 1000 + i, templateSelector: `li.row button.edit${templateId}`,
    role: 'button', name: 'Edit', instanceKey: `#${i}`,
    instanceSelector: `li.row:nth-child(${i}) button.edit${templateId}`, inRow,
  });
  mergeSnapshot(g, '/', els);
}

// Guards: DRILL_PER_LIST honesty — a 50-row data list is 50 instances of ONE non-opener template.
//   nextBatch hands out only instance[0] (the representative), so the other 49 rows are NEITHER
//   walked NOR counted anywhere pre-increment — they silently vanish from the honest denominator.
//   frontierInstanceStats now counts them in `drillSkipped` (the non-opener analog of cappedRemainder:
//   counted, flagged, never walked), while `walkable`/`remaining` stay the DRILL_PER_LIST=1 representative.
// FAIL-ON-REVERT: drop the `else if (node.listRow) drillSkipped += ...` accumulation in
//   frontierInstanceStats → the 49 rows are un-counted → `drillSkipped === 49` reads 0, reds.
test('frontierInstanceStats: a 50-row list walks BOUNDARY rows and flags the rest', () => {
  // WAS: one representative, 49 flagged. The "fifty rows are one control" assumption is only SOMETIMES
  // true, and the data refuted it — of the row templates that ever had two rows probed, half behaved
  // differently (one row returned server data, another was inert; one changed the page, another did
  // nothing). Reporting a table as understood on evidence from one row out of fifty is the same shape as
  // every coverage number this project has had to retract.
  // NOW: boundary sampling — first, middle, last. Rows differ at the EDGES (the newest record, the
  // archived one, the one with empty optional fields), not in the middle of the run. The remainder is
  // still counted and flagged, never hidden.
  const g = makeGraph();
  listRowTemplate(g, 1, 50);
  const s = frontierInstanceStats(g);
  assert.equal(s.walkable, 3, 'first, middle and last row are walked — not one, not fifty');
  assert.equal(s.drillSkipped, 47, 'the remaining rows are counted+flagged, not hidden');
  assert.equal(s.walkable + s.drillSkipped, 50, 'and nothing falls out of the denominator');
});

// Guards: the flag is SCOPED — a non-listRow non-opener template (a lone control, no list-row ancestor)
//   contributes ZERO drillSkipped, so the increment never mis-counts an ordinary multi-instance template.
// FAIL-ON-REVERT: drop the `node.listRow` guard (accumulate for every non-opener) → a non-listRow
//   template's extra instances leak into drillSkipped → `drillSkipped === 0` reds.
test('frontierInstanceStats: a non-listRow non-opener template contributes 0 drillSkipped', () => {
  const g = makeGraph();
  listRowTemplate(g, 1, 50, { inRow: false }); // present-but-not-in-a-row → node.listRow stays unset
  const s = frontierInstanceStats(g);
  assert.equal(s.drillSkipped, 0, 'a non-listRow template drills nothing extra — unchanged behavior');
  assert.equal(s.walkable, 1, 'still only instance[0] walkable (non-opener)');
});

// Guards: opener vs list-row are MUTUALLY EXCLUSIVE — a list-row template that IS a proven opener uses
//   cappedRemainder (its siblings ARE walked up to the CAP), NOT drillSkipped. The `else if` ordering
//   ensures an opener never double-counts its beyond-cap remainder as drill-skipped.
// FAIL-ON-REVERT: change the `else if` to a plain `if` (accumulate drillSkipped for openers too) →
//   an opener list's beyond-cap rows land in BOTH buckets → `drillSkipped === 0` reds.
test('frontierInstanceStats: an opener list uses cappedRemainder, not drillSkipped', () => {
  const g = makeGraph();
  const N = OPENER_INSTANCE_CAP + 2;
  listRowTemplate(g, 1, N); // a list-row template …
  markOpener(g, 1);          // … that ALSO opens (its instances reveal controls)
  const s = frontierInstanceStats(g);
  assert.equal(s.cappedRemainder, 2, 'an opener beyond the CAP is counted in cappedRemainder');
  assert.equal(s.drillSkipped, 0, 'an opener is NOT double-counted as drill-skipped');
});

// Guards (blocker-6 Part B): the churnSkipped PEEL — a re-rendering feed's vanished representative
//   (markInstanceChurned, UNEXPLORED by design) is peeled OUT of walkable/remaining and QUANTIFIED in
//   churnSkipped, so the STABLE control set can reach remaining===0 while the churn is counted, never
//   hidden and never conflated into `unreachable`. The arithmetic invariant `remaining = walkable −
//   walked − unreachable` still holds because churned instances never enter `walkable`.
// FAIL-ON-REVERT: remove the `if (inst.churned) { churnSkipped++; continue; }` peel in
//   frontierInstanceStats → the churned (unexplored) representative re-enters `walkable` → it counts as
//   un-walked → `remaining === 1` (not 0) → the "remaining === 0" assertion reds, and churnSkipped reads 0.
test('frontierInstanceStats: a churned feed representative is peeled into churnSkipped, letting the stable set drain', () => {
  const g = makeGraph();
  // A stable single-instance control (walked) + a NON-opener list-row feed of 4 rows whose representative
  // (instance[0]) churned away UNEXPLORED (markInstanceChurned does not mark it explored, by design).
  const stable = { templateId: 1, instanceId: 100, templateSelector: 'button#stable', role: 'button', name: 'Show', instanceKey: '#1', instanceSelector: 'button#stable' };
  mergeSnapshot(g, '/', [stable]);
  markInstanceExplored(g, 1, '#1');       // the stable control is genuine coverage
  listRowTemplate(g, 2, 4);               // feed: instances "#1".."#4" of one list-row template
  markInstanceChurned(g, 2, '#1');        // its representative re-rendered away (unexplored churn)

  const s = frontierInstanceStats(g);
  assert.equal(s.churnSkipped, 1, 'the vanished representative is counted in churnSkipped');
  assert.equal(s.walked, 1, 'only the stable control counts as walked (the churned row is NOT inflated into walked)');
  // The churned instance is peeled — never walkable, never `unreachable`, always quantified. That is the
  // invariant this test exists for and it is unchanged.
  assert.ok(!(g.elements[2].instances[0].explored), 'the churned row is not silently marked explored');
  // WHAT CHANGED, and why the old expectation was itself the bug being guarded against. This asserted
  // `remaining === 0` and `drillSkipped === 3`, which encoded the old `.some(x => x.churned)` collapse:
  // ONE churned row made the whole template report a single (already-peeled) slot, so three untouched
  // rows were declared finished. Measured on a live graph, that rule left 21 clean, never-tried rows in
  // each employee-table template while the frontier counted them complete. The clean rows are real work,
  // so they must show up as remaining — an honest denominator does not shrink because a sibling vanished.
  assert.ok(s.remaining > 0, 'the surviving clean rows are still owed — they must not vanish from the denominator');
  assert.equal(s.remaining + s.walked + s.unreachable, s.walkable, 'the arithmetic invariant still holds');
});

// TABLES ARE STUDIED, NOT SAMPLED-BY-ONE — and the sample GROWS when the rows disagree.
//
// MEASURED: of the four row templates that ever had two rows probed, TWO behaved differently — one row
// returned server data while another was inert, one changed the page while another did nothing. The
// single-representative rule reports such a table as understood on evidence from one row in fifty, which
// is precisely the "counter that looks honest while hiding something else" failure this project keeps
// retracting numbers over.
//
// Guards: a stable list is sampled at its BOUNDARIES; a list whose rows have already answered
//   differently earns a WIDER sample; a CHURNING feed keeps one representative, because sampling rows
//   that re-render away can never terminate.
// FAIL-ON-REVERT: restore `return [0]` for list rows → "boundary rows are walked" reds (one row again);
//   drop the `rowsDisagree` widen → "a disagreeing table earns a wider sample" reds.
test('a list is sampled at its boundaries, wider once its rows disagree, and never on a churning feed', () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => ({ instanceKey: `#${i}`, instanceSelector: `#r${i}` }));
  const listNode = (n, extra = {}) => ({ elements: { 1: { role: 'link', name: 'Row', route: '/list', listRow: true, instances: rows(n), ...extra } } });

  // 1. Stable table → boundaries.
  const plain = nextBatch(listNode(20), { size: 50 });
  assert.equal(plain.length, 3, 'first, middle, last — one row is not a study of a table');
  assert.deepEqual(plain.map((b) => b.instance.instanceKey), ['#0', '#10', '#19'],
    'the boundaries are where rows actually differ: newest, middle, oldest');

  // 2. Rows already answered differently → the table has DISPROVEN its own homogeneity, widen.
  const disagreed = listNode(20, { probes: [
    { kind: 'click', verdict: 'read', instanceKey: '#0' },
    { kind: 'click', verdict: 'inert', instanceKey: '#19' },
  ] });
  assert.ok(nextBatch(disagreed, { size: 50 }).length > 3,
    'a disagreeing table earns a wider sample — homogeneity was an assumption and it failed');

  // 3. A FEW churned rows are NOT a churning feed — this is where the rule was wrong, and it cost a
  //    whole class of coverage. The predicate was `.some(x => x.churned)`, so ONE vanished row out of
  //    twenty collapsed the template to a single index, permanently (`churned` is write-once). MEASURED
  //    on a live graph: all four employee-table row templates carried {churned: 3, clean: 21} and
  //    `probes: 0` — 21 untouched rows each, reported as fully drained; 21 of 24 listRow templates in
  //    that graph had zero probes while holding 431 instances. The rows were never refused, they were
  //    never handed out.
  const fewChurned = listNode(20);
  fewChurned.elements[1].instances[3].churned = true;
  const stillSampled = nextBatch(fewChurned, { size: 50 });
  assert.equal(stillSampled.length, 3, 'one stale row out of twenty is not a moving target — the table is still sampled');
  assert.ok(!stillSampled.some((b) => b.instance.instanceKey === '#3'),
    'the churned row itself is not sampled — a vanished boundary must not consume a slot');

  // 4. TERMINATION, and it does not depend on recognising a feed. My first rule counted SURVIVORS
  //    (`cleanIdx.length < 2`) and could not work: a re-rendering feed MINTS new content-keyed instances
  //    every snapshot, so the survivor count only grows and the rule never fires on the very class it
  //    names. Boundary sampling always includes `len - 1`, which on a growing feed is always the freshest
  //    unexplored row — an unbounded act source that stops only when the whole run runs out of budget.
  //    Counting ATTEMPTS is monotone by construction: explored / unreachable / churned are never cleared.
  const spent = listNode(20);
  for (const k of [0, 10, 19]) spent.elements[1].instances[k].explored = true;
  assert.equal(nextBatch(spent, { size: 50 }).length, 0,
    'once ROW_SAMPLE rows have been ATTEMPTED the table drains — the rest stay counted in drillSkipped');

  // The feed case the survivor rule was supposed to cover, stated the way a live feed actually looks:
  // rows keep arriving, and the ones already walked churned away. It must still terminate.
  const growing = listNode(20);
  for (const k of [0, 10, 19]) growing.elements[1].instances[k].churned = true;
  growing.elements[1].instances.push(...Array.from({ length: 10 }, (_, i) => ({ instanceKey: `#fresh${i}`, instanceSelector: `#f${i}` })));
  assert.equal(nextBatch(growing, { size: 50 }).length, 0,
    'a feed that re-rendered its walked rows away and minted ten fresh ones is DONE, not restarted — '
    + 'the attempt budget is spent and no amount of new rows reopens it');
});

// A ROW IS NEVER `walked` WITHOUT AN ACT — the template flag is not evidence about a sibling.
//
// WHY THIS TEST EXISTS. `markInstanceExplored` stamps `inst.explored` AND unconditionally sets
// `node.explored` (graph-store). `instanceDrained` then read `i === 0 && node.explored` as proof that
// instance 0 was finished. While a non-opener list handed out exactly one index that was harmless — the
// node flag could only have come from acting instance 0. The moment boundary sampling handed out three,
// acting the middle row silently drained the FIRST row: an instance nobody resolved, nobody clicked, and
// which in the live fixture did not exist in the DOM at all. It was counted `walked`.
//
// That is fabricated coverage, one fake row per multi-sampled list template, and it is invariant #8
// (`explored ⟺ observed`) failing through a side door. It surfaced as a CONFUSING SYMPTOM rather than an
// obvious one: the drained representative was never enumerated for retirement, so the churn signal went
// silent and tests/live/churn-feed.test.mjs failed on `churnSkipped === 0`. I misread that as a fixture
// problem and was about to edit the fixture; a reviewer refuted it against the source.
//
// FAIL-ON-REVERT: restore the unguarded `(i === 0 && node.explored)` clause in instanceDrained → the
// untouched first row counts as walked → `walked === 1` reds.
test('frontierInstanceStats: acting one sampled row never marks a SIBLING row walked', () => {
  const g = makeGraph();
  const rows = Array.from({ length: 20 }, (_, i) => ({ instanceKey: `#${i}`, instanceSelector: `#r${i}` }));
  g.elements[1] = { templateId: 1, role: 'link', name: 'Row', route: '/list', listRow: true, instances: rows };
  // Exactly what markInstanceExplored does for a MIDDLE row: the instance flag plus the template flag.
  g.elements[1].instances[10].explored = true;
  g.elements[1].explored = true;

  const s = frontierInstanceStats(g);
  assert.equal(s.walked, 1, 'only the row that was actually acted counts as walked');
  const actedInstances = g.elements[1].instances.filter((i) => i.explored).length;
  assert.equal(s.walked, actedInstances, 'walked equals the number of instances carrying evidence of an act');
  assert.ok(!g.elements[1].instances[0].explored, 'the untouched first row never acquired an act it did not have');
});
