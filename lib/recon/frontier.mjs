// Frontier selection for the Phase-1 recon loop ("perceptron loop"). Pure over the
// graph: pick the next small batch of UNEXPLORED element templates — the receptive
// field the step primitive will act on — and report the honest coverage denominator.
//
// The loop's control-flow half lives here; the semantic half (which of the batch is
// worth acting on, what an action meant) is the LLM judge's job, added separately.
// Acting on a template and calling markExplored is the loop-driver's job, not this
// module's — frontier only decides WHAT to look at next.

import { locationKey } from './location-key.mjs';
import { TRANSIENT_BLOCKS, levelOf, probeStatus, answeredTerminally } from './knowledge.mjs';

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

// A template that has NOTHING LEFT TO TEACH stops emitting, even if it has un-acted instances.
// Measured over four runs: ~19% of all acts were repeats on templates already at their terminal knowledge
// level, and the marginal return collapses after the 2nd act on one template — act #3 advances 14%, act #4
// 7%, act #5-and-beyond ZERO (47 acts across two runs, not one level gained). The drain predicate consulted
// EFFORT flags only (explored/unreachable/churned) and never asked the knowledge ladder, so a control we
// fully understand kept being handed out.
// THE TRAP, and it is this project's characteristic one: a template's instances are NOT always the same
// control. Seven authored sections render through one template (see AUTHORED SITES below), and cutting
// those would silently delete real coverage. So the gate is `siteKeyOf` EQUALITY — an instance is written
// off only when an instance of the SAME authored site has already answered — never a raw count.
const terminallyUnderstood = (node, inst) => {
  if (levelOf(node, node.probes || []) !== 'L4') return false;
  const key = siteKeyOf(inst);
  const probed = new Set((node.probes || []).filter((p) => !p.blocked).map((p) => p.instanceKey));
  if (!probed.size) return false;
  // Same authored site as something already probed → nothing new to learn from this one.
  return (node.instances || []).some((other) => probed.has(other.instanceKey) && siteKeyOf(other) === key);
};

// AN ELEMENT WITH AN OUTSTANDING OBLIGATION IS NOT DONE. The battery says what a control owes; until this
// existed, `explored` — set the moment ONE act returned — drained it. So a field that had accepted one
// valid value left the frontier having never been asked what it REFUSES, and the crawl reported it as
// covered. The loop must grind an element until the script says its obligations are discharged; that is
// what turns "we touched 300 controls" into "we understand 300 controls".
// BOUNDED, or a control that cannot answer would be handed out forever: `probeStatus` already parks a
// TERMINALLY blocked obligation in `blocked` (so it stops being outstanding), and MAX_BATTERY_ROWS caps
// the total attempts per element, after which the remainder is honestly owed-but-unreachable rather than
// an infinite loop. The count is of ROWS, not successes, so repeated transient failures still terminate.
const MAX_BATTERY_ROWS = 8;

const batteryOwing = (node) => {
  const rows = (node?.probes || []).filter(Boolean);
  if (rows.length >= MAX_BATTERY_ROWS) return false;
  // A DRIVER THAT DOES NOT RECORD ROWS CANNOT BE OWED THEM. `recordProbe` lives only in stateful-step.mjs,
  // so the plain node loop writes ZERO probe rows — and this predicate then held its fields owing forever:
  // `remaining` never reached 0, `nextBatch` re-emitted the same field on every pass, and the loop stopped
  // on `budget` instead of `frontier-drained` at ANY budget (measured: identical at 6, 12 and 30 steps).
  // An obligation nothing can discharge is not an obligation, it is a spin — the same failure the file's
  // own header warns about, and the reason `retryable` is bounded by MAX_RETRY_ROWS.
  //
  // The discriminator is measured, not assumed: on a stateful run of 403 templates, all 54 explored
  // battery-owing elements carried rows and NOT ONE had zero, so "acted, and the driver recorded nothing"
  // separates the two drivers exactly and costs the recording path nothing.
  if (node?.explored && rows.length === 0) return false;
  // WHICH ELEMENTS CARRY A MULTI-PROBE BATTERY. Only those with a DECLARATION to derive obligations from:
  // `fieldFacts` today, `formFacts` (the incremental-submit ladder) and `actFacts` (declared affordances —
  // aria-haspopup/expanded/pressed, draggable, title) as they land.
  // Opening this to EVERY element is wrong until those exist: `batteryFor` returns `['click']` for a
  // non-field, so an element whose act recorded no row would owe `click` forever and never drain — 7 tests
  // caught exactly that. The gate widens as the vocabulary does, never ahead of it.
  if (!node) return false;
  if (!node.fieldFacts && !node.formFacts && !node.actFacts) return false;
  return probeStatus(node, rows).outstanding.length > 0;
};

