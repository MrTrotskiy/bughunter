// viewer-truth — THE ANTI-LIE GATE (ADMIN-TRUTH-PLAN.md, Stage 2). node:test, NO browser, NO DOM.
// Executes the admin viewer's on-screen CLAIMS (lib/debug/claims.mjs) against the golden trail
// fixture so a false sentence about our own crawler reds a test instead of reaching the operator.
// Two code reviews passed a lying screen because nothing ran writer + projection + renderer together
// over real data; this does exactly that, headlessly.
//
// Guards: the admin viewer cannot silently reassert the Stage-1 lies (lost field / unconditional
//   prose / dead classifier / writer-reader drift), and a NEW operator sentence must declare its
//   licence or the gate reds.
// FAIL-ON-REVERT (each verified by hand, sentinel recorded):
//   - drop `target` from deriveSteps → contradiction teeth-test reds ("legacy projection produced no
//     violations" flips: expected 10 violations of attempts-not-recorded).
//   - make model-decides-nothing licensedBy: () => true → conditionality reds ("unconditional:
//     licensed on 63/63 rows").
//   - remove any kind from KIND_STYLE → the KIND_STYLE liveness assertion reds with the lowered % (13
//     of 13 styled → drops below 90%).
//   - contentSig stays read with 0 stateful writers → parity todo reds ("written on 0 of 88 routes").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deriveSteps, derivePipeline } from '../../lib/debug/scrub-math.mjs';
import { KIND_STYLE, DECISION_KINDS, foldAll } from '../../lib/debug/pipeline-view.mjs';
import { frontierInstanceStats } from '../../lib/recon/frontier.mjs';
import {
  CLAIMS, registeredTexts, normalize, scanSentences, WORD_FLOOR, instanceCount, UNMEASURABLE_ON_FIXTURE,
} from '../../lib/debug/claims.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.resolve(HERE, '../fixtures/trail-golden');
const DEBUG = path.resolve(HERE, '../../lib/debug');

