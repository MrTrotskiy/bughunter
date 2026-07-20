// Pure geometry for the admin scrubber — the off-by-one-prone core the viewer depends on.
// No DOM, no browser → unit layer. The page (admin.html) imports the SAME module, so this
// guards the geometry both consume.
//
// Guards: indexFromClientX round-trips dotLeftPct and clamps at both ends (a click past the
//   right edge lands on the LAST dot, not out of range); deriveSteps extracts one step per
//   act in seq order, pairs the observe verdict by templateId, and flags a route change;
//   deriveSteps keeps `act.failed` (the LIVE driver's failure kind) in the walk, reading its
//   `requested`/`message` field names; boxFromRect scales the highlight box DPR-independently
//   from viewport-CSS-px to rendered px.
// FAIL-ON-REVERT: change indexFromClientX's `count-1` to `count` (the classic off-by-one) →
//   the right-edge assertion returns count instead of count-1 → red. Drop the observe pairing
//   in deriveSteps → the "observe folded onto its act" assertion goes red. Narrow the
//   deriveSteps filter back to `e.kind === 'act'` → "a failed act is a step" reds with 2 of 3.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deriveSteps, clampIndex, dotLeftPct, indexFromClientX, boxFromRect, dotClass } from '../../lib/debug/scrub-math.mjs';

test('indexFromClientX is the clamped inverse of dotLeftPct', () => {
  const count = 5; // dots at 0,25,50,75,100 %
  const W = 200, L = 10; // track 200px wide, left edge at x=10
  // Left edge → dot 0; right edge → dot 4 (NOT 5 — the off-by-one this guards).
  assert.equal(indexFromClientX(L, L, W, count), 0, 'left edge → first dot');
  assert.equal(indexFromClientX(L + W, L, W, count), count - 1, 'right edge → last dot');
  // Past either edge clamps in-range.
  assert.equal(indexFromClientX(L - 999, L, W, count), 0, 'far left clamps to 0');
  assert.equal(indexFromClientX(L + W + 999, L, W, count), count - 1, 'far right clamps to last');
  // A click at each dot's own x round-trips back to that dot.
  for (let i = 0; i < count; i++) {
    const x = L + (dotLeftPct(i, count) / 100) * W;
    assert.equal(indexFromClientX(x, L, W, count), i, `dot ${i} round-trips`);
  }
});

test('dotLeftPct spreads N dots edge-to-edge, centers a lone dot', () => {
  assert.equal(dotLeftPct(0, 1), 50, 'single dot centered');
  assert.equal(dotLeftPct(0, 4), 0, 'first dot at left edge');
  assert.equal(dotLeftPct(3, 4), 100, 'last dot at right edge');
  assert.equal(dotLeftPct(1, 5), 25, 'even spacing');
});

test('clampIndex keeps an index in range', () => {
  assert.equal(clampIndex(-3, 5), 0);
  assert.equal(clampIndex(99, 5), 4);
  assert.equal(clampIndex(2.4, 5), 2, 'rounds to nearest');
  assert.equal(clampIndex(NaN, 5), 0, 'non-finite → 0');
});

test('deriveSteps: one step per act, observe folded on, route change flagged', () => {
  const events = [
    { seq: 0, kind: 'route', payload: { route: '/' } },
    { seq: 1, kind: 'frontier.emit', payload: { candidates: [] } },
    { seq: 2, kind: 'act', payload: { templateId: 3, name: 'Save', route: '/', requests: [{ method: 'POST', urlPattern: '/api/save' }] } },
    { seq: 3, kind: 'observe', payload: { templateId: 3, danger: 'safe', effect: 'request', purpose: 'save' } },
    { seq: 4, kind: 'act', payload: { templateId: 7, name: 'Next', route: '/next' } },
  ];
  const steps = deriveSteps(events);
  assert.equal(steps.length, 2, 'only the two acts become steps');
  assert.equal(steps[0].templateId, 3);
  assert.equal(steps[0].observe.danger, 'safe', 'observe verdict folded onto its act');
  assert.deepEqual(steps[0].requests, [{ method: 'POST', urlPattern: '/api/save' }]);
  assert.equal(steps[0].routeStart, true, 'first step starts a route');
  assert.equal(steps[1].routeStart, true, 'route changed / → /next');
  assert.equal(steps[1].observe, null, 'an act with no observe pairs to null');
});

