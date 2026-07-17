// Frontier selection for the Phase-1 recon loop ("perceptron loop"). Pure over the
// graph: pick the next small batch of UNEXPLORED element templates — the receptive
// field the step primitive will act on — and report the honest coverage denominator.
//
// The loop's control-flow half lives here; the semantic half (which of the batch is
// worth acting on, what an action meant) is the LLM judge's job, added separately.
// Acting on a template and calling markExplored is the loop-driver's job, not this
// module's — frontier only decides WHAT to look at next.

import { locationKey } from './location-key.mjs';

export const RECEPTIVE_FIELD = 3; // default number of NEW templates studied per step
// Per-opener instance cap: how many instances of a proven OPENER template the frontier will hand
// out (a nav bar of 3, a segmented control of 4). Bounds explosion on a homogeneous 50-row opener
// — after the cap, the rest stay un-enumerated but are NOT hidden: frontierInstanceStats counts
// them in `cappedRemainder` and report surfaces the un-walked remainder (honest coverage).
export const OPENER_INSTANCE_CAP = 8;

// DRILL-per-list discipline (honesty increment): how many rows of a NON-opener list-row template the
// frontier drills. One representative row (instance[0] — already the non-opener nextBatch pick) is walked;
// the other N-1 rows are counted+flagged as `drillSkipped` — the non-opener analog of cappedRemainder
// (counted, flagged, NEVER walked). So a 50-row data list no longer silently contributes only its first
// row to the honest denominator; the remaining 49 are surfaced, not hidden (bounds detail-page blowup,
// the plan §9(d) drill-selection discipline). Not the acted-instance count — nextBatch is unchanged.
export const DRILL_PER_LIST = 1;

// The next up-to-`size` UNEXPLORED element INSTANCES the loop should act on (the receptive field),
// each paired with the instance to act on and its reveal path. Deterministic ascending
// (templateId, instance-index) order so a resumed run continues where it stopped.
//   - instance[0] of every template is eligible (the representative — the pre-state-model behavior).
//   - instances[1..] are eligible ONLY for a proven OPENER (acting an instance revealed new controls
//     on the same route), capped at OPENER_INSTANCE_CAP — so a nav bar of instances-of-one-template
//     gets every entry walked (the rawcaster instance-not-template gap), without a 50-row blowup.
// Backward-compat: instance[0] counts explored if EITHER inst.explored OR the template-level
// node.explored is set (the agent path's template-level markExplored still drains a plain control).
// Shared per-instance drain predicate: an instance leaves the frontier when explored / unreachable /
// churned, or (the representative instance[0]) the template-level explored is set. `inst.churned` (a
// re-rendered-away feed row) drains like explored/unreachable and is never re-handed — a DISTINCT drain
// signal (markInstanceChurned sets churned WITHOUT explored). ONE source so nextBatch and navBatch never
// disagree on what is still walkable.
const instanceDrained = (node, inst, i) => inst.explored || inst.unreachable || inst.churned || (i === 0 && node.explored);

function batchItem(tid, node, inst) {
  return {
    templateId: tid,
    role: node.role,
    name: node.name,
    route: node.route,
    // The reveal path to reach this control behind an in-page action (null for a control present on
    // direct navigation). Instance-level first (the state model), falling back to the template-level
    // annotation for the representative instance. persistentStep replays it.
    reveal: inst.reveal || node.reveal || null,
    navControl: !!node.navControl, // a global-section nav opener → the agent acts it with --opener-replayable
    instance: inst,
    instanceKey: inst.instanceKey,
  };
}

