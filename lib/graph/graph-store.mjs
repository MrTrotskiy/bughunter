// Read/write state/graph.json. Node types:
//   route    — { type:'route', url }
//   element  — template-level: { templateId, templateSelector, role, name, route,
//              explored, instances:[{ instanceId, instanceKey, instanceSelector }] }
//              `explored` = the recon loop has already acted on this control.
//   request  — { method, urlPattern } where urlPattern masks query values and
//              numeric/uuid path segments to :param. Optional response metadata:
//              statuses {"<code>":count} histogram + resourceType (last-seen scalar).
// Edge: element --triggers--> request, provenance:"causal".

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';

// Identity-scheme version. Bumped whenever the element IDENTITY model changes (the selector
// keys minted in ids.mjs) — INC.1 (2026-07-15, =2) tightened isGeneratedId so framework-noise
// ids stop anchoring selectors; INC.2 (2026-07-18, =3) folds a portal menuitem's action NAME into
// its TEMPLATE selector (dom-snapshot templateSelectorOf) so body-portal dropdown items stop
// collapsing onto one template. A graph minted under a DIFFERENT scheme must NOT co-mingle with
// current-scheme ids (a scheme-2 positional menuitem `#N` beside a scheme-3 name-folded one), so
// loadGraph resets on a mismatch. Bump this on any identity change.
// 4 (INC.4): transient CSS-motion classes (`ant-slide-up-leave`, `ant-zoom-appear`, …) are no longer
// admitted as selector anchors (dom-snapshot.isMotionClass). That is an INTENTIONAL identity re-key — the
// same class of change as INC.1's framework-id rejection — so a scheme-3 graph MUST be reset rather than
// co-mingled: its animation-anchored templateSelectors would never match a scheme-4 snapshot, leaving
// permanent phantom duplicates in the denominator.
// INC.6: interaction-state classes no longer anchor selectors, `[tabindex="-1"]` overlay wrappers are no
// longer collected, and — the reason the bump is REQUIRED rather than merely tidy — reveal paths are
// written under new invariants (no dismiss hop, no repeated template). Reveal paths are recorded
// first-reveal-wins with NO invalidation (fillRevealIfHidden / mergeSnapshot below both fill-if-absent),
// so the 494 paths already on disk — 493 of them stateful provenance, 39 cyclic, 22 routed through a
// "cancel" — would survive every fix above and keep being consumed. The version bump IS the invalidation.
export const SCHEMA_VERSION = 6;

export function makeGraph() {
  return { schemaVersion: SCHEMA_VERSION, routes: {}, elements: {}, requests: {}, edges: [] };
}

// url path with query values and numeric/uuid path segments masked to :param, e.g.
// /api/search?q=hello -> /api/search?q=:param ; /api/item/42 -> /api/item/:param.
export function toUrlPattern(url) {
  let u;
  try { u = new URL(url, 'http://x'); } catch { return String(url); }
  const path = u.pathname.split('/').map((s) => {
    if (!s) return s;
    if (/^\d+$/.test(s)) return ':param';
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)) return ':param';
    if (/^[0-9a-f]{16,}$/i.test(s)) return ':param';
    return s;
  }).join('/');
  const keys = Array.from(u.searchParams.keys());
  return keys.length ? `${path}?${keys.map((k) => `${k}=:param`).join('&')}` : path;
}

const reqKey = (method, urlPattern) => `${String(method).toUpperCase()} ${urlPattern}`;