test('deriveSteps: an errored act still becomes a step with no shots', () => {
  const steps = deriveSteps([
    { seq: 0, kind: 'act', payload: { templateId: 1, name: 'Hidden', route: '/', error: 'NOT_VISIBLE', shots: null } },
  ]);
  assert.equal(steps.length, 1);
  assert.equal(steps[0].error, 'NOT_VISIBLE');
  assert.equal(dotClass(steps[0]), 'error', 'errored act dot is tinted error');
});

// The node-loop (recon-run) records a failure as `kind:'act'` with an `error` — the case above. The LIVE
// driver (stateful-step recordFail) records `kind:'act.failed'`, so readActFailed can see the granular
// NO_INSTANCE / NOT_VISIBLE / REVEAL_* codes it filters on. deriveSteps feeds the viewer's "Прогоны" walk,
// which RENDERS failures deliberately (outcomeOf reads `error`; there is blocked/failed styling), so an
// `act`-only filter makes 15% of a run vanish from it: 54 failed acts of 355 in `hygge2`, 56 of 408 in
// `goal1`. The failure payload also uses DIFFERENT field names — `requested` (aimed) not `route` (landed),
// and on the whats-new path only `message` — so both need a fallback or the row lands on a phantom "—"
// page and renders as a blank SUCCESS, which is worse than not rendering at all.
// FAIL-ON-REVERT: narrow the filter to `e.kind === 'act'` → "a failed act is a step" reds with 2 of 3.
test('deriveSteps keeps act.failed — the live driver kind, ~15% of a run', () => {
  const steps = deriveSteps([
    { seq: 0, kind: 'act', payload: { templateId: 1, name: 'Save', role: 'button', route: '/events' } },
    // stateful-step shape: `requested` + `message` + `error`, a before-frame, and attemptMs-only timings.
    { seq: 1, kind: 'act.failed', payload: { templateId: 9, name: 'Create Event', role: 'button', requested: '/events',
      code: 'NO_INSTANCE', message: 'cannot resolve instance #create', error: 'cannot resolve instance #create',
      timings: { attemptMs: 812 }, shots: { before: 'f/9.png', after: null, rect: null, viewport: null } } },
    // whats-new shape: NO `error`, NO route — only code/message. It must not render as a blank success.
    { seq: 2, kind: 'act.failed', payload: { templateId: 12, instance: 'k2', code: 'NOT_VISIBLE', message: 'instance #x is present but not visible' } },
  ]);
  assert.equal(steps.length, 3, 'a failed act is a step: an act-only filter loses 15% of the walk');
  assert.equal(steps[1].templateId, 9);
  assert.equal(steps[1].route, '/events', 'a failed act stamps `requested` (aimed), not `route` (landed)');
  assert.equal(steps[1].routeStart, false, 'the aimed route is the same page — no phantom route separator');
  assert.equal(steps[1].shots.before, 'f/9.png', 'the before-frame survives, so the stage is not blank');
  assert.equal(dotClass(steps[1]), 'error', 'a failed act tints its dot');
  // The viewer keys its outcome card on `error`; the whats-new writer only sets `message`.
  assert.equal(steps[2].error, 'instance #x is present but not visible', 'message backs `error` so the row is not a blank success');
  assert.equal(dotClass(steps[2]), 'error', 'a message-only failure is still tinted, never silently green');
});

test('boxFromRect scales viewport-CSS-px to rendered px, DPR-independent', () => {
  // Shot natural size = viewport * dpr; rendered at half of that. rect is in viewport CSS px.
  const rect = { x: 100, y: 50, width: 40, height: 20 };
  const viewport = { width: 1280, height: 720 };
  // Rendered <img> is 640x360 (half the CSS viewport) regardless of the PNG's pixel size.
  const box = boxFromRect(rect, viewport, 640, 360);
  assert.equal(box.left, 50, '100 * 640/1280');
  assert.equal(box.top, 25, '50 * 360/720');
  assert.equal(box.width, 20);
  assert.equal(box.height, 10);
  assert.equal(boxFromRect(null, viewport, 640, 360), null, 'no rect → no box');
  assert.equal(boxFromRect(rect, { width: 0, height: 0 }, 640, 360), null, 'degenerate viewport → no box');
});