// The template-level `explored` flag drains the representative ONLY when it came from the agent path's
// template-level markExplored — NEVER from a sibling instance's act.
//
// WHY THE GUARD. `markInstanceExplored` (graph-store) stamps `inst.explored` AND unconditionally sets
// `node.explored`. So once boundary sampling handed out more than one index, acting on instance 3 set the
// node flag, and this clause then read it as evidence about instance 0 — an instance nobody resolved,
// nobody clicked, and which did not exist in the DOM at all. It was counted `walked`: FABRICATED coverage,
// one fake row per multi-sampled list template. `explored ⟺ observed` is a founding invariant, and this
// was the backdoor through it. Caught by tests/live/churn-feed.test.mjs — the churn signal went silent
// because the drained representative was never enumerated for retirement, and the silence was the symptom.
//
// Any instance-level flag proves the node flag came from a sibling, so the template flag is only trusted
// when no instance carries one of its own.
const templateFlagDrains = (node, i) =>
  i === 0 && node.explored && !(node.instances || []).some((x) => x && x.explored);

// The probe rows that are ABOUT THIS INSTANCE. Scoping matters: "disabled" is a fact about the handle that
// was read, so a disabled row on row 3 says nothing about row 4, and retiring the sibling on it would
// delete real coverage — the same trap `terminallyUnderstood` guards with `siteKeyOf`.
//
// AN UNKEYED ROW COUNTS FOR THE REPRESENTATIVE ONLY (i === 0), exactly as `templateFlagDrains` treats the
// template-level `explored` flag and for the same reason. `recordProbe` writes `instanceKey ?? null`, so an
// act with no resolved instance produces an unkeyed row; letting that row speak for EVERY instance would
// retire siblings the walk never touched, on evidence about a different one. That is the fabricated-
// coverage backdoor this file already documents at `templateFlagDrains` — `explored ⟺ observed` is a
// founding invariant, and a retirement is a drain like any other.
const rowsForInstance = (node, inst, i) =>
  (node.probes || []).filter((p) => p && (p.instanceKey === inst.instanceKey || (p.instanceKey == null && i === 0)));

// A CONTROL THAT ALREADY GAVE A TERMINAL ANSWER LEAVES THE FRONTIER. Measured on runs raw3 and hunt1:
// 30% and 34% of all acts were repeats on a control that had already answered — a disabled field re-clicked
// eight times, a combobox that returned NO_INSTANCE eight times, a link that navigated identically eight
// times. Each is a ONE-TIME finding; re-asking spends the act budget on a question already answered, which
// is a large part of why coverage stalls.
//
// This is checked BEFORE the effort flags and independently of `batteryOwing`, because the whole failure
// was an obligation that could never be discharged keeping a spent control in circulation forever. It is
// NOT a licence to act a control once: `answeredTerminally` retires only on a repeated identical answer or
// an element-scoped refusal, so a form working through its ladder — where every rung is a different probe
// kind, hence a different answer signature — is untouched. See knowledge.mjs for the measurement.
const terminallyAnswered = (node, inst, i) => !!answeredTerminally(node, rowsForInstance(node, inst, i));

