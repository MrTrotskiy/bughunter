// stateful-loop — the LOCATION-AWARE, in-session recon driver (the stateful twin of recon-loop.mjs;
// recon-loop.mjs is the stateless location-BLIND driver and is left UNTOUCHED). This is the operator's
// actual model: ONE session opened ONCE, walked page-to-page IN-SESSION with PER-LOCATION memory of
// what is left. It drains the CURRENT page's reachable-unexplored controls, follows a nav act to a new
// page, and — when the current page is done but OTHER pages still hold unfinished controls — BACKTRACKS
// (an in-session gotoGated, session/cookies preserved) to finish them, until EVERY route's remainder is
// zero. Moving between pages is normal navigation, NOT the per-act COLD reset the stateless path does.
//
// WHY (vs recon-loop.mjs): reconLoop hands the injected step ANY unexplored template regardless of the
// live page's route, so a cross-page target fails NO_INSTANCE under statefulStep (which acts IN PLACE).
// This driver fixes that by selecting only templates whose node.route === the live route AND that
// RESOLVE on the live DOM, and by NAVIGATING to a route before draining its controls.
//
// CAUSAL DISCIPLINE: statefulStep owns the ONE causal window (beginCause→click→endCause) and resets the
// initiator verdicts per act. This driver opens NO causal window: the only page ops it adds are a
// gotoGated backtrack + snapshotStep, BOTH under __idle__ and edge-free (snapshotStep never calls
// addTrigger), so attribution is exactly what statefulStep produced — never a side effect of navigation.
//
// HONESTY: a template on route R that never resolves even after a FRESH navigation to R is
// markInstanceUnreachable (drained, never counted covered) — the denominator (frontierStats) never
// collapses. A control behind a now-collapsed reveal on a backtracked page is honest-unreachable for now
// (stateful mode has NO reveal-replay); reveal-replay recovery on backtrack is the known follow-up.

import { nextBatch, frontierStats } from './frontier.mjs';
import { markInstanceExplored, markInstanceUnreachable, markInstanceChurned } from '../graph/graph-store.mjs';
import { snapshotStep } from './step.mjs';
import { resolveHandle } from './resolve-handle.mjs';
import { routeKey } from './scope.mjs';
import { gotoGated } from '../browser/session.mjs';
import { waitSettled, resetTrackerVerdicts } from '../browser/causal.mjs';
import { dismissOverlays } from './overlays.mjs';
import { dismissBlockingOverlay } from './overlay-dismiss.mjs';
import { routeRefused } from './danger-floor.mjs';
import { traceEvent, snapshotGraph } from '../debug/trace.mjs';

const ALL = 1e9;               // effectively-unbounded receptive field — the driver needs EVERY eligible
                               // unexplored instance across all routes, not the size-N stateless slice.
const DEFAULT_MAX_ACTS = 2000; // runaway backstop: total acts when the caller passes no budget.steps.
const MAX_BACKTRACKS = 500;    // runaway backstop: total driver-initiated cross-page navigations.
const MAX_REVISITS = 3;        // stall guard: backtracks to ONE route before it is retired (exhausted).

const keyOf = (t) => (t.instanceKey != null ? t.instanceKey : (t.instance && t.instance.instanceKey));

// Every eligible UNEXPLORED instance the frontier would hand out, across ALL routes (opener-cap +
// eligibility honored — nextBatch stays the ONE selector, never re-implemented). The driver layers
// per-location filtering on top of this honest set.
const candidates = (graph) => nextBatch(graph, { size: ALL });

// The routes that still carry an unexplored candidate (the per-location remainder), each a known
// template route by construction (a candidate's node.route). Deterministic ascending order.
function routesWithWork(graph) {
  const set = new Set();
  for (const t of candidates(graph)) if (t.route) set.add(t.route);
  return [...set].sort();
}