// Structural match of a CONCRETE route to a declared `:param` pattern node (GOAL 2 param-instance harvest).
// toUrlPattern masks only digit/uuid/hex segments, so a STRING-keyed param (`/user/:handle` → `/user/alice`)
// would never reconcile by pattern equality — instead align by SEGMENT STRUCTURE: same segment count, every
// pattern `:name` segment matches ANY concrete segment, literal segments must be equal. Returns the pattern
// node's url (its graph.routes key) or null. The concrete must itself be non-pattern (carry no `:` segment).
export function matchParamPattern(graph, concreteRoute) {
  const routes = graph.routes || {};
  const cSegs = String(concreteRoute).split('?')[0].split('/').filter(Boolean);
  if (!cSegs.length || cSegs.some((s) => s.startsWith(':'))) return null;
  // MOST-LITERALS-FIRST: among same-arity patterns that match, prefer the one with the MOST literal
  // segments (the most SPECIFIC pattern), so a concrete never gets credited to a bare `/:a/:b` catch-all
  // when a `/user/:handle` also matches. Deterministic tie-break beyond that is insertion order.
  let best = null; let bestLiterals = -1;
  for (const node of Object.values(routes)) {
    if (node.unreachable !== 'param-pattern') continue;
    const pSegs = String(node.url).split('?')[0].split('/').filter(Boolean);
    if (pSegs.length !== cSegs.length || !pSegs.some((s) => s.startsWith(':'))) continue;
    let ok = true; let literals = 0;
    for (let i = 0; i < pSegs.length; i++) {
      if (pSegs[i].startsWith(':')) continue;               // a param slot matches any concrete segment
      if (pSegs[i] !== cSegs[i]) { ok = false; break; }     // a literal segment must be equal
      literals++;
    }
    if (ok && literals > bestLiterals) { best = node.url; bestLiterals = literals; }
  }
  return best;
}

// Link a genuinely-visited CONCRETE route to the declared `:param` pattern it instantiates — ADDITIVE
// reporting metadata (`paramInstanceOf`), NEVER an identity input (route identity stays routeKey). route-
// coverage then counts the PATTERN collected via this representative and excludes the concrete from the
// static section count. A route that is ITS OWN declared manifest section (`node.declared === true`) is
// NEVER a param proxy — a declared static (`/user/settings` beside `/user/:handle`, or any static under a
// `/:slug` catch-all) must stay its own section, else it would vanish from the denominator and fabricate
// pattern coverage (bughunter review MUST FIX, invariant #3). A no-op if the node is absent, already tagged,
// is itself a pattern, is a declared section, or matches no declared pattern. Returns the linked url or null.
export function tagParamInstance(graph, concreteRoute) {
  const node = graph.routes && graph.routes[concreteRoute];
  if (!node || node.paramInstanceOf || node.unreachable === 'param-pattern' || node.declared === true) return null;
  const pattern = matchParamPattern(graph, concreteRoute);
  if (pattern && pattern !== concreteRoute) { node.paramInstanceOf = pattern; return pattern; }
  return null;
}

