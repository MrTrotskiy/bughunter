// The «Покрытие» screen — the admin section answering the operator's sharpest question: "почему он
// не нажал остальное?". These are pure (instanceStats, instanceBuckets) → string assertions, executed
// against the REAL fix1 graph (masked into tests/fixtures/trail-golden/graph.json: 693 instances, 148
// walked). Like walk-view's viewer-truth gate, the point is that no CLAIM the screen makes can drift
// from the crawler's own numbers without a test going red.
//
// Guards: the coverage partition (walked + owed + policy-declined + churn + unreachable) sums to the
//   instance total with ZERO residue; the policy-declined subtotal is computed and rendered in a
//   PHYSICALLY SEPARATE section from the failure (unreachable) and churn buckets — "we declined on
//   purpose" and "we could not" stay unconfusable by STRUCTURE; every owner bucket carries its label;
//   and the drill-down (frontierInstanceBuckets) attributes each instance to exactly one bucket, so its
//   per-bucket counts sum to the frontierInstanceStats totals (no re-derived sampling rule can diverge).
//
// FAIL-ON-REVERT levers (each verified red by hand):
//  (a) drop a term from `summed` in coverage-view.coveragePartition → residual ≠ 0 → "zero residue" reds.
//  (b) in coverage-view.coveragePartition set `declinedSubtotal: declined + unreachable` (merge the
//      failure bucket into the policy subtotal) → the policy section renders 391 → "policy subtotal is
//      373, not merged with failure/churn" reds.
//  (c) remove an owner label (e.g. 'поломка') from coverageScreen → "every owner is labelled" reds.
//  (d) drop a bucket from frontierInstanceBuckets (e.g. skip the `site` push) → the drill-down no longer
//      sums to the stats total → "drill-down partitions the same total" reds.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { frontierInstanceStats, frontierInstanceBuckets } from '../../lib/recon/frontier.mjs';
import { coveragePartition, coverageLead, coverageScreen } from '../../lib/debug/coverage-view.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const GRAPH = path.resolve(HERE, '../fixtures/trail-golden/graph.json');

function loadStatsAndBuckets() {
  const graph = JSON.parse(fs.readFileSync(GRAPH, 'utf8'));
  let instances = 0;
  for (const el of Object.values(graph.elements)) instances += ((el && el.instances) || []).length;
  return { st: { ...frontierInstanceStats(graph), instances }, bk: frontierInstanceBuckets(graph), instances };
}

// The section between `<section ... data-owner="X"` and its closing `</section>`. Sections are siblings
// (never nested), so this isolates exactly one owner's rendered table — the structural seam the
// "unconfusable" rule depends on.
function ownerSection(html, owner) {
  const i = html.indexOf(`data-owner="${owner}"`);
  if (i < 0) return null;
  const start = html.lastIndexOf('<section', i);
  const end = html.indexOf('</section>', i);
  return html.slice(start, end + 10);
}
const subtotalOf = (section) => { const m = /data-subtotal="(\d+)"/.exec(section || ''); return m ? Number(m[1]) : null; };

test('the coverage partition sums to the instance total with ZERO residue', () => {
  const { st } = loadStatsAndBuckets();
  const p = coveragePartition(st);
  // The fix1 baseline, so a change to the population is visible, not silent.
  assert.equal(p.total, 693, 'instance total is the fix1 denominator');
  assert.equal(p.walked, 148);
  // Independent of coveragePartition's own arithmetic: the raw stat fields must themselves partition.
  const declined = st.siteRemainder + st.drillSkipped + st.widgetSkipped + st.cappedRemainder;
  assert.equal(st.walked + st.remaining + declined + st.churnSkipped + st.unreachable, st.instances,
    'walked + owed + policy-declined + churn + unreachable = every instance on disk');
  // And the screen's own partition has no residue — the lever (a) target.
  assert.equal(p.residual, 0, 'the coverage partition leaves zero residue');
  const html = coverageScreen(st, loadStatsAndBuckets().bk);
  assert.ok(!html.includes('Разбиение не сходится'), 'a zero-residue partition renders NO mismatch warning');
});

