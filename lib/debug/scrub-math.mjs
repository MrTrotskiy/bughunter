// Pure geometry + step-derivation for the admin scrubber. NO DOM, NO network — so the
// off-by-one-prone bits (index from a click X, dot placement, the rect-box scale) are
// unit-testable under node:test, and the page and the test share ONE source (no drift).
// The viewer (admin.html) imports this as a same-origin module; tests import it directly.

// Turn a run's raw event stream into the ordered STEP list the scrubber walks: one step per ACT —
// `act` AND `act.failed`, the frame-bearing kinds. `act.failed` is ~15% of a real run (54 of 355
// acts in `hygge2`) and the viewer STYLES it (outcomeOf/dotClass), so an `act`-only filter deletes
// every refusal and churn miss. Route and observe events fold onto the step they belong to, never
// their own dots (a frameless dot would scrub to a blank stage); `routeStart` flags a route change.
export function deriveSteps(events) {
  const list = Array.isArray(events) ? events : [];
  const acts = list.filter((e) => e && (e.kind === 'act' || e.kind === 'act.failed'));
  let prevRoute = null;
  return acts.map((e) => {
    const p = e.payload || {};
    // Pair the observe verdict for this template: the first observe with the same templateId
    // at or after this act's seq (agent path writes it right after; recon-run has none → null).
    const observe = list.find((o) => o && o.kind === 'observe'
      && (o.payload || {}).templateId === p.templateId && o.seq >= e.seq) || null;
    // A failed act never LANDED: it stamps `requested` (aimed), not `route` — else it groups under a phantom "—" page.
    const route = p.route || p.requested || '';
    const step = {
      seq: e.seq,
      ts: e.ts,
      templateId: p.templateId,
      name: p.name || '',
      role: p.role || '',
      route,
      requests: p.requests || [],
      revealed: p.revealed || 0,
      external: p.external || null,
      error: p.error || p.message || null, // whats-new's act.failed writes only `message`; the viewer keys on error
      code: p.code || null, // the GRANULAR refusal code; the viewer tones on this, never on message text
      timings: p.timings || null,
      shots: p.shots || null,
      observe: observe ? (observe.payload || {}) : null,
      routeStart: route !== prevRoute,
    };
    prevRoute = route;
    return step;
  });
}

// --- Pipeline model ---------------------------------------------------------------------
// deriveSteps answers "which acts have frames". derivePipeline answers "where did the run's WALL
// CLOCK go" — a different question, so a sibling rather than a change. It keeps EVERY event kind,
// because navigation is the majority of both the event count (663 of 1018 and 538 of 946 events on
// two audited runs) and the elapsed time (route gaps: 68.6% and 74.9% of total run time), and an
// act-only filter discards all of it. Nothing is dropped: an unknown kind still becomes a row with
// the raw kind as its label. Σ durMs is EXACTLY last.ts - first.ts, so no time is unattributed.

// Named timing parts in a stable render order; a payload carries whichever its kind stamps
// (acts: actMs/settleMs/snapMs — routes: gotoMs/settleMs/overlayMs/snapMs/totalMs).
const STAGE_ORDER = ['gotoMs', 'actMs', 'settleMs', 'overlayMs', 'snapMs'];
// Built from a char code so no raw ESC byte lands in the source (a control char in a regex literal
// is invisible in a diff and easy to break on the next edit).
const ANSI_RE = new RegExp(String.fromCharCode(27) + '[[][0-9;]*m', 'g');

// A payload's timings as ordered {name, ms}. Known parts first, then any part a future writer adds
// — an unrecognized stage is rendered late, never dropped (the same rule as an unknown kind).
function stagesOf(timings) {
  if (!timings || typeof timings !== 'object') return [];
  const out = [];
  const push = (k) => { if (Number.isFinite(timings[k])) out.push({ name: k.replace(/Ms$/, ''), ms: timings[k] }); };
  for (const k of STAGE_ORDER) push(k);
  for (const k of Object.keys(timings)) if (k !== 'totalMs' && !STAGE_ORDER.includes(k)) push(k);
  return out;
}

// Time the row EXPLAINS about itself. A route stamping its own `totalMs` is taken at its word (its
// parts may overlap or omit a stage); otherwise the named parts are summed. No timings → 0, so the
// whole measured gap lands honestly in idleMs rather than being quietly attributed.
function declaredOf(timings, stages) {
  if (timings && Number.isFinite(timings.totalMs)) return timings.totalMs;
  return stages.reduce((sum, s) => sum + s.ms, 0);
}