// Upsert every element (template + instance) into the graph. Returns what was NEW:
// newTemplates (unseen templateId) and newInstances (unseen instanceKey under a
// template). Elements must already carry templateId/instanceId (minted via ids.mjs).
// opts.revealPath (GAP 2, optional): the ordered in-page path that revealed these controls
// — stamped as node.reveal on NEWLY-created templates only (see below).
// opts.stateful (optional, additive): when true, the reveal is a stateful-mode PROVENANCE breadcrumb
// (location honesty) rather than a replayable stateless path — stamped as `stateful:true` on every
// reveal this merge writes (new template, new instance, and the fill-if-absent path) so a downstream
// consumer distinguishes a provenance path from a replayable one. Absent/false → no `stateful` key
// (the stateless path is byte-for-byte unchanged).
// Fill-if-absent reveal for a baseline-hidden control (state model "panel reach"): a control
// discovered HIDDEN and PATHLESS at baseline that a STAMPED opener act just made VISIBLE acquires
// the opener's reveal path and is REOPENED so the frontier re-emits it and reaches it via replay.
// Gates (ALL required):
//   - !inst.reveal        — first-reveal-wins (never overwrite an existing path).
//   - inst.hiddenWhenSeen — provenance: never observed directly reachable (ordering-robust).
//   - el.visible === true — THIS act made it visible (attributes the reveal to the correct opener).
//   - NOT (explored && !unreachable) — never reset GENUINE coverage: a control that appeared by its
//     own means (deferred/animated) and was genuinely acted (explored, not unreachable) keeps its
//     real coverage + null reveal; only a NOT_VISIBLE-drained (explored+unreachable) or not-yet-acted
//     control is eligible. Without this, an unrelated opener could discard a real act and stamp a
//     bogus reveal path (the Phase-2 input) that first-reveal-wins then locks in.
// REOPEN clears the drain flags (reconLoop marks EVERY act explored, even a NOT_VISIBLE fail, and
// markInstanceExplored also sets node.explored) so the frontier genuinely re-emits; the template-level
// flags are cleared iff this is the representative instance (they track instance[0]). Mutates node/inst,
// returns whether it filled. Honest: a hidden control is only ever drained by NOT_VISIBLE, never
// genuinely acted, so nothing real is un-counted.
// The additive `stateful` marker (opts.stateful, threaded from mergeSnapshot) records that the reveal is
// a stateful-mode PROVENANCE breadcrumb rather than a replayable stateless path — see mergeSnapshot.
function fillRevealIfHidden(node, inst, el, route, revealPath, stateful, preVisible) {
  if (inst.reveal || el.visible !== true) return false;
  // REVEAL PROVENANCE (Fable design, low-risk targeted fix): the correct "THIS opener revealed it" signal
  // is the PER-ACT hidden→visible transition, not the write-once `hiddenWhenSeen`. A PORTAL dropdown menuitem
  // MOUNTS on open — it is never in the DOM while hidden, so `hiddenWhenSeen` (el.visible===false at first
  // capture) is STRUCTURALLY always false for it and it can never acquire a reveal path → NO_INSTANCE on cold
  // replay (the live target in-app-state gap). `preVisible` is the set of controls visible IMMEDIATELY
  // BEFORE this act (captured under __idle__ in actStep); a control NOT in it but visible now was revealed by
  // this act. `preVisible` is threaded for EVERY actStep caller (whats-new, persistentStep, statefulStep all
  // pass a revealPath), so the `hiddenWhenSeen` fallback governs ONLY a direct mergeSnapshot caller (unit
  // tests). The panel-reach OUTCOME is preserved because preVisible AGREES with hiddenWhenSeen for a control
  // hidden immediately before the act (it is absent from preVisible ⟺ it was captured hidden); they diverge
  // only for a sibling made visible by the reveal-replay PROLOGUE — where preVisible correctly DECLINES the
  // backfill (that sibling gets its true [opener] path when its own opener is acted directly; no coverage lost).
  // STATEFUL MODE WRITES NO REVEAL PATHS. A reveal path is a COLD-REPLAY artifact: re-navigate, replay the
  // opener clicks, act. The stateful walk never replays — it acts in place on an already-open modal — and
  // reveal-replay REFUSES a stateful path outright (REVEAL_PROVENANCE_ONLY), because an in-session
  // breadcrumb is an over-approximation of every act since the last nav, not a route. So stamping one here
  // is pure liability: it burns the write-once `inst.reveal` slot on a path nothing can ever walk. The
  // schema bump to 6 was meant to invalidate 494 such poisoned paths, but this writer stayed on and had
  // already minted 250 more. It also resurrected FAILED acts — an act that died on an intercepted click was
  // marked explored+unreachable, then cleared here, re-ranked as freshly revealed, and re-picked to fail
  // again (live: tpl 25 at seq 34 and 44, same interception both times).
  if (stateful) return false;
  const key = `${el.templateSelector}::${el.instanceKey}`;
  const revealedNow = preVisible ? !preVisible.has(key) : inst.hiddenWhenSeen;
  if (!revealedNow) return false;
  if (inst.explored && !inst.unreachable) return false; // genuine coverage — never reset
  inst.reveal = { route, statePath: revealPath, ...(stateful ? { stateful: true } : {}) };
  inst.explored = false;
  delete inst.unreachable;
  if (node.instances[0] === inst) {
    node.explored = false;
    delete node.unreachable;
  }
  return true;
}