// Does the target instance resolve to a live, visible handle on the CURRENT DOM right now — via the SAME
// DURABLE resolution actStep uses (stored positional selector first, else the durable id / role-name
// representative)? So a dynamic feed whose nth-child selector went stale still counts REACHABLE as long as
// a durable locator finds a live element (the fix for stateful being WORSE than stateless on a re-
// rendering page: a stale selector no longer prematurely retires a control that is still right there).
// This is actStep's own NO_INSTANCE/NOT_VISIBLE gate, pre-checked so the driver only acts genuinely-
// reachable controls and can tell "this route is drained" from "this route is barren". Never throws.
async function resolvesLive(page, target, node) {
  return !!(await resolveHandle(page, target.instance, node));
}

export async function statefulLoop(graph, { page, origin, ledger, step, budget = {}, onStep, runId } = {}) {
  const maxActs = Number.isFinite(budget.steps) ? budget.steps : DEFAULT_MAX_ACTS;
  const steps = [];
  const exhausted = new Set();  // routes the stall guard retired (never re-picked)
  const visits = new Map();     // route → driver-backtrack count (stall-guard input)
  let backtracks = 0;
  let stalled = false;          // a stall-guard retirement happened → the terminal is 'stalled', not drained
  let stopped = null;

  // ONE act via the injected statefulStep, mirroring reconLoop's per-target bookkeeping: mark the
  // instance explored (drained) either way, unreachable on a throw (acted-but-not-reached). statefulStep
  // owns the causal window; the driver adds none. Every act drains ≥1 instance → forward progress.
  const runAct = async (target) => {
    const instanceKey = keyOf(target);
    let outcome;
    try { outcome = await step(graph, target); }
    catch (err) { outcome = { error: err?.message || String(err) }; }
    markInstanceExplored(graph, target.templateId, instanceKey);
    if (outcome.error) markInstanceUnreachable(graph, target.templateId, instanceKey, outcome.error);
    steps.push([{ templateId: target.templateId, instanceKey, name: target.name, ...outcome }]);
    if (onStep) await onStep(graph);
  };

  // The first unexplored candidate on `cur` that RESOLVES on the live DOM right now, or null.
  const pickLive = async (cur) => {
    for (const t of candidates(graph)) {
      if (t.route !== cur) continue;
      if (await resolvesLive(page, t, graph.elements[t.templateId])) return t;
    }
    return null;
  };

  // Drain the CURRENT route to fixpoint: act every unexplored candidate that RESOLVES on the live DOM,
  // re-evaluating after each act (a reveal's fresh controls are picked up), until none resolves OR an
  // act NAVIGATED to another page. Returns whether we left the route (the "went to page 2" move).
  const drainRoute = async () => {
    const cur = routeKey(page.url());
    while (steps.length < maxActs) {
      if (routeKey(page.url()) !== cur) return true;
      let picked = await pickLive(cur);
      if (!picked) {
        // CLOSE-AFTER-STUDY (the modal-heavy-site fix): no candidate resolves — but an open
        // modal/overlay from an earlier act may be MASKING base-page siblings so none can be picked.
        // Close it ONCE (under __idle__, edge-free) and re-scan. Only conclude the route drained if
        // the dismiss changed NOTHING actionable (no overlay, or nothing newly-resolvable after it),
        // so this cannot loop: a successful re-pick drains ≥1 instance (forward progress via runAct's
        // markInstanceExplored), a no-op dismiss returns false → drained.
        if (!(await dismissBlockingOverlay(page))) return false;
        resetTrackerVerdicts(page);
        picked = await pickLive(cur);
        if (!picked) return false;
      }
      await runAct(picked);
    }
    return false; // act budget hit → the main loop stamps 'budget'
  };

  // A route the driver committed to (freshly navigated / landed on) has given its controls a fair shot;
  // any still-unexplored candidate that never resolved is genuinely unreachable in stateful mode →
  // drain + mark unreachable so the denominator stays honest and the route drops out of routesWithWork.
  // SOFTENED (durable resolution): retire ONLY a control resolveHandle CANNOT reach via ANY strategy —
  // never one merely because its stored nth-child went stale while a durable id / role-name representative
  // still resolves it live. drainRoute (via resolvesLive) has already exhausted the resolvable ones, so
  // this re-check is the honest floor: a genuinely-gone control (no live representative) stays
  // unreachable; a still-resolvable one is left in the frontier for the next pass (the stall guard bounds
  // any pathological churn), never prematurely marked unreachable.
  const retireLeftovers = async (cur) => {
    for (const t of candidates(graph)) {
      if (t.route !== cur) continue;
      if (await resolveHandle(page, t.instance, graph.elements[t.templateId])) continue; // still reachable
      const node = graph.elements[t.templateId];
      // CHURN vs UNREACHABLE. A vanished LIST-ROW candidate is a re-rendering feed row whose content-keyed
      // instanceKey re-rendered out — that is CHURN (a distinct bucket), not a genuinely unreachable control:
      // marking it churned lets the stable control set still DRAIN to remaining===0 while the churn is
      // QUANTIFIED (frontier churnSkipped), never conflated into `unreachable`. markInstanceChurned ALONE
      // drains it from the frontier (nextBatch's `inst.churned` predicate) and — deliberately — leaves it
      // UN-explored, so frontierInstanceStats peels it into churnSkipped rather than inflating `walked`
      // (were it explored the peel would be net-neutral to `remaining`). A NON-listRow vanished control is a
      // genuine gap (e.g. a collapsed reveal with no replay in stateful mode) → keep the honest unreachable.
      if (node && node.listRow === true) {
        markInstanceChurned(graph, t.templateId, keyOf(t));
      } else {
        markInstanceExplored(graph, t.templateId, keyOf(t));
        markInstanceUnreachable(graph, t.templateId, keyOf(t), 'NO_INSTANCE_on_live_route');
      }
    }
  };

  // In-session navigation to a backtrack route (session/cookies preserved — NOT a per-act cold reset):
  // SSRF-gated gotoGated, settle, dismiss overlays + reset the load-burst's stale verdicts (both under
  // __idle__, edge-free), then snapshot the landed page so its controls are current for the next drain.
  const goToRoute = async (rk) => {
    await gotoGated(page, new URL(rk, origin).href);
    await waitSettled(page);
    await dismissOverlays(page);
    resetTrackerVerdicts(page);
    const snap = await snapshotStep(page, graph, ledger, routeKey(page.url()));
    if (runId) { const seq = traceEvent(runId, 'route', { route: routeKey(page.url()), ...snap, backtrack: true }); snapshotGraph(runId, seq); }
    if (onStep) await onStep(graph);
  };

  while (true) {
    if (steps.length >= maxActs) { stopped = 'budget'; break; }
    const navigated = await drainRoute();
    if (steps.length >= maxActs) { stopped = 'budget'; break; }
    if (navigated) continue;                 // an act moved us to a new page → drain it next

    // Current route is drained (no resolvable-unexplored). Retire its leftovers, then BACKTRACK to the
    // lowest-keyed route that still has work — the operator's "go back and finish the unfinished page".
    const cur = routeKey(page.url());
    await retireLeftovers(cur);
    const next = routesWithWork(graph).find((r) => r !== cur && !exhausted.has(r) && !routeRefused(r));
    if (!next) { stopped = stalled ? 'stalled' : 'frontier-drained'; break; } // zero-new everywhere → terminal
    if (backtracks >= MAX_BACKTRACKS) { stopped = 'stalled'; break; }
    backtracks++;
    visits.set(next, (visits.get(next) || 0) + 1);
    if (visits.get(next) > MAX_REVISITS) { exhausted.add(next); stalled = true; continue; } // stall guard
    await goToRoute(next);
  }

  return { steps, stopped: stopped || 'frontier-drained', stats: frontierStats(graph) };
}
