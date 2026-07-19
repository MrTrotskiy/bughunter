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
import { nextPendingRoute, markRouteVisited } from './route-frontier.mjs';
import { reopenContainer } from './reopen-container.mjs';
import { routeRefused, isDismissControl } from './danger-floor.mjs';
import { exploreAllArmed } from './explore-policy.mjs';
import { traceEvent, snapshotGraph } from '../debug/trace.mjs';

const ALL = 1e9;               // effectively-unbounded receptive field — the driver needs EVERY eligible
                               // unexplored instance across all routes, not the size-N stateless slice.
const DEFAULT_MAX_ACTS = 2000; // runaway backstop: total acts when the caller passes no budget.steps.
const MAX_BACKTRACKS = 500;    // runaway backstop: total driver-initiated cross-page navigations.
// Stall guard: how many times the driver may backtrack to ONE route before retiring it. Raised 3→12
// because 3 was FAR too tight for a real SPA: a route whose controls sit behind several different in-app
// states needs one visit per state, and a rich page (the first target's /post_ad, /dashboard) has more than
// three. Measured live: the walk stalled with 34 controls still queued purely because their routes had
// been retired, not because the controls were unreachable. This is a runaway backstop, not a budget —
// MAX_BACKTRACKS still bounds the total, and a route that genuinely yields nothing new is retired by the
// no-progress check regardless of this ceiling.
const MAX_REVISITS = 12;

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