export function mergeSnapshot(graph, route, elements, opts = {}) {
  if (!graph.routes[route]) graph.routes[route] = { type: 'route', url: route };
  const newTemplates = [];
  const newInstances = [];
  // Pre-existing PATHLESS instances that THIS stamped act just made visible (the "panel reach"
  // fill — see the else-branch below). Surfaced so step.mjs counts them toward the reveal effect
  // (markOpener) even when nothing brand-new appeared, and the caller reports newly-reachable controls.
  const filled = [];
  for (const el of elements) {
    const tid = el.templateId;
    let node = graph.elements[tid];
    if (!node) {
      node = graph.elements[tid] = {
        type: 'element', templateId: tid, templateSelector: el.templateSelector,
        role: el.role, name: el.name, route, explored: false,
        // Template-level locator KIND (the durable-handle TYPE its instances share) — a
        // derived attribute, NOT identity. Each instance carries its concrete locator.
        locator: el.locator ? { type: el.locator.type, attr: el.locator.attr } : undefined,
        instances: [],
      };
      // Stay-on-page reveal annotation (GAP 2): when an in-page action revealed this NEW
      // template, record the ordered path (route + statePath:[{templateId,instanceKey}]) that
      // reaches it. A SEPARATE addressing DIMENSION, never an identity key — identity stays
      // selector-keyed via ids.mjs, so this adds ZERO id/edge churn. First-reveal-path-wins:
      // an already-existing node is never re-stamped (the `if (!node)` guard is first-wins).
      // opts.stateful marks a stateful-mode provenance breadcrumb (additive, absent otherwise).
      if (opts.revealPath) node.reveal = { route, statePath: opts.revealPath, ...(opts.stateful ? { stateful: true } : {}) };
      newTemplates.push({ templateId: tid, templateSelector: el.templateSelector });
    }
    // Write-once list-row flag (DRILL_PER_LIST honesty): a template with ANY row-resident instance (an
    // element inside an <li>/<tr>/[role=row|listitem]) is a list-row template — its non-representative
    // rows are counted as drillSkipped (frontier.mjs), the non-opener analog of cappedRemainder. Additive
    // REPORTING flag on the node, NEVER an identity key. Once true stays true; absent el.inRow (older
    // snapshot) → leave listRow unset (safe default), exactly like hiddenWhenSeen's absent→false pattern.
    if (el.inRow === true) node.listRow = true;
    // Write-once nav-landmark flag (MENU-EVENT SWEEP): a template with ANY instance inside a
    // <nav>/[role=navigation] landmark is a global-section nav control — the frontier's navBatch
    // front-loads it so constant-URL onClick sections are hydrated first. Additive REPORTING flag,
    // NEVER an identity key; once true stays true; absent el.inNav (older snapshot) → leave unset.
    if (el.inNav === true) node.navControl = true;
    // Write-once widget-chrome flag: a template whose instances live inside a framework widget's popup
    // panel (a date picker's month/year/decade switchers, a select's option list — see widget-popup.mjs)
    // is not application surface and is kept OUT of the frontier by frontier.mjs, counted in widgetSkipped.
    // Additive REPORTING flag, NEVER an identity key — no schema bump, exactly like listRow/navControl.
    //
    // Stamped HERE, outside the `if (!node)` branch, deliberately: 55 such templates are already on disk
    // from earlier runs, and a graph is carried across runs. Excluding these at snapshot time instead would
    // never reach them — they would keep being emitted, keep failing NO_INSTANCE, and could never be
    // reclassified, because nothing re-observes a control it refuses to collect. That is the INC.6
    // first-write-wins-with-no-invalidation trap, and this placement is what avoids it: an existing node
    // acquires the flag the next time its picker is opened by actuation.
    if (el.inWidgetPopup === true) node.widgetInternal = true;
    // The AUTHORED testid, carried write-once onto the node. Additive metadata like the flags around it —
    // it never enters templateSelector / instanceSelector / instanceKey, so identity is untouched. What it
    // buys is the author's own answer to "are these the same control or different ones", which the DOM
    // cannot supply on a component library where every button renders an identical path.
    // SHAPE GATE. The writer emitted `{attr,value}` here for one release while three readers expected a
    // string; nothing caught it because each reader's test builds its own string fixture. A type that
    // crosses a module boundary and is never asserted is a silent no-op waiting to happen, and this one
    // cost a coverage mechanism and a measurement instrument simultaneously. Fail loud instead.
    if (el.testid != null && typeof el.testid !== 'string') {
      throw new Error(`testid must be a string, got ${typeof el.testid} — the authored VALUE, not the {attr,value} record`);
    }
    if (el.testid && !node.testid) node.testid = el.testid;
    // FIELD FACTS — what this field DECLARES it accepts (maxLength, required, pattern, readonly, the
    // label, the hint). Stored on the template because the constraint is a property of the control, not
    // of one row's instance. Write-once-then-fill: an early snapshot may catch a field while its wrapper
    // has not rendered its `required` marker yet, so a later observation may ADD facts, but an existing
    // non-null fact is never overwritten — the first honest reading stands.
    //
    // This is the Phase-1 deliverable, not a side effect: the phase exists to turn a black box into a
    // white one, and "what does this field accept, how many characters" is half of that answer. It is
    // knowledge ABOUT the element and never an identity input — no schema bump.
    if (el.fieldFacts) {
      const prev = node.fieldFacts || {};
      const merged = { ...prev };
      for (const [k, v] of Object.entries(el.fieldFacts)) {
        if (v === null || v === undefined) continue;
        if (merged[k] === undefined || merged[k] === null) merged[k] = v;
      }
      node.fieldFacts = merged;
    }
    if (!node.instances.some((i) => i.instanceKey === el.instanceKey)) {
      const inst = {
        instanceId: el.instanceId,
        instanceKey: el.instanceKey,
        instanceSelector: el.instanceSelector,
        // PER-INSTANCE authored id. This is the one that matters: a template holding seven distinct
        // authored controls is exactly the case the node-level id cannot express, and it is the case the
        // frontier must see to stop walking one instance and calling the other six "the other rows".
        ...(el.testid ? { testid: el.testid } : {}),
        locator: el.locator,
        explored: false,
        // Provenance for the fill-if-absent reveal (state model, "panel reach"): was this instance
        // HIDDEN when first captured? A control present-but-not-visible at baseline (an antd tab
        // behind a "…more" overflow) is discovered PATHLESS, so first-reveal-wins would lock it
        // unreachable forever. hiddenWhenSeen (write-once) marks it eligible to ACQUIRE a reveal
        // path when a later opener act makes it visible; a directly-visible control is never
        // eligible (no spurious replay). Absent el.visible (older snapshot) → false, safe default.
        hiddenWhenSeen: el.visible === false,
      };
      // Instance-level reveal (state model): a control revealed by an in-page action carries the
      // path that reaches it AT THE INSTANCE level — even when it is a new instance of an ALREADY-
      // KNOWN template (the first target's nav-swap case the template-level stamp on line 62 misses, since
      // that only fires for a NEW template node). fill-if-absent, first-reveal-path-wins per instance.
      // opts.stateful rides the instance reveal too (the first target's nav-swap control has NO node.reveal —
      // its template already existed — so the stateful provenance marker MUST live at the instance level).
      if (opts.revealPath) inst.reveal = { route, statePath: opts.revealPath, ...(opts.stateful ? { stateful: true } : {}) };
      node.instances.push(inst);
      newInstances.push({ templateId: tid, instanceKey: el.instanceKey, instanceSelector: el.instanceSelector });
    } else if (opts.revealPath) {
      // FILL-IF-ABSENT reveal ("panel reach"): a control discovered HIDDEN and PATHLESS at baseline
      // that THIS stamped opener act just made VISIBLE acquires the opener's reveal path. See
      // fillRevealIfHidden for the gates (incl. the genuine-coverage guard) and the reopen rationale.
      const inst = node.instances.find((i) => i.instanceKey === el.instanceKey);
      if (inst && fillRevealIfHidden(node, inst, el, route, opts.revealPath, opts.stateful, opts.preVisible)) {
        filled.push({ templateId: tid, instanceKey: el.instanceKey });
      }
    }
  }
  return { newTemplates, newInstances, filled };
}