test('the lead sentence states the conclusion first, with the run numbers', () => {
  const { st } = loadStatsAndBuckets();
  const lead = coverageLead(coveragePartition(st));
  assert.equal(lead,
    'Из 545 непройденных контролов 373 отклонила наша собственная выборка, 13 увела перерисовка, 18 сломались — по-настоящему должны только 141.');
});

test('policy-declined subtotal is rendered SEPARATELY from the failure and churn buckets (unconfusable by structure)', () => {
  const { st, bk } = loadStatsAndBuckets();
  const p = coveragePartition(st);
  assert.equal(p.declinedSubtotal, 373, 'the policy subtotal is site+rows+widget+opener ONLY');
  const html = coverageScreen(st, bk);
  const policy = ownerSection(html, 'policy');
  const failure = ownerSection(html, 'failure');
  const churn = ownerSection(html, 'churn');
  assert.ok(policy && failure && churn, 'policy, failure and churn are each their OWN section');
  // The load-bearing separation: each owner carries its own subtotal, and the failure/churn counts are
  // NOT folded into the policy subtotal. Lever (b): merge them → policy subtotal becomes 391.
  assert.equal(subtotalOf(policy), 373, 'policy subtotal is 373, not merged with failure/churn');
  assert.equal(subtotalOf(failure), 18, 'failure (unreachable) is its own subtotal');
  assert.equal(subtotalOf(churn), 13, 'churn is its own subtotal');
  assert.ok(!html.includes('data-subtotal="391"') && !html.includes('data-subtotal="404"'),
    'no merged subtotal (373+18 or 373+18+13) is ever rendered');
  // The failure/churn bucket bodies must live in THEIR sections, never inside the policy table.
  assert.ok(!policy.includes('не достучались'), 'the failure bucket is not inside the policy section');
  assert.ok(!policy.includes('перерисовались до захода'), 'the churn bucket is not inside the policy section');
  assert.ok(failure.includes('не достучались') && churn.includes('перерисовались до захода'),
    'the failure and churn buckets render in their own sections');
});

test('every owner and every policy bucket carries its operator-facing label', () => {
  const { st, bk } = loadStatsAndBuckets();
  const html = coverageScreen(st, bk);
  for (const owner of ['наше правило', 'поломка', 'перерисовка страницы', 'реально должны']) {
    assert.ok(html.includes(owner), `owner label «${owner}» is present`);
  }
  for (const name of ['лимит представителей на страницу', 'прорежённые строки списка',
    'внутренности виджета', 'сверх лимита открывашки']) {
    assert.ok(html.includes(name), `policy bucket «${name}» is named in the operator's words`);
  }
});

test('the drill-down partitions the SAME total — its per-bucket counts sum to frontierInstanceStats', () => {
  const { st, bk, instances } = loadStatsAndBuckets();
  const sum = (k) => bk[k].reduce((a, r) => a + r.count, 0);
  // Each drill-down bucket's instance count equals its stats counterpart — the viewer never re-derives.
  assert.equal(sum('walked'), st.walked);
  assert.equal(sum('remaining'), st.remaining);
  assert.equal(sum('unreachable'), st.unreachable);
  assert.equal(sum('churn'), st.churnSkipped);
  assert.equal(sum('site'), st.siteRemainder);
  assert.equal(sum('rows'), st.drillSkipped);
  assert.equal(sum('widget'), st.widgetSkipped);
  assert.equal(sum('opener'), st.cappedRemainder);
  // Grand total across every bucket = every instance on disk, zero residue.
  const grand = ['walked', 'remaining', 'unreachable', 'churn', 'site', 'rows', 'widget', 'opener']
    .reduce((a, k) => a + sum(k), 0);
  assert.equal(grand, instances, 'the drill-down attributes every instance to exactly one bucket');
});

test('no run loaded (null stats) → an honest empty state, not a fabricated zero', () => {
  assert.equal(coveragePartition(null), null);
  const html = coverageScreen(null, null);
  assert.ok(html.includes('недоступно'), 'says the split is unavailable rather than inventing 0/0');
});
