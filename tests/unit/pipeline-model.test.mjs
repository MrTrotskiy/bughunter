// The run-pipeline model: every event that consumed wall clock becomes a row, and the rows
// account for ALL of it. Pure over an events array — no browser, no fs — so it is a unit test.
//
// Why it exists: `deriveSteps` filters to the ACT kinds and therefore drops every `route` event.
// On two audited runs that is 663 of 1018 and 538 of 946 events discarded, and navigation is the
// majority of the wall clock too (route gaps measured at 68.6% and 74.9% of total run time; on
// state/runs/probe10 it is 89.9%) — so an act-only view cannot show most of a run.
//
// Guards: derivePipeline keeps route + act + act.failed + UNKNOWN kinds as rows (nothing is
//   dropped); durMs is the gap BEFORE an event and the first row invents nothing; Σ durMs is
//   EXACTLY last.ts - first.ts (conservation — no time silently unattributed); idleMs is the
//   honest unaccounted bucket and is never clamped away; a route's own `totalMs` wins over the
//   sum of its parts; a declared > measured payload is surfaced via overDeclared, not masked;
//   `requested` reports only a DIVERGENCE; and `deriveSteps` is untouched by all of it.
// FAIL-ON-REVERT: filter derivePipeline to `kind === 'act'` (the deriveSteps behaviour) → "every
//   event that consumes wall clock is a row" reds with 2 instead of 5. Give the first row a
//   non-zero durMs, or clamp idleMs to >= 0 without the overDeclared flag → the conservation and
//   overDeclared assertions red.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { derivePipeline, deriveSteps } from '../../lib/debug/scrub-math.mjs';

// 3 route + 2 act, in the shapes the trail actually writes: route events with NO timings (the
// state of 1200 of 1200 route events in existing runs), one route carrying the timings another
// agent is adding, and an act with the {actMs,settleMs,snapMs} block that already ships.
function trail() {
  return [
    { seq: 0, ts: 1000, kind: 'route', payload: { route: '/', total: 78, new: 104 } },
    { seq: 1, ts: 4000, kind: 'act', payload: { templateId: 1, name: 'Save', role: 'button', route: '/', requests: [{ method: 'POST', urlPattern: '/api/save' }], timings: { actMs: 1800, settleMs: 500, snapMs: 200 } } },
    // Aimed at /u, landed on /users. totalMs (4200) deliberately DIFFERS from the sum of the
    // named parts (3500) so the assertion proves totalMs wins rather than coinciding with it.
    { seq: 2, ts: 9000, kind: 'route', payload: { route: '/users', requested: '/u', redirected: true, timings: { gotoMs: 2000, settleMs: 1000, overlayMs: 100, snapMs: 400, totalMs: 4200 } } },
    { seq: 3, ts: 11000, kind: 'act', payload: { templateId: 7, name: 'Next', route: '/users' } },
    { seq: 4, ts: 12000, kind: 'route', payload: { route: '/users/1', requested: '/users/1' } },
  ];
}

test('derivePipeline keeps every wall-clock event; deriveSteps still sees only acts', () => {
  const events = trail();
  const rows = derivePipeline(events);
  // THE lever: an act-only filter returns 2 here. The three route events are 60% of this trail
  // and the majority of its elapsed time — dropping them is the defect being fixed.
  assert.equal(rows.length, 5, 'every event that consumes wall clock is a row — got ' + rows.length);
  assert.deepEqual(rows.map((r) => r.kind), ['route', 'act', 'route', 'act', 'route']);

  // The existing "Прогоны" tab depends on deriveSteps: the sibling must not have disturbed it. This
  // fixture carries NO act.failed, so the act-kind widening is a no-op here — the route events (60% of
  // it) must still be dropped. The act.failed inclusion itself is guarded in scrub-math.test.mjs.
  const steps = deriveSteps(events);
  assert.equal(steps.length, 2, 'deriveSteps still drops route events: one step per act');
  assert.equal(steps[0].templateId, 1);
  assert.equal(steps[1].templateId, 7);
});

test('conservation: the rows account for the whole run, to the millisecond', () => {
  const events = trail();
  const rows = derivePipeline(events);
  const total = rows.reduce((s, r) => s + r.durMs, 0);
  const elapsed = events[events.length - 1].ts - events[0].ts;
  assert.equal(total, elapsed, `Σ durMs must equal last.ts - first.ts — got ${total} vs ${elapsed}`);
  // The first row has no predecessor: 0, never an invented value (which would break the sum).
  assert.equal(rows[0].durMs, 0, 'the first row invents no duration');
  // The gap BEFORE an event is the work that produced it.
  assert.equal(rows[1].durMs, 3000, 'act row carries the 3s gap that preceded it');
  assert.equal(rows[2].durMs, 5000, 'route row carries its own 5s navigation gap');
});