// Mark an element template as explored — the recon loop has acted on it, so the
// frontier will not hand it out again. No-op if the template is unknown.
export function markExplored(graph, templateId) {
  const node = graph.elements[templateId];
  if (node) node.explored = true;
}

// Record that a template was drained from the frontier WITHOUT being genuinely reached
// — e.g. a cold-start reload could not resolve its instance. It stays `explored` (so the
// frontier drains and the loop terminates) but must NOT count as real coverage:
// frontierStats subtracts it from `explored`. No-op if the template is unknown.
export function markUnreachable(graph, templateId, reason) {
  const node = graph.elements[templateId];
  if (node) node.unreachable = reason || true;
}

// The instance found by key under a template, or null. Shared helper for the instance-level
// exploration marking the state model needs (a template with N addressable instances is drained
// per-instance, not all-at-once, so a per-instance opener can walk its siblings).
function instanceOf(graph, templateId, instanceKey) {
  const node = graph.elements[templateId];
  const inst = node && node.instances && node.instances.find((i) => i.instanceKey === instanceKey);
  return inst || null;
}

// Mark ONE instance explored (drained from the instance-level frontier) — the per-instance analog
// of markExplored. Also sets the template `explored` flag for backward compat (a single-instance
// template's template-level coverage still reads correctly). No-op if the instance is unknown.
export function markInstanceExplored(graph, templateId, instanceKey) {
  const inst = instanceOf(graph, templateId, instanceKey);
  if (inst) inst.explored = true;
  const node = graph.elements[templateId];
  if (node) node.explored = true;
}