const instanceDrained = (node, inst, i) => {
  if (terminallyAnswered(node, inst, i)) return true;
  const drained = inst.explored || inst.unreachable || inst.churned || templateFlagDrains(node, i);
  if (drained && !retryable(node) && !batteryOwing(node)) return true;
  // Terminal understanding drains an instance the walk never touched — that is the point of it: once a
  // template is fully characterised, its remaining same-site instances teach nothing. It must NOT be
  // gated on `drained`, or a template at L4 keeps handing out its untouched siblings forever.
  return terminallyUnderstood(node, inst) && !batteryOwing(node);
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
// a headless-component-library target: one settings page renders seven different sections (`category-general`,
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

// HOW MANY ROWS OF A LIST TO WALK. Walking ONE was an assumption — "fifty rows are one control" — and the
// data refutes it: of the four row templates that ever got two rows probed, TWO behaved differently
// (one row returned server data while another was inert; one changed the page while another did nothing).
// A single representative reports a table as understood on evidence from one row out of fifty.
// Walking all fifty is the other error: on a list that IS homogeneous it buys nothing and, under
// explore-all, every extra row is another real write.
// So: BOUNDARY SAMPLING, the oldest idea in testing — first, middle, last. Rows differ at the edges
// (the newest record, the archived one, the one with empty optional fields), not in the middle of the run.
// And the sample GROWS when the evidence says the rows disagree: once two probed rows of a template have
// produced different verdicts, homogeneity is disproven for that table and it earns a wider sample.
export const ROW_SAMPLE = 3;
const ROW_SAMPLE_DISAGREED = 8;

// Have two probed rows of this template already answered differently?
const rowsDisagree = (node) => {
  const byInst = new Map();
  for (const p of (node.probes || [])) {
    if (p.blocked || !p.instanceKey) continue;
    if (!byInst.has(p.instanceKey)) byInst.set(p.instanceKey, p.verdict);
  }
  return new Set(byInst.values()).size > 1;
};

// First, last, then the middle, then evenly spaced — deterministic, so a resumed run repeats it.
const sampleIndexes = (len, want) => {
  const out = [];
  const push = (i) => { if (i >= 0 && i < len && !out.includes(i)) out.push(i); };
  push(0); push(len - 1); push(Math.floor(len / 2));
  for (let k = 1; out.length < want && k < len; k++) push(Math.floor((k * len) / Math.min(want, len)));
  return out.slice(0, Math.min(want, len)).sort((a, b) => a - b);
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
  // A LIST-ROW template whose rows share one authored key collapsed to a single index above. That is the
  // "fifty rows, one control" assumption, and it is only sometimes true — so sample the boundaries instead
  // of trusting it, and widen once the rows have demonstrably disagreed.
  // NOT ON A CHURNING LIST. A feed whose rows re-render away is exactly where a wider sample cannot
  // terminate: each pass samples rows that vanish before they can be walked, so `remaining` never reaches
  // zero and the crawl spins on a list it can never finish. One representative is the honest answer there,
  // and the churn is already quantified in churnSkipped. Sampling is for STABLE tables — where the rows
  // stay put long enough for the boundaries to mean something.
  // CHURN IS A PROPORTION, NOT A PRESENCE. This read `.some(x => x.churned)`, so ONE vanished row out of
  // twenty-four collapsed the entire template to a single index — permanently, because `churned` is
  // write-once and never cleared. If that surviving index was itself churned, `frontierInstanceStats`
  // peeled it and the template reported ZERO walkable slots while still holding clean, never-tried rows.
  //
  // MEASURED on one run's graph: all four employee-table row templates on /people carried exactly
  // `{churned: 3, clean: 21}` and `probes: 0` — 21 untouched rows each, reported as fully drained. Across
  // the graph, 21 of 24 listRow templates had zero probes while holding 431 instances between them. The
  // mechanism this project credits with first making detail pages reachable had studied nothing, and the
  // frontier counted it complete: the rows were not refused, they were never handed out.
  //
  // The original concern is real and kept — a feed that re-renders faster than it can be walked must not
  // be sampled, or `remaining` never reaches zero. But that is a MOSTLY-churning list, not a list with
  // three stale rows. Threshold, and prefer indexes that are still clean so a churned boundary cannot
  // consume the template's only slot.
  // TERMINATION COMES FROM A BUDGET ON ATTEMPTS, NOT FROM DETECTING CHURN.
  //
  // My first rule counted SURVIVORS (`cleanIdx.length < 2`), and it cannot work: a re-rendering feed MINTS
  // new content-keyed instances every snapshot, so the survivor count grows monotonically and the rule
  // never fires on the exact target class it names. Worse, boundary sampling always includes `len - 1`,
  // which on a growing feed is always the freshest, always-unexplored row — an unbounded act source that
  // stops only when the whole run runs out of budget.
  //
  // Counting ATTEMPTS instead is monotone by construction: every walk of a row ends `explored`,
  // `unreachable` or `churned`, none of which is ever cleared, so `attempted` only rises and the template
  // drains after `want` rows no matter how fast the list re-renders. It also states the intent directly —
  // study a few rows of a table, then move on — which is what the RIA literature recommends and never
  // quantified (CASCON 2012 §5.3: "moves away from these lists once it examines a few items in them
  // rather than exhausting the whole list"). The unexamined rows stay counted in drillSkipped.
  const all = node.instances || [];
  const cleanIdx = all.map((x, i) => (x && x.churned ? -1 : i)).filter((i) => i >= 0);
  const attempted = all.filter((x) => x && (x.explored || x.unreachable || x.churned)).length;
  // Sample over the CLEAN positions, then map back to real indexes, so boundary sampling still means
  // "first / last / middle" of the rows that actually exist.
  const sampleClean = (want) => {
    if (cleanIdx.length <= 1) return sampleIndexes(insts.length, want);
    return sampleIndexes(cleanIdx.length, want).map((i) => cleanIdx[i]);
  };
  // The row budget: widened only once the rows have DEMONSTRABLY disagreed, so a table that behaves
  // uniformly costs three acts and one that does not earns a closer look.
  const rowBudget = rowsDisagree(node) ? ROW_SAMPLE_DISAGREED : ROW_SAMPLE;
  if (node.listRow && !node.opener && insts.length > 1) {
    if (attempted >= rowBudget) return [];        // studied enough rows; the remainder is drillSkipped
    if (out.length <= 1) return sampleClean(rowBudget);
  }
  if (out.length) return out;
  if (node.opener) return insts.slice(0, OPENER_INSTANCE_CAP).map((_, i) => i);
  if (node.listRow && insts.length > 1) {
    return attempted >= ROW_SAMPLE ? [] : sampleClean(ROW_SAMPLE);
  }
  // The single representative. Prefer one that has NOT churned — handing back a vanished instance means
  // the stats peel drops it and the template reports zero walkable slots, which is the "counted complete
  // while untouched" failure in miniature.
  return [cleanIdx.length ? cleanIdx[0] : 0];
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
    // Walkability comes from the ONE selector (walkableIndexes), never re-inlined here. This reader had
    // drifted: nextBatch/navBatch moved to the authored-site split while this kept `opener ? CAP : 1`, so a
    // template with several authored sites reported remaining:0 while nextBatch still yielded work — the
    // terminator's "drained" and the frontier's "here is more" disagreeing, which is the exact bug class
    // tests/CLAUDE.md already guards for the previous occurrence.
    let open = false;
    for (const i of walkableIndexes(node)) {
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
//   - answeredNotExplorable — of the drained instances, how many left because they had given a TERMINAL
//                       answer (an element-scoped refusal, or the same answer twice running) rather than
//                       through ordinary exploration. ADDITIVE disclosure: these are still counted in
//                       walkable and in walked/unreachable, so no total changes — what it adds is that a
//                       retirement is visible as a retirement instead of being indistinguishable from a
//                       control that simply stopped being offered.
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
  let siteRemainder = 0;
  let answeredNotExplorable = 0;
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
    // Walkability from the ONE selector — this reader had drifted from nextBatch/navBatch exactly as
    // frontierStats had. Every cap now derives its remainder from what walkableIndexes ACTUALLY returns,
    // so a slice this reader does not walk is always counted somewhere and never silently dropped.
    const idxs = walkableIndexes(node);
    // CHURN IS QUANTIFIED WHETHER OR NOT IT WAS SAMPLED. The peel below only sees churned instances that
    // made it into `idxs`; now that sampling deliberately prefers clean rows, a churned row would fall
    // through into the drill remainder and be reported as an ordinary un-walked row. It is not — it is a
    // row that vanished, and conflating the two hides exactly the signal churnSkipped exists to carry.
    const idxSet = new Set(idxs);
    const churnedOutside = insts.filter((x, i) => x && x.churned && !idxSet.has(i)).length;
    churnSkipped += churnedOutside;
    const uncounted = Math.max(0, insts.length - idxs.length - churnedOutside);
    if (node.opener) cappedRemainder += uncounted;
    // A non-opener list-row template walks only its representative (instance[0]); the other rows are
    // counted here — honest, never walked. Openers use cappedRemainder instead (their siblings ARE walked
    // up to the CAP), so the two are mutually exclusive.
    else if (node.listRow) drillSkipped += uncounted;
    // AUTHORED SITES: a template split by authored test-id walks one instance per distinct site, bounded
    // by SITE_INSTANCE_CAP. Its leftover had NO bucket at all — the one cap in this file without an
    // accounting line, which is how un-walked instances could vanish from the denominator entirely.
    else siteRemainder += uncounted;
    for (const i of idxs) {
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
      // ANSWERED, NOT EXPLORABLE — counted, never subtracted. A control retired for having given a terminal
      // answer stays inside walkable and is still tallied as walked-or-unreachable exactly as before, so no
      // total moves and the denominator cannot collapse. This is an ADDITIVE disclosure on top: how much of
      // the drained set left because it had nothing further to say, as opposed to being explored normally.
      // Without it the retirement would be invisible, and an invisible retirement is indistinguishable from
      // a control that quietly vanished from the count.
      if (terminallyAnswered(node, inst, i)) answeredNotExplorable++;
      const isUnreach = inst.unreachable || (i === 0 && node.unreachable);
      if (isUnreach) unreachable++; else walked++;
    }
  }
  return {
    walkable, walked, unreachable, remaining: walkable - walked - unreachable, cappedRemainder, drillSkipped, churnSkipped, widgetSkipped, siteRemainder, answeredNotExplorable,
    locations: { discovered: locationSet.size },
  };
}

// Per-template bucket ATTRIBUTION — the drill-down companion to frontierInstanceStats, answering the
// operator's question "почему не нажал остальное" with the CONTROLS in each bucket, not just a count.
// It mirrors frontierInstanceStats EXACTLY — same widget/churn peel, same walkableIndexes, same
// instanceDrained predicate, same emission order — so its per-bucket instance counts sum to the
// frontierInstanceStats totals with zero residue (cross-checked in coverage-screen.test.mjs). It lives
// HERE, beside the rule, on purpose: the policy-declined buckets are the instances walkableIndexes did
// NOT hand out, so identifying them IS the sampling rule — re-deriving it in the viewer is exactly the
// drift class that produced the dead contentSig detector. Read-only, additive: it reuses the identical
// private helpers, never re-implements them, and changes no existing behaviour.
//
// A template can appear in SEVERAL buckets (some instances walked, some genuinely owed, some capped),
// so each entry is {templateId, role, name, route, count} for that template's instances in THAT bucket.
// Bucket keys mirror the count fields: walked / remaining / unreachable / churn(→churnSkipped) plus the
// four policy-declined buckets site(→siteRemainder) / rows(→drillSkipped) / widget(→widgetSkipped) /
// opener(→cappedRemainder).
export function frontierInstanceBuckets(graph) {
  const buckets = { walked: [], remaining: [], unreachable: [], churn: [], site: [], rows: [], widget: [], opener: [] };
  const push = (key, node, tid, count) => {
    if (count > 0) buckets[key].push({ templateId: Number(tid), role: node.role, name: node.name, route: node.route, count });
  };
  for (const id of Object.keys(graph.elements)) {
    const node = graph.elements[id];
    const insts = node.instances || [];
    if (insts.length === 0) continue;
    if (widgetInternal(node)) { push('widget', node, id, insts.length); continue; } // chrome, never surface
    const idxs = walkableIndexes(node);
    const idxSet = new Set(idxs);
    const churnedOutside = insts.filter((x, i) => x && x.churned && !idxSet.has(i)).length;
    const uncounted = Math.max(0, insts.length - idxs.length - churnedOutside);
    // The un-walked remainder → its policy bucket (mutually exclusive, exactly as frontierInstanceStats).
    if (node.opener) push('opener', node, id, uncounted);
    else if (node.listRow) push('rows', node, id, uncounted);
    else push('site', node, id, uncounted);
    let churn = churnedOutside, walked = 0, remaining = 0, unreachable = 0;
    for (const i of idxs) {
      const inst = insts[i];
      if (inst.churned) { churn++; continue; }
      const drained = instanceDrained(node, inst, i);
      if (!drained) { remaining++; continue; }
      const isUnreach = inst.unreachable || (i === 0 && node.unreachable);
      if (isUnreach) unreachable++; else walked++;
    }
    push('walked', node, id, walked);
    push('remaining', node, id, remaining);
    push('unreachable', node, id, unreachable);
    push('churn', node, id, churn);
  }
  return buckets;
}