// A Playwright error arrives as a multi-line, ANSI-coloured call log; a row label needs one line.
function firstLine(s) {
  return String(s).replace(ANSI_RE, '').split('\n')[0].trim().slice(0, 120);
}

// Short human-readable row label. Unknown kinds fall back to the raw kind — dropping a kind we do
// not recognize is exactly how 70% of a run went missing the first time.
function labelOf(kind, p) {
  const who = p.name || p.role || (p.templateId != null ? `#${p.templateId}` : '');
  if (kind === 'act') return `act ${who || '?'}`;
  if (kind === 'act.failed') return `act failed ${who || '?'}`;
  if (kind === 'observe') return `observe ${who || '?'}`;
  if (kind === 'route' || kind === 'route.visit') return `route ${p.route || p.requested || '?'}`;
  return kind;
}

// The row's verdict: an explicit code/verdict wins, else a divergent route reads as a redirect.
function outcomeOf(kind, p, requested) {
  const raw = p.code || p.error || p.outcome || p.verdict || null;
  if (raw) return firstLine(raw);
  if (requested && (p.redirected || kind === 'route' || kind === 'route.visit')) return 'redirected';
  return null;
}

// Causally-attributed request count. `requests` is an array on an act; tolerate a bare number.
function requestCountOf(p) {
  if (Array.isArray(p.requests)) return p.requests.length;
  return Number.isFinite(p.requests) ? p.requests : 0;
}

// Every event that consumed wall time, in seq order, as timed pipeline rows. The structure is
// DERIVED from order and payload — no actId/parentId/spanId/phase is read or required, because the
// live driver is one synchronous process and the ts gaps are therefore unambiguous.
export function derivePipeline(events) {
  const list = (Array.isArray(events) ? events : []).filter((e) => e && typeof e === 'object');
  let prevTs = null;
  return list.map((e) => {
    const p = e.payload || {};
    const kind = e.kind || 'unknown';
    const route = p.route != null ? p.route : null;
    // Only a DIVERGENCE is reported: aimed === landed (or absent) reads as null, so the UI shows a
    // requested route only when it differs from where the run actually ended up.
    const requested = (p.requested != null && p.requested !== route) ? p.requested : null;
    const stages = stagesOf(p.timings);
    const declaredMs = declaredOf(p.timings, stages);
    // The gap BEFORE an event is the work that produced it. The first row has no predecessor and
    // gets 0 — inventing a value there would break Σ durMs === last.ts - first.ts. A malformed ts
    // yields 0 rather than NaN, and never advances the cursor.
    const ts = Number.isFinite(e.ts) ? e.ts : null;
    const durMs = (prevTs !== null && ts !== null) ? ts - prevTs : 0;
    if (ts !== null) prevTs = ts;
    // idleMs is the honest "we do not know what happened here" bucket and may be most of the row;
    // it is never clamped away. Declared > measured means a skewed clock or a mis-stamped payload —
    // surfaced as overDeclared rather than masked by a negative or silently-zeroed idle.
    const overDeclared = declaredMs > durMs;
    return {
      seq: e.seq,
      ts: e.ts,
      kind,
      label: labelOf(kind, p),
      route,
      requested,
      durMs,
      declaredMs,
      idleMs: overDeclared ? 0 : durMs - declaredMs,
      overDeclared,
      stages,
      outcome: outcomeOf(kind, p, requested),
      requests: requestCountOf(p),
      // The IDENTITY of the acted control, carried through so a row can name it. `label` alone
      // collapses a nameless control onto its ROLE («клик · button»), which addresses nothing —
      // failure-hints' anchor chain needs the raw fields to fall back to a test-id / id / class /
      // position instead. Every one is copied verbatim or null; nothing here is derived, and an
      // archived run that stamps none of them degrades to `templateId` (which it always has).
      templateId: p.templateId != null ? p.templateId : null,
      name: p.name || '',
      role: p.role || '',
      instanceSelector: p.instanceSelector || (p.target && p.target.selector) || null,
      // The granular refusal code + the resolver's own verdict on whether a reveal path existed —
      // both needed to EXPLAIN the row, and both absent from runs written before they were stamped.
      code: p.code || null,
      target: p.target && typeof p.target === 'object' ? p.target : null,
      error: p.error || p.message || null,
    };
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