// Mark ONE instance drained-but-not-reached (its reveal path could not be replayed / resolved).
// Keeps the instance out of genuine coverage without stalling the loop. No-op if unknown.
// Template-level `node.unreachable` (backward compat + the honest denominator frontierStats reads)
// reflects the REPRESENTATIVE instance ONLY: a template counts unreachable iff its instance[0]
// could not be reached. A later opener-sibling that fails does NOT retro-taint a template whose
// representative WAS reached.
export function markInstanceUnreachable(graph, templateId, instanceKey, reason) {
  const node = graph.elements[templateId];
  if (!node) return;
  const inst = instanceOf(graph, templateId, instanceKey);
  if (inst) inst.unreachable = reason || true;
  if (node.instances && node.instances[0] && node.instances[0].instanceKey === instanceKey) {
    node.unreachable = reason || true;
  }
}

// Mark ONE instance CHURNED — a re-rendering feed row whose CONTENT-keyed instanceKey vanished (the row
// re-rendered away before it could be walked) — a DISTINCT bucket from unreachable. Additive, write-once
// `inst.churned = true`. It does NOT set `unreachable` (a feed re-render is not a genuinely unreachable
// control) and — DELIBERATELY — does NOT set `explored`: the frontier drains a churned instance via
// nextBatch's `inst.churned` predicate (so it is never re-handed), while it stays honestly UN-walked, which
// lets frontierInstanceStats PEEL it into `churnSkipped` instead of inflating `walked`. (Marking it explored
// would make the peel net-neutral to `remaining` — the churn would still count as walked — defeating the
// whole point of a separate bucket.) Identity-safe: flips one flag, never removes/re-keys. No-op if unknown.
export function markInstanceChurned(graph, templateId, instanceKey) {
  const inst = instanceOf(graph, templateId, instanceKey);
  if (inst) inst.churned = true;
}

// Flag a template as an OPENER — acting one of its instances revealed new controls on the same
// route (a stay-on-page reveal). The frontier enumerates an opener's OTHER instances (bounded), so
// a nav bar of 3 links that are instances of one template gets all three walked, not just the first.
export function markOpener(graph, templateId) {
  const node = graph.elements[templateId];
  if (node) node.opener = true;
}

// Attach the agent's semantic observation to an element template. Writes
// node.semantics ONLY — does NOT touch `explored` (observe.mjs composes this with
// markExplored). The observation is DATA extracted from crawled page content: stored
// verbatim, never evaluated. Returns { recorded } — false if the template is unknown.
export function recordSemantics(graph, templateId, semantics) {
  const node = graph.elements[templateId];
  if (!node) return { recorded: false };
  node.semantics = semantics;
  return { recorded: true };
}