test('idleMs is the honest unaccounted bucket, and totalMs beats the sum of parts', () => {
  const rows = derivePipeline(trail());

  // Act: declared 1800+500+200 = 2500 of a measured 3000 → 500ms nobody explained.
  assert.equal(rows[1].declaredMs, 2500, 'act stages sum to declaredMs');
  assert.equal(rows[1].idleMs, rows[1].durMs - rows[1].declaredMs, 'idleMs === durMs - declaredMs');
  assert.equal(rows[1].idleMs, 500);
  assert.deepEqual(rows[1].stages, [{ name: 'act', ms: 1800 }, { name: 'settle', ms: 500 }, { name: 'snap', ms: 200 }]);

  // Route WITH timings: totalMs (4200) is taken at its word over the 3500 its parts sum to.
  assert.equal(rows[2].declaredMs, 4200, 'a route totalMs wins over the sum of its named parts');
  assert.equal(rows[2].idleMs, 800);
  assert.deepEqual(rows[2].stages.map((s) => s.name), ['goto', 'settle', 'overlay', 'snap'], 'stages render in a stable order');

  // Route WITHOUT timings — today's reality on every route event on disk. The run explains
  // nothing about it, so the whole measured gap is idle. That must render, not be hidden.
  assert.equal(rows[4].declaredMs, 0, 'absent timings declare nothing');
  assert.equal(rows[4].idleMs, rows[4].durMs, 'idleMs === durMs on a row without timings');
  assert.equal(rows[4].idleMs, 1000);
  assert.equal(rows[4].overDeclared, false);
});

test('requested reports a DIVERGENCE only', () => {
  const rows = derivePipeline(trail());
  assert.equal(rows[2].route, '/users', 'route is where it LANDED');
  assert.equal(rows[2].requested, '/u', 'requested is where it was AIMED');
  assert.equal(rows[2].outcome, 'redirected', 'a divergent route reads as a redirect');
  assert.equal(rows[4].requested, null, 'requested === route is not a divergence');
  assert.equal(rows[0].requested, null, 'an absent requested is not a divergence');
});

test('an unknown kind still produces a row, labelled with the raw kind', () => {
  // Kinds the trail already writes beyond route/act: reloc-census, page-terminal, drain-outcome,
  // session-lost, reopen… plus whatever is added next. Dropping one is how a run goes missing.
  const rows = derivePipeline([
    { seq: 0, ts: 100, kind: 'route', payload: { route: '/' } },
    { seq: 1, ts: 400, kind: 'reloc-census', payload: { moved: 3 } },
    { seq: 2, ts: 900, kind: 'act.failed', payload: { templateId: 5, name: 'Create Event', code: 'NO_INSTANCE', message: 'stale' } },
  ]);
  assert.equal(rows.length, 3, 'an unclassifiable kind is still a row');
  assert.equal(rows[1].label, 'reloc-census', 'label falls back to the raw kind');
  assert.equal(rows[1].durMs, 300, 'an unknown kind still carries its wall time');
  assert.equal(rows[2].label, 'act failed Create Event');
  assert.equal(rows[2].outcome, 'NO_INSTANCE', 'a failure code is the row outcome');
  const total = rows.reduce((s, r) => s + r.durMs, 0);
  assert.equal(total, 800, 'conservation holds across unknown kinds too');
});

test('overDeclared surfaces a payload claiming more time than the clock measured', () => {
  // Clock skew or a mis-stamped payload: 500ms declared inside a 100ms gap. Masking it (a
  // negative idle, or a silent clamp with no flag) would hide the defect from the UI.
  const rows = derivePipeline([
    { seq: 0, ts: 0, kind: 'route', payload: { route: '/' } },
    { seq: 1, ts: 100, kind: 'act', payload: { templateId: 1, name: 'Skewed', timings: { actMs: 400, settleMs: 100 } } },
  ]);
  assert.equal(rows[1].durMs, 100, 'measured gap');
  assert.equal(rows[1].declaredMs, 500, 'declared exceeds measured');
  assert.equal(rows[1].idleMs, 0, 'idleMs floors at 0 rather than going negative');
  assert.equal(rows[1].overDeclared, true, 'the skew is FLAGGED, not masked');
});

test('requests is a count, and a malformed trail degrades instead of throwing', () => {
  const rows = derivePipeline(trail());
  assert.equal(rows[1].requests, 1, 'causally-attributed request count');
  assert.equal(rows[3].requests, 0, 'no requests → 0, never undefined');

  assert.deepEqual(derivePipeline(null), [], 'a non-array input yields no rows');
  const junk = derivePipeline([null, { seq: 0, ts: 5, kind: 'route' }, { seq: 1, kind: 'act', payload: {} }]);
  assert.equal(junk.length, 2, 'non-object entries are skipped, real events are kept');
  assert.equal(junk[1].durMs, 0, 'a missing ts yields 0, never NaN');
  assert.ok(junk.every((r) => Number.isFinite(r.durMs)), 'no row carries a NaN duration');
});
