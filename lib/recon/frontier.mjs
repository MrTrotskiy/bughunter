// Frontier selection for the Phase-1 recon loop ("perceptron loop"). Pure over the
// graph: pick the next small batch of UNEXPLORED element templates — the receptive
// field the step primitive will act on — and report the honest coverage denominator.
//
// The loop's control-flow half lives here; the semantic half (which of the batch is
// worth acting on, what an action meant) is the LLM judge's job, added separately.
// Acting on a template and calling markExplored is the loop-driver's job, not this
// module's — frontier only decides WHAT to look at next.

import { locationKey } from './location-key.mjs';
import { TRANSIENT_BLOCKS } from './knowledge.mjs';

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
//     gets every entry walked (the first target's instance-not-template gap), without a 50-row blowup.
// Backward-compat: instance[0] counts explored if EITHER inst.explored OR the template-level
// node.explored is set (the agent path's template-level markExplored still drains a plain control).
// Shared per-instance drain predicate: an instance leaves the frontier when explored / unreachable /
// churned, or (the representative instance[0]) the template-level explored is set. `inst.churned` (a
// re-rendered-away feed row) drains like explored/unreachable and is never re-handed — a DISTINCT drain
// signal (markInstanceChurned sets churned WITHOUT explored). ONE source so nextBatch and navBatch never
// disagree on what is still walkable.
//
// RETRY WHAT WE NEVER MANAGED TO ASK. An act that threw, resolved onto another instance's node, or found
// its container gone still marks the instance explored — so the element left the frontier having taught us
// nothing, and could never be handed out again. Measured in run probe8: 15 elements sat at L1 REACHED whose
// every recorded row was a transient block, permanently, because one failed attempt retired them.
// `retryable` re-opens exactly that case: every row blocked, every block transient. An element that
// genuinely answered — or that is terminally blocked by policy or by a fact about itself — stays drained,
// so this cannot become an infinite re-walk. The attempt cap lives in the caller's act budget.
// Bound the re-walk: an element whose acts keep failing is honestly unreachable, and re-handing it forever
// would spend the budget on the one thing that never works.
const MAX_RETRY_ROWS = 3;

const retryable = (node) => {
  const rows = (node?.probes || []).filter(Boolean);
  if (!rows.length || rows.length >= MAX_RETRY_ROWS) return false;
  return rows.every((p) => p.blocked && TRANSIENT_BLOCKS.has(p.blocked));
};

const instanceDrained = (node, inst, i) => {
  const drained = inst.explored || inst.unreachable || inst.churned || (i === 0 && node.explored);
  return drained && !retryable(node);
};

// Shared widget-chrome predicate — the SECOND thing that must be one source, for the same reason as
// instanceDrained. A framework widget's popup panel (date picker switchers, select option list) is chrome,
// not application surface (widget-popup.mjs explains the discriminator and why portal MENUS are exempt).
//
// It must be consulted by ALL FOUR readers of walkability — nextBatch, navBatch, frontierStats and
// frontierInstanceStats — or the terminator breaks: excluded from emission but still counted open,
// `remaining` never reaches 0 and the controller reports a phantom stall. That exact bug is already on
// record in this file. Chrome is NOT marked explored (it was never observed); it leaves via its own
// counted bucket, the same shape as churned.
const widgetInternal = (node) => node.widgetInternal === true;

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

// AUTHORED SITES within one template. A template is a STRUCTURAL class — "everything that renders through
// this CSS path" — and on a component library that is not the same thing as "the same control". Measured on
// a shadcn/Radix target: `/settings` renders seven different sections (`settings-category-general`,
// `-access_control`, `-absences`, `-ai`, …) through ONE template, because every `<Button>` there produces an
// identical path. The old limit walked instance[0] and filed the other six under `drillSkipped`, whose
// comment promises "the other rows of one list" — here they were six different sections of the application,
// counted as covered-by-representative and never opened.
//
// The AUTHOR already answered this: a distinct `data-testid` is a distinct control, a shared prefix
// (`employee-row-${id}`) is one control with many rows. So walk one instance per distinct authored site,
// and fall back to today's single representative when the author told us nothing.
//
// Bounded by SITE_INSTANCE_CAP for the same reason OPENER_INSTANCE_CAP exists — and it matters more here,
// because in explore-all every extra instance walked is an extra real write to the operator's stand.
export const SITE_INSTANCE_CAP = 8;

// The author's identity for an instance: the testid with any per-row suffix stemmed off, so `project-row-7`
// and `project-row-8` collapse while `settings-category-ai` and `-absences` stay apart.
const siteKeyOf = (inst) => {
  const id = inst && inst.testid;
  if (!id) return null;
  // Trailing content keys — uuid, digit run, or a hex-ish blob — are ROW identity, not control identity.
  // Strip a RUN of trailing content keys. `inventory-add-asset-trigger-<uuid>-<uuid>` keeps its first uuid
  // under a single-strip rule and still reads as 8 distinct controls.
  let out = String(id);
  for (let i = 0; i < 4; i++) {
    const next = out.replace(/[-_](?:[0-9a-f]{8}-[0-9a-f-]{4,}|\d+|[0-9a-f]{12,})$/i, '');
    if (next === out) break;
    out = next;
  }
  return out;
};