export async function statefulLoop(graph, { page, origin, ledger, step, budget = {}, onStep, runId, marker = null, runCreatedAccount = false } = {}) {
  const maxActs = Number.isFinite(budget.steps) ? budget.steps : DEFAULT_MAX_ACTS;
  const steps = [];
  // requested route → the route it actually lands on. Populated only by observation, never assumed.
  const routeAlias = new Map();
  const exhausted = new Set();  // routes the stall guard retired (never re-picked)
  const visits = new Map();     // route → driver-backtrack count (stall-guard input)
  let backtracks = 0;
  let stalled = false;          // a stall-guard retirement happened → the terminal is 'stalled', not drained
  let stopped = null;
  // Template ids the LAST act revealed — see pickLive.
  let justRevealed = new Map();   // templateId -> the act sequence that revealed it (recency)
  let revealSeq = 0;
  let revealedRoute = null;      // the route `justRevealed` belongs to; a navigation invalidates it

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
    // Record what THIS act revealed so the next pick drains it instead of wandering off by id order.
    // Both buckets count: `newElements` are controls that did not exist before (a modal mounting its
    // fields), `newlyReachable` are pre-existing ones this act uncovered (a panel expanding).
    const revealed = [...(outcome.newElements || []), ...(outcome.newlyReachable || [])];
    // ACCUMULATE, do not overwrite. Overwriting made the set describe only the LAST act, so a single
    // non-revealing act inside an open modal (clicking a field reveals nothing) emptied it — which both
    // dropped the freshness ordering AND lifted the "don't dismiss an undrained overlay" guard below.
    // Measured live: acts #11 and #12 of drain1 were "cancel" twice in a row, and #14 then failed to
    // resolve "Group Name" because its modal had just been closed. The set is scoped to ONE route and
    // cleared when we navigate away or the overlay is dismissed — it never grows unbounded.
    // RECENCY, not a boolean. Accumulating alone is not enough: a nav-like act reveals a whole page (52
    // controls, measured), after which "is it fresh?" is true for everything and fresh-first orders
    // nothing — the sort is stable, so the walk fell straight back to ascending template id and abandoned
    // the modal exactly as before. Storing WHEN each control was revealed keeps both properties: the set
    // survives a non-revealing act, and the 11 controls a modal just mounted still outrank the 52 the
    // previous navigation uncovered.
    const here = routeKey(page.url());
    if (here !== revealedRoute) { justRevealed = new Map(); revealedRoute = here; }
    revealSeq++;
    for (const r of revealed) if (r && r.templateId != null) justRevealed.set(r.templateId, revealSeq);
    steps.push([{ templateId: target.templateId, instanceKey, name: target.name, ...outcome }]);
    if (onStep) await onStep(graph);
  };

  // Template ids the LAST act revealed. This is the whole fix for "a modal opens and is abandoned":
  // candidates are otherwise handed out in ASCENDING templateId order, and freshly-revealed controls get
  // the HIGHEST ids — so a modal's contents were always last in line. Measured on a full live crawl:
  // 46 acts revealed 415 instances and NOT ONE of those revelations was drained next; "Create Event"
  // opened a 14-control modal and the driver walked away to the next id.

  // Prefer, among the candidates that resolve live, whatever the previous act just revealed. Ordering
  // only — nothing is added to or removed from the frontier, so the honest denominator is untouched.
  const pickLive = async (cur) => {
    // A template counts as on this route if it was captured under a route that redirects HERE.
    const sameRoute = (r) => r === cur || routeAlias.get(r) === cur;
    const onRoute = candidates(graph).filter((t) => sameRoute(t.route));
    // A modal that reveals both "Create" and "Cancel" must not be closed by the very pass meant to
    // complete it. Dismiss ranks LAST OF ALL — not merely last among the fresh: a "cancel" left over from
    // an earlier overlay was otherwise picked ahead of ordinary base-page work, closing state the next
    // pick still needed. Acting it last costs nothing (it stays in the frontier and still gets explored).
    const rank = (t) => {
      if (isDismissControl({ name: t.name })) return 2;   // 2 = closes something, act it last
      return justRevealed.has(t.templateId) ? 0 : 1;      // 0 = revealed by some act, 1 = everything else
    };
    // Among revealed controls, MOST RECENTLY revealed first — that is what keeps a just-opened modal's
    // contents ahead of the page the navigation before it uncovered.
    const ordered = onRoute.slice().sort((a, b) => {
      const d = rank(a) - rank(b);
      if (d !== 0) return d;
      return (justRevealed.get(b.templateId) || 0) - (justRevealed.get(a.templateId) || 0);
    });
    for (const t of ordered) {
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
        // Do NOT close an overlay while its OWN contents are still undrained — that is the loop where the
        // act which opened a modal is also the act that kills it. Only dismiss once nothing fresh remains.
        if (justRevealed.size > 0) {
          const freshLeft = candidates(graph).some((t) => t.route === cur && justRevealed.has(t.templateId));
          if (freshLeft) return false;   // fresh work exists but does not resolve → honest stop, keep state
        }
        if (!(await dismissBlockingOverlay(page))) return false;
        resetTrackerVerdicts(page);
        justRevealed = new Map();        // the overlay is gone; nothing is "fresh" behind it any more
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
  // `final` = this route has exhausted its revisit budget, so nothing further will re-open its states.
  // Until then a leftover is NOT retired: it may sit behind an in-app state (a closed modal, an unselected
  // tab) that a LATER visit opens. Retiring on the first pass was writing off 111 controls as
  // NO_INSTANCE_on_live_route purely because they were not reachable in the state we happened to be in —
  // which is precisely the state-dependence the stateful walk exists to traverse.
  // CHURN is retired ALWAYS: a vanished list row genuinely re-rendered out of existence, and quantifying
  // it is what lets the stable set drain. Only the UNREACHABLE verdict waits for `final`.
  const retireLeftovers = async (cur, final) => {
    for (const t of candidates(graph)) {
      if (t.route !== cur) continue;
      if (await resolveHandle(page, t.instance, graph.elements[t.templateId])) continue; // still reachable
      const node = graph.elements[t.templateId];

      // TRY TO RE-ENTER BEFORE WRITING IT OFF. A control that does not resolve is usually not gone — its
      // CONTAINER closed. Three of the six target flows have no URL at all and live only as dashboard modal
      // state, so "does not resolve on the live route" is the normal condition for them, not an exception.
      // Measured before this: 13 of 16 never-touched elements were the whole profile dropdown and the kebab
      // menu, written off as "a vanished feed row" — and every one of the 13 carried a recorded path back to
      // itself. Another 28 of the 50 mislabelled-reachable ones carried one too. The information to recover
      // them was already in the graph; nothing tried to use it.
      //
      // reopenContainer replays the SUFFIX of that path and VERIFIES by re-resolving the target, so a wrong
      // path degrades to "still unreachable" and can never produce a mis-attributed act. Only attempted when
      // a path exists — otherwise this is exactly the old behaviour.
      if ((t.instance?.reveal?.statePath || node?.reveal?.statePath || []).length) {
        const re = await reopenContainer(page, graph, t, { origin, marker, runCreatedAccount }).catch(() => null);
        if (re && re.ok) continue;                       // back inside; the frontier will hand it out again
      }
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
      } else if (final) {
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
    const landed = routeKey(page.url());
    // ROUTE ALIAS. An app that redirects its entry — `/` → `/people` here — leaves every template captured
    // by the baseline stamped `route: '/'` while the live page is forever `/people`. `pickLive` filters on
    // `t.route === cur`, so those templates could never be selected: measured across SIX runs, the entire
    // entry page (its search, its filters, Export, Notifications, "Create new absence request", 24 employee
    // links — 16 templates) was never acted ONCE. It also produced 147 barren navigations, because the
    // route kept being picked as having work and kept draining nothing.
    //
    // Narrow by construction: an alias is recorded ONLY for the pair actually observed, requested→landed,
    // and never between two routes that each rendered independently. A broader rule would merge distinct
    // pages into one identity and shrink the denominator, which is the opposite failure.
    if (landed !== rk) routeAlias.set(rk, landed);
    const snap = await snapshotStep(page, graph, ledger, landed);
    // The trail records BOTH now. Recording only the landed route is why 651 barren navigations could not
    // be diagnosed from the trail at all — it could not answer "where did it try to go, and what happened".
    if (runId) { const seq = traceEvent(runId, 'route', { route: landed, requested: rk, redirected: landed !== rk, ...snap, backtrack: true }); snapshotGraph(runId, seq); }
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
    // Retire only when this route is genuinely spent: it has been revisited to the ceiling, so no further
    // pass will surface a new state for its leftovers. Otherwise leave them in the frontier.
    await retireLeftovers(cur, (visits.get(cur) || 0) >= MAX_REVISITS);
    // The backtrack route gate lifts under explore-all, mirroring persistentStep's navigation gate.
    // Otherwise the stateful driver would never backtrack to a danger route and would strand every
    // control that only lives there — the same coverage loss the mode exists to remove.
    const skipRefused = !exploreAllArmed(process.env);
    const next = routesWithWork(graph).find((r) => r !== cur && !exhausted.has(r) && !(skipRefused && routeRefused(r)));
    if (!next) {
      // ROUTE-FRONTIER DRAIN, before any terminal claim. `routesWithWork` can only ever name routes we
      // already hold CONTROLS for, so a page the crawl has not stood on yet is invisible to it — which is
      // how a run reached "everything reachable is collected" having never queued /groups, /events, /chats,
      // /profile or /setting. Those routes ARE known (the manifest seed and the a[href] harvest record them
      // as metadata), so drain that queue here: navigate IN-SESSION with the same goToRoute used for
      // backtracking, which snapshots the landed page so its controls enter the frontier normally. No cold
      // visit, no reveal replay — the stateful invariant holds. markRouteVisited clears `pending` before we
      // travel, so each queued route is attempted exactly once and this cannot spin.
      const skipPending = !exploreAllArmed(process.env);
      let queued = null;
      for (;;) {
        const rk = nextPendingRoute(graph);
        if (!rk) break;
        markRouteVisited(graph, rk);
        if (rk !== cur && !exhausted.has(rk) && !(skipPending && routeRefused(rk))) { queued = rk; break; }
      }
      if (queued && backtracks < MAX_BACKTRACKS) {
        backtracks++;
        visits.set(queued, (visits.get(queued) || 0) + 1);
        await goToRoute(queued);
        continue;
      }
      // TERMINAL: nowhere left to backtrack, so no future pass can open a new state for this route's
      // leftovers either. Retire them NOW with final=true — otherwise a deferred leftover would sit in the
      // frontier forever and `remaining` could never reach 0 (the honest terminator would never fire).
      await retireLeftovers(cur, true);
      stopped = stalled ? 'stalled' : 'frontier-drained';
      break;
    }
    if (backtracks >= MAX_BACKTRACKS) { stopped = 'stalled'; break; }
    backtracks++;
    visits.set(next, (visits.get(next) || 0) + 1);
    if (visits.get(next) > MAX_REVISITS) { exhausted.add(next); stalled = true; continue; } // stall guard
    await goToRoute(next);
  }

  return { steps, stopped: stopped || 'frontier-drained', stats: frontierStats(graph) };
}