// Add a causal edge element(templateId) --triggers--> request. Upserts the request
// node and dedupes the edge. Response metadata (when present) accumulates on the node:
// `statuses` is a per-endpoint histogram { "<status>": count }, `resourceType` is the
// last-seen scalar. Status is NOT part of endpoint identity (reqKey stays method+pattern),
// so N calls returning different statuses share one node. durationMs is per-call and stays
// OFF the node (it lives in the per-act trail). All additive — pre-existing graphs upgrade
// cleanly (the fields simply start absent).
export function addTrigger(graph, templateId, request) {
  const method = String(request.method || 'GET').toUpperCase();
  const urlPattern = request.urlPattern;
  const key = reqKey(method, urlPattern);
  if (!graph.requests[key]) graph.requests[key] = { type: 'request', method, urlPattern };
  const node = graph.requests[key];
  if (request.status != null) {
    const s = String(request.status);
    node.statuses = node.statuses || {};
    node.statuses[s] = (node.statuses[s] || 0) + 1;
  }
  if (request.resourceType != null) node.resourceType = request.resourceType;
  const from = `element:${templateId}`;
  const to = `request:${key}`;
  if (!graph.edges.some((e) => e.from === from && e.to === to)) {
    graph.edges.push({ from, to, type: 'triggers', provenance: 'causal' });
  }
}

// Re-arm carried-forward routes for a re-crawl under a new element identity scheme. `visited` is
// represented by the ABSENCE of `pending` (route-frontier.markRouteVisited), so carrying routes across a
// schema reset verbatim would mark every one of them already-visited while their elements are gone —
// discovery preserved, collection silently skipped, denominator honest-looking and empty. Re-arming
// restores `pending` so each route is genuinely re-snapshotted. An `unreachable` route keeps that flag: a
// 404/redirect is a fact about the SERVER, not about our identity scheme, and it stays counted-not-covered.
function rearmRoutes(routes) {
  const out = {};
  for (const [rk, node] of Object.entries(routes || {})) {
    if (!node || typeof node !== 'object') continue;
    out[rk] = node.unreachable ? { ...node } : { ...node, pending: true };
  }
  return out;
}

export function loadGraph(path) {
  try {
    if (!existsSync(path)) return makeGraph();
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    // Schema gate (INC.1): a graph minted under a DIFFERENT identity scheme (a pre-INC.1 graph
    // has NO schemaVersion and its ids anchored on framework-noise selectors) must NOT co-mingle
    // with current-scheme ids. A mismatch (including an absent field = a legacy graph) starts
    // fresh — state/ is EPHEMERAL, re-derived by crawling, so a reset is safe, not data loss;
    // INC.1 requires a re-baseline anyway. saveGraph re-stamps the current version on the next write.
    // ROUTE CARRY-FORWARD. A schema bump invalidates the ELEMENT identity scheme; it says nothing about
    // routes, which are keyed by URL (routeKey) and hold navigation METADATA only — never elements or
    // edges. Dropping them cost 81 `declared:true` manifest-seeded routes at the v4→v5 bump, and because
    // the stateful driver has no cold route seeder, the route universe collapsed to {entry URL} ∪ {where
    // acting happened to land}: 85 distinct route patterns → 3, taking /groups, /events, /chats, /profile
    // and /setting out of reach entirely. The runner then honestly reported "everything reachable is
    // collected" over the shrunken denominator — the exact denominator collapse the honesty invariant
    // forbids. So discovery survives the re-key; only COLLECTION state is discarded.
    if (raw.schemaVersion !== SCHEMA_VERSION) return { ...makeGraph(), routes: rearmRoutes(raw.routes) };
    return {
      schemaVersion: SCHEMA_VERSION,
      routes: raw.routes || {},
      elements: raw.elements || {},
      requests: raw.requests || {},
      edges: Array.isArray(raw.edges) ? raw.edges : [],
      // Carried forward across load/save so the report (a separate process) sees it: the negative-control
      // Not-Found structural sig (route-frontier.probeNotFound). ADDITIVE reporting metadata, NEVER an
      // identity input — no schema bump. Absent on an older graph → undefined → client-404 label no-ops.
      ...(raw.notFoundSig !== undefined ? { notFoundSig: raw.notFoundSig } : {}),
    };
  } catch {
    return makeGraph();
  }
}

export function saveGraph(path, graph) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(graph, null, 2));
}