const events = fs.readFileSync(path.join(FIX, 'events.ndjson'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const graph = JSON.parse(fs.readFileSync(path.join(FIX, 'graph.json'), 'utf8'));
const steps = deriveSteps(events);
const rows = derivePipeline(events);
const bySeq = new Map(events.filter((e) => e && Number.isFinite(e.seq)).map((e) => [e.seq, e]));

// The instance-level coverage split the viewer ships as `instanceStats`, computed exactly as
// admin-server does (frontierInstanceStats + a plain instance count over the same graph).
const instanceStats = { ...frontierInstanceStats(graph), instances: instanceCount(graph) };
const runView = { instanceStats };
const runCtx = { graph, instanceStats };

// Local mirrors of the payload predicates the parity check needs (claims.mjs keeps them internal).
const hasAttempts = (p) => !!(p && p.target && Array.isArray(p.target.attempts) && p.target.attempts.length);
const finiteStatuses = (p) => (Array.isArray(p && p.requests) ? p.requests : []).map((r) => Number(r && r.status)).filter(Number.isFinite);

const viewsFor = (on) => (on === 'step' ? steps : on === 'row' ? rows : [runView]);
const eventFor = (claim, view) => (claim.on === 'run' ? runCtx : bySeq.get(view.seq));
const idOf = (view) => (view && view.seq != null ? view.seq : 'run');

/* ------------------------------------------------------------------ 1. Contradiction (class A) */

test('contradiction: no event both licenses and contradicts a claim', () => {
  for (const c of CLAIMS.filter((x) => x.contradictedBy)) {
    const viol = [];
    for (const view of viewsFor(c.on)) {
      const ev = eventFor(c, view);
      if (!ev) continue;
      if (c.contradictedBy(ev) && c.licensedBy(view)) viol.push(idOf(view));
    }
    assert.equal(viol.length, 0,
      `claim '${c.id}' lies: shown AND contradicted by the payload on ${viol.length} event(s): ${viol.join(', ')}`);
  }
});

// The teeth: with the pre-Stage-1 projection (deriveSteps without `target`) the attempts claim MUST
// fire — otherwise the contradiction check above is vacuous. RED against the reverted projection.
test('contradiction has teeth: the no-target projection reds the attempts claim', () => {
  const legacy = steps.map((s) => ({ ...s, target: null }));
  const claim = CLAIMS.find((c) => c.id === 'attempts-not-recorded');
  let viol = 0;
  for (const s of legacy) { const ev = bySeq.get(s.seq); if (ev && claim.contradictedBy(ev) && claim.licensedBy(s)) viol++; }
  assert.ok(viol > 0, 'legacy (no-target) projection produced 0 violations — the contradiction check is vacuous');
  assert.equal(viol, 10, `expected 10 failed acts whose attempts list the projection would drop, got ${viol}`);
});

/* ------------------------------------------------------------------ 2. Conditionality (class B) */

test('conditionality: no step/row claim is unconditional (and prose claims render at least once)', () => {
  for (const c of CLAIMS) {
    if (c.on === 'run') continue;                    // single-eval run claim: cannot vary within one run
    const views = viewsFor(c.on);
    const lic = views.filter((v) => c.licensedBy(v)).length;
    assert.notEqual(lic, views.length,
      `claim '${c.id}' is unconditional: licensed on ${lic}/${views.length} rows — a sentence true everywhere has no data behind it`);
    // A lost-field claim is CORRECT at 0% now (that is the fix); a prose claim at 0% can never fire.
    if (!c.contradictedBy) assert.ok(lic > 0, `claim '${c.id}' never renders: licensed on 0/${views.length} rows`);
  }
});

/* ------------------------------------------------------------------ 3. Completeness */

const VIEW_FILES = ['walk-view.mjs', 'pipeline-view.mjs', 'pipeline-shell.mjs', 'row-vocabulary.mjs', 'coverage-view.mjs'].map((f) => path.join(DEBUG, f));

test('completeness: every operator sentence longer than WORD_FLOOR words is registered', () => {
  const reg = registeredTexts();
  const unreg = [];
  for (const file of VIEW_FILES) {
    const src = fs.readFileSync(file, 'utf8');
    for (const { text, words } of scanSentences(src)) {
      if (words <= WORD_FLOOR) continue;
      if (!reg.includes(normalize(text))) unreg.push(`${path.basename(file)}: "${text}" (${words} words)`);
    }
  }
  assert.equal(unreg.length, 0,
    `unregistered operator sentence(s) — declare in claims.mjs CLAIMS or claims-labels.mjs LABELS:\n  ${unreg.join('\n  ')}`);
});

/* ------------------------------------------------------------------ 4. Liveness (class C) */

const evKinds = new Set(events.map((e) => e && e.kind));

// ENFORCED (ADMIN-TRUTH-PLAN Stage 4, row vocabulary): all 13 kinds a real run emits are in
// KIND_STYLE, so no row renders a raw English kind name. Was a `todo` at 24.5% (3 of 13 styled).
test('liveness: KIND_STYLE styles >=90% of the fixture rows', () => {
  const styled = rows.filter((r) => KIND_STYLE[r.kind]).length;
  const pct = Math.round((styled / rows.length) * 1000) / 10;
  assert.ok(pct >= 90, `KIND_STYLE covers ${pct}% of rows (${styled}/${rows.length}); needs >=90%`);
});

// ENFORCED (ADMIN-TRUTH-PLAN Stage 4 — fold the CYCLE, not the row): the pre-existing folds demand
// ADJACENT same-kind rows and something always sits between them, so they fired 0 times on 1092 real
// rows. The natural unit is the page-drain CYCLE — a `drain-outcome` with acts:0 whose window swept
// in no act collapses to one conclusion row (fires 54x on fix1; the golden slice has 1 such barren
// cycle). Was a `todo` at 0 folds; now green through foldZeroActCycles.
// FAIL-ON-REVERT: change foldAll back to `foldIdenticalRuns(foldPipeline(rows))` (drop the cycle fold)
// → this reds ("foldAll produced 0 folds"), because neither surviving fold fires on this trail.
test('liveness: foldAll yields at least one fold', () => {
  const folded = foldAll(rows);
  const folds = folded.filter((r) => (r.count > 1) || r.foldKind === 'repeat' || r.foldKind === 'cycle').length;
  assert.ok(folds >= 1, `foldAll produced ${folds} folds on ${rows.length} rows`);
});

// GREEN: DECISION_KINDS fires 0 times on every trail on disk (no writer stamps such a stage). That
// must be DECLARED unmeasurable, not silently an empty/unfireable Set that reports false confidence.
test('liveness: DECISION_KINDS is measurable or declared unmeasurable', () => {
  const fired = [...DECISION_KINDS].filter((k) => evKinds.has(k));
  assert.ok(fired.length > 0 || UNMEASURABLE_ON_FIXTURE.has('DECISION_KINDS'),
    `DECISION_KINDS fires on 0 kinds and is not declared unmeasurable: {${[...DECISION_KINDS].join(', ')}}`);
});

// GREEN: the walk stub denies the old lie "a visit is not recorded" by naming four kinds — assert
// all four actually occur, so the denial is backed by the trail rather than asserted.
test('liveness: the four visit kinds the walk stub names all occur in the trail', () => {
  const need = ['route', 'route-choice', 'drain-outcome', 'retire'];
  const missing = need.filter((k) => !evKinds.has(k));
  assert.equal(missing.length, 0, `walk stub names ${need.join('/')} as visit records; missing from trail: ${missing.join(', ')}`);
});

/* ------------------------------------------------------------------ 5. Writer-reader parity */

// GREEN reference cases: a field a viewer module reads that IS written on the default path, proven by
// its presence in the default-path golden trail (the fixture is a stateful run).
test('parity: target.attempts (walk-view reads it) is written on the default path', () => {
  const n = events.filter((e) => hasAttempts(e && e.payload)).length;
  assert.ok(n > 0, 'walk-view.attemptsHtml reads target.attempts but 0 events carry it on the default path');
});

test('parity: request status (walk-view reads it) is written on the default path', () => {
  const n = events.filter((e) => finiteStatuses(e && e.payload).length > 0).length;
  assert.ok(n > 0, 'walk-view.requestRowsHtml reads requests[].status but 0 events carry it on the default path');
});

// RED reference case (known drift): route-coverage.mjs reads n.contentSig / graph.notFoundSig for the
// client-404 detector, but only route-frontier.visitRoute writes contentSig and stateful-loop never
// calls visitRoute — so the default-path graph carries notFoundSig and ZERO route contentSig, and the
// detector reports zero on every route. Enforced when the stateful path writes contentSig (and the
// fixture is regenerated to carry it).
test('parity: contentSig has a writer on the default (stateful) path',
  { todo: 'ADMIN-TRUTH-PLAN — stateful-loop never calls visitRoute; client-404 detector dead in default mode (needs a stateful contentSig writer + fixture regen)' }, () => {
    const routes = Object.values(graph.routes || {});
    const withSig = routes.filter((r) => r && r.contentSig).length;
    assert.ok(withSig > 0,
      `contentSig: read by lib/recon/route-coverage.mjs, written on ${withSig} of ${routes.length} routes in the default-path graph (notFoundSig=${graph.notFoundSig}) — dead client-404 detector`);
  });