// A deterministic seeded shuffle (mulberry32 over an FNV hash of the seed) so ≥2 BUDGET-CAPPED re-crawls
// explore DIFFERENT subsets of the frontier — the run-to-run variance Chao2 mark-recapture needs (identical
// full drains give Q1=0, a degenerate 100%; GOAL 5). Default (no seed) returns the ascending order UNCHANGED,
// so a normal crawl is byte-identical + resumable; a seed re-permutes reproducibly (same seed → same order).
export function seededOrder(ids, seed) {
  if (seed == null || seed === '') return ids;
  let h = 2166136261 >>> 0;
  for (const ch of String(seed)) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  const rng = () => { h = (h + 0x6D2B79F5) >>> 0; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  const a = ids.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

export function nextBatch(graph, { size = RECEPTIVE_FIELD, seed } = {}) {
  const out = [];
  const ids = seededOrder(Object.keys(graph.elements).map(Number).sort((a, b) => a - b), seed);
  for (const tid of ids) {
    const node = graph.elements[tid];
    if (!node.instances || node.instances.length === 0) continue;
    const limit = node.opener ? Math.min(node.instances.length, OPENER_INSTANCE_CAP) : 1;
    for (let i = 0; i < limit; i++) {
      const inst = node.instances[i];
      if (instanceDrained(node, inst, i)) continue;
      out.push(batchItem(tid, node, inst));
      if (out.length >= size) return out;
    }
  }
  return out;
}

// MENU-EVENT SWEEP priority (event-driven in-app-nav): the still-walkable nav-landmark controls
// (node.navControl, a nav-clickable role) first, in the SAME deterministic (templateId, instance) order
// as nextBatch and sharing its drain predicate. frontier-cli.emit LEADS with this so a constant-URL SPA's
// onClick sections are hydrated (clicked → content swapped in → collected) before the general drain; empty
// (no un-acted nav control) → the caller falls back to nextBatch. Purely REORDERS what nextBatch would
// eventually emit — never adds, hides, or drains a control, so the honest denominator is untouched.
const NAV_ROLES = new Set(['link', 'button', 'tab', 'menuitem']);
export function navBatch(graph, { size = RECEPTIVE_FIELD, seed } = {}) {
  const out = [];
  const ids = seededOrder(Object.keys(graph.elements).map(Number).sort((a, b) => a - b), seed);
  for (const tid of ids) {
    const node = graph.elements[tid];
    if (!node.navControl || !NAV_ROLES.has(node.role)) continue;
    if (!node.instances || node.instances.length === 0) continue;
    const limit = node.opener ? Math.min(node.instances.length, OPENER_INSTANCE_CAP) : 1;
    for (let i = 0; i < limit; i++) {
      const inst = node.instances[i];
      if (instanceDrained(node, inst, i)) continue;
      out.push(batchItem(tid, node, inst));
      if (out.length >= size) return out;
    }
  }
  return out;
}

// Honest, non-collapsing denominator over discovered templates. `discovered` counts
// every template ever seen and never shrinks. A template that was drained but never
// genuinely reached (`node.unreachable`, e.g. cold-start could not resolve it) is
// counted in `unreachable`, NOT in `explored` — so `explored` reflects real coverage,
// never inflated by the error path. `remaining` = still in the frontier (not yet
// drained). Termination is driven by nextBatch returning [], not by remaining == 0.
export function frontierStats(graph) {
  const ids = Object.keys(graph.elements);
  let exploredFlag = 0;
  let unreachable = 0;
  for (const id of ids) {
    const node = graph.elements[id];
    if (node.explored) exploredFlag++;
    if (node.unreachable) unreachable++;
  }
  const discovered = ids.length;
  return {
    discovered,
    explored: exploredFlag - unreachable,
    unreachable,
    remaining: discovered - exploredFlag,
    // Routes reached and SNAPSHOTTED so far (grows as nav acts / the route-frontier discover new
    // pages, never shrinks). Counts only VISITED nodes — a route the frontier discovered but has not
    // visited carries `pending`, and a 404/redirect route carries `unreachable`; NEITHER is "mapped"
    // (else the coverage line fabricates pages and contradicts routeFrontierStats). Single page → 1.
    routes: graph.routes ? Object.values(graph.routes).filter((r) => !r.pending && !r.unreachable).length : 0,
  };
}

// Instance-level honesty companion to frontierStats (review follow-up). frontierStats is
// TEMPLATE-count only, so once an opener's representative is explored the template reads as done
// even though nextBatch still yields the opener's un-walked SIBLINGS, and instances beyond
// OPENER_INSTANCE_CAP are enumerated by nobody. This reports the honest INSTANCE-level frontier the
// state model actually walks, so the report/admin number never claims "done" while work remains:
//   - walkable        — instances the frontier will hand out (1 per plain template; up to the CAP per opener)
//   - walked          — of those, genuinely explored (drained AND not flagged unreachable)
//   - unreachable     — of those, drained-but-not-reached (reveal replay failed / not-visible)
//   - remaining       — walkable not yet drained (matches nextBatch still having work; NOT template `remaining`)
//   - cappedRemainder — opener instances BEYOND the CAP, never enumerated: counted here so the
//                       un-walked remainder is flagged, never silently hidden.
//   - drillSkipped    — non-opener LIST-ROW rows beyond the drilled representative (N - DRILL_PER_LIST):
//                       a 50-row data list walks one row and counts the other 49 here, so the rest are
//                       flagged (counted, never walked), never vanishing from the honest denominator.
//   - churnSkipped    — feed rows that RE-RENDERED AWAY (markInstanceChurned). A re-rendering feed WITHOUT
//                       stable data-ids mints a NEW content-keyed instanceKey each render, so an unexplored
//                       representative that vanished before it was walked would else sit in `walkable`
//                       forever and keep `remaining` above 0 — the honest terminator could never declare
//                       DRAINED on a live feed. Such vanished rows are PEELED out of walkable/remaining and
//                       QUANTIFIED here. Mirrors drillSkipped (counted, flagged, never walked) but for
//                       VANISHED (re-rendered-away) rows, not static overflow.
// Drain/unreached predicates MIRROR nextBatch exactly (an instance is emittable iff not drained), so
// `remaining === 0` here is a true "no instance left to hand out", unlike template `remaining`.
export function frontierInstanceStats(graph) {
  let walkable = 0;
  let walked = 0;
  let unreachable = 0;
  let cappedRemainder = 0;
  let drillSkipped = 0;
  let churnSkipped = 0;
  // The honest "how many locations did we discover" number a single-URL SPA otherwise hides under
  // one routeKey. Every instance sits at locationKey(route, its reveal.statePath); a control with no
  // reveal is at its route's ROOT location. Counted over ALL instances (not just the capped walkable
  // slice) so a discovered section is never dropped. Derived from already-captured reveal paths — a
  // REPORTING hint, never identity, so it adds ZERO id/edge churn (see location-key.mjs).
  const locationSet = new Set();
  for (const id of Object.keys(graph.elements)) {
    const node = graph.elements[id];
    const insts = node.instances || [];
    if (insts.length === 0) continue;
    for (const inst of insts) locationSet.add(locationKey(node.route, inst.reveal?.statePath || []));
    const limit = node.opener ? Math.min(insts.length, OPENER_INSTANCE_CAP) : 1;
    if (node.opener) cappedRemainder += Math.max(0, insts.length - OPENER_INSTANCE_CAP);
    // A non-opener list-row template walks only its representative (instance[0], limit=1 below, so
    // walkable += DRILL_PER_LIST); the other rows are counted here — honest, never walked. Openers use
    // cappedRemainder instead (their siblings ARE walked up to the CAP), so the two are mutually exclusive.
    else if (node.listRow) drillSkipped += Math.max(0, insts.length - DRILL_PER_LIST);
    for (let i = 0; i < limit; i++) {
      const inst = insts[i];
      // PEEL churn BEFORE walkable++: a re-rendered-away feed row (markInstanceChurned) is QUANTIFIED in
      // churnSkipped and kept OUT of walkable/walked/unreachable/remaining. This is the whole fix — because
      // churned instances never enter `walkable`, `remaining = walkable − walked − unreachable` can reach 0
      // on the STABLE control set even while a live feed keeps churning (its churn is counted, never hidden).
      if (inst.churned) { churnSkipped++; continue; }
      walkable++;
      // Same eligibility nextBatch uses: instance[0] also drains on the template-level flag (the
      // agent path's markExplored / markUnreachable set node.*, kept in parity with the node loop).
      const drained = inst.explored || inst.unreachable || (i === 0 && node.explored);
      if (!drained) continue;
      const isUnreach = inst.unreachable || (i === 0 && node.unreachable);
      if (isUnreach) unreachable++; else walked++;
    }
  }
  return {
    walkable, walked, unreachable, remaining: walkable - walked - unreachable, cappedRemainder, drillSkipped, churnSkipped,
    locations: { discovered: locationSet.size },
  };
}
