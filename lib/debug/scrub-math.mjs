// Pure geometry + step-derivation for the admin scrubber. NO DOM, NO network — so the
// off-by-one-prone bits (index from a click X, dot placement, the rect-box scale) are
// unit-testable under node:test, and the page and the test share ONE source (no drift).
// The viewer (admin.html) imports this as a same-origin module; tests import it directly.

// Turn a run's raw event stream into the ordered STEP list the scrubber walks: one step per
// `act` event (the only frame-bearing kind — each act has a before/after screenshot). Route
// and observe events are folded onto the step they belong to, never their own dots (a
// frameless dot would scrub to a blank stage). Each step is tagged `routeStart` when its
// route differs from the previous step's, so the strip can draw a route separator.
export function deriveSteps(events) {
  const list = Array.isArray(events) ? events : [];
  const acts = list.filter((e) => e && e.kind === 'act');
  let prevRoute = null;
  return acts.map((e) => {
    const p = e.payload || {};
    // Pair the observe verdict for this template: the first observe with the same templateId
    // at or after this act's seq (agent path writes it right after; recon-run has none → null).
    const observe = list.find((o) => o && o.kind === 'observe'
      && (o.payload || {}).templateId === p.templateId && o.seq >= e.seq) || null;
    const step = {
      seq: e.seq,
      ts: e.ts,
      templateId: p.templateId,
      name: p.name || '',
      role: p.role || '',
      route: p.route || '',
      requests: p.requests || [],
      revealed: p.revealed || 0,
      external: p.external || null,
      error: p.error || null,
      timings: p.timings || null,
      shots: p.shots || null,
      observe: observe ? (observe.payload || {}) : null,
      routeStart: p.route !== prevRoute,
    };
    prevRoute = p.route;
    return step;
  });
}

// Clamp an index into [0, count-1] (empty → 0).
export function clampIndex(i, count) {
  if (!Number.isFinite(i)) return 0;
  const max = Math.max(0, count - 1);
  return Math.max(0, Math.min(Math.round(i), max));
}

// Left offset (percent 0..100) of dot i on the track. A single dot sits centered (50%) so it
// is not pinned to the left edge; N dots spread edge-to-edge so the first/last are reachable.
export function dotLeftPct(i, count) {
  if (count <= 1) return 50;
  return (clampIndex(i, count) / (count - 1)) * 100;
}

// Map a pointer's clientX to the nearest dot index. rectLeft/rectWidth come from the track
// element's bounding box. Inverse of dotLeftPct; rounds to the nearest dot so a click between
// two dots lands on the closer one.
export function indexFromClientX(clientX, rectLeft, rectWidth, count) {
  if (count <= 1 || !(rectWidth > 0)) return 0;
  const frac = (clientX - rectLeft) / rectWidth;
  return clampIndex(frac * (count - 1), count);
}

// The rect highlight box, in RENDERED image pixels, DPR-independent: the before-frame shot
// covers exactly the CSS viewport box (scaled by devicePixelRatio), so a viewport-CSS-px rect
// maps onto the rendered <img> as rect.x * imgClientW / viewport.width. Returns null when the
// rect or viewport is missing/degenerate (no box drawn).
export function boxFromRect(rect, viewport, imgClientW, imgClientH) {
  if (!rect || !viewport || !(viewport.width > 0) || !(viewport.height > 0)) return null;
  if (!(imgClientW > 0) || !(imgClientH > 0)) return null;
  const sx = imgClientW / viewport.width;
  const sy = imgClientH / viewport.height;
  return {
    left: rect.x * sx,
    top: rect.y * sy,
    width: rect.width * sx,
    height: rect.height * sy,
  };
}

// A compact tint class for a step's dot: an errored act is 'error', an act on a floored
// (destructive/auth/payment) control is 'danger', else '' (default accent). Drives CSS only.
export function dotClass(step) {
  if (!step) return '';
  if (step.error) return 'error';
  const d = step.observe && step.observe.danger;
  if (d === 'destructive' || d === 'auth' || d === 'payment') return 'danger';
  return '';
}