// The instances worth walking for this template: one per authored site, else the single representative.
// Returns INDEXES so the caller keeps using instanceDrained's positional contract unchanged.
function walkableIndexes(node) {
  const insts = node.instances || [];
  // THE AUTHORED KEY APPLIES TO OPENERS TOO. The first version returned here before `siteKeyOf` was ever
  // consulted, so a template that is BOTH `opener` and `listRow` walked its first 8 ROWS as if they were 8
  // different controls. Measured: 64 of 355 acts in one run were exactly that — 8 acts on "Add Laptop", 8
  // on one asset row — and cutting them loses ZERO distinct endpoints. It also produced the open-close
  // oscillation in the trail, 13 acts opening and closing one dialog on 8 different rows.
  const cap = node.opener ? OPENER_INSTANCE_CAP : SITE_INSTANCE_CAP;
  const seen = new Set();
  const out = [];
  for (let i = 0; i < insts.length && out.length < cap; i++) {
    const key = siteKeyOf(insts[i]);
    if (!key) continue;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(i);
  }
  // No authored ids at all — a target with no test attributes, which is most of them. Unchanged behaviour:
  // an opener walks its instances up to the cap, anything else walks one representative. The mechanism must
  // never make an unmarked application WORSE than it is today.
  if (out.length) return out;
  return node.opener ? insts.slice(0, OPENER_INSTANCE_CAP).map((_, i) => i) : [0];
}

export function nextBatch(graph, { size = RECEPTIVE_FIELD, seed } = {}) {
  const out = [];
  const ids = seededOrder(Object.keys(graph.elements).map(Number).sort((a, b) => a - b), seed);
  for (const tid of ids) {
    const node = graph.elements[tid];
    if (widgetInternal(node)) continue;                     // widget chrome is never a coverage obligation
    if (!node.instances || node.instances.length === 0) continue;
    for (const i of walkableIndexes(node)) {
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
    if (widgetInternal(node)) continue;                     // same peel as nextBatch — one source, no disagreement
    if (!node.instances || node.instances.length === 0) continue;
    for (const i of walkableIndexes(node)) {
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
  // `remaining` must mean "work the frontier will actually hand out", so it is computed the SAME way
  // nextBatch decides: a template is done when EVERY instance it would emit is drained. The old
  // `discovered - exploredFlag` counted the template-level flag only, so a template whose instances were
  // all walked instance-level (the normal path for openers and multi-instance controls) still read as
  // remaining forever. Measured live: the controller reported "stalled, 27 controls remain" while the
  // frontier was genuinely EMPTY — 27 templates lacked the flag but had zero walkable instances left.
  // That mismatch turned an honest DRAIN into a fake stall and burned rounds on fruitless navigation.
  let openTemplates = 0;
  for (const id of ids) {
    const node = graph.elements[id];
    const insts = node.instances || [];
    if (widgetInternal(node)) continue;                     // not emitted, so it must not be counted open
    if (insts.length === 0) continue;                       // nothing addressable → never handed out
    const limit = node.opener ? Math.min(insts.length, OPENER_INSTANCE_CAP) : 1;
    let open = false;
    for (let i = 0; i < limit; i++) {
      const inst = insts[i];
      if (!instanceDrained(node, inst, i)) { open = true; break; }
    }
    if (open) openTemplates++;
  }
  return {
    discovered,
    explored: exploredFlag - unreachable,
    unreachable,
    remaining: openTemplates,
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
  let widgetSkipped = 0;
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
    // PEEL widget chrome BEFORE walkable++, the same shape as churn below: a framework widget's popup
    // panel is not application surface, so it is QUANTIFIED in widgetSkipped and kept out of
    // walkable/walked/unreachable/remaining. It must be peeled in every reader — nextBatch and navBatch
    // no longer emit it, so counting it open here would leave `remaining` permanently above 0 and the
    // controller would report a stall against a frontier that is genuinely empty.
    if (widgetInternal(node)) { widgetSkipped += insts.length; continue; }
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
      const drained = instanceDrained(node, inst, i);
      if (!drained) continue;
      const isUnreach = inst.unreachable || (i === 0 && node.unreachable);
      if (isUnreach) unreachable++; else walked++;
    }
  }
  return {
    walkable, walked, unreachable, remaining: walkable - walked - unreachable, cappedRemainder, drillSkipped, churnSkipped, widgetSkipped,
    locations: { discovered: locationSet.size },
  };
}
