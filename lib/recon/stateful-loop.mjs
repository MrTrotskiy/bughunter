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
import { answeredTerminally, elementBlockedBy } from './knowledge.mjs';
import { markInstanceExplored, markInstanceUnreachable, markInstanceChurned } from '../graph/graph-store.mjs';
import { snapshotStep } from './step.mjs';
import { resolveHandle } from './resolve-handle.mjs';
import { routeKey } from './scope.mjs';
import { gotoGated } from '../browser/session.mjs';
import { waitSettled, resetTrackerVerdicts } from '../browser/causal.mjs';
import { dismissOverlays } from './overlays.mjs';
import { settleAnimations } from '../browser/anim-settle.mjs';
import { dismissBlockingOverlay } from './overlay-dismiss.mjs';
import { nextPendingRoute, markRouteVisited } from './route-frontier.mjs';
import { reopenContainer } from './reopen-container.mjs';
import { routeRefused, isDismissControl } from './danger-floor.mjs';
import { exploreAllArmed } from './explore-policy.mjs';
import { traceEvent, snapshotGraph } from '../debug/trace.mjs';
import { census } from './pick-diagnose.mjs';
import { createRelocationMemo } from './relocation-memo.mjs';

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
// Acts spent on ONE route before the route QUEUE gets a turn. Depth-first-to-fixpoint starved the queue
// completely on a real application (49 routes discovered, 3 visited), so every coverage number described
// one page. This is a FAIRNESS quantum, not a cap: the route keeps its unexplored controls, stays in
// routesWithWork, and the backtrack pass returns to it. Large enough that a modal flow (open → fill → submit)
// completes inside one turn; small enough that 46 queued pages are reached within a normal act budget.
const ROUTE_ACT_BUDGET = 20;

// ═══ DECISION VISIBILITY ════════════════════════════════════════════════════════════════════════
//
// This driver takes three choices per act cycle — which element, which route, and when to stop working a
// page — and until now it recorded only the last one, and only partly. `pick-empty` fires when the scan
// finds NOTHING; a SUCCESSFUL pick wrote nothing at all, so the trail could say a control was clicked but
// never how many others were eligible, what ranked it first, or what lost. `pickRoute` chose a
// destination out of a filtered, least-visited-first set and threw the whole set away, so "why did it
// travel there" and "why not to the page holding 25 untouched controls" had no answer on disk.
// `retireLeftovers` decided churn-vs-unreachable per control and recorded neither.
//
// EVERY ONE OF THESE IS A SCRIPT DECISION. `recon-run` → `statefulLoop` has no model stage anywhere in
// its path: the rank is a comparator, the route is a min over a visit counter, the stop is a budget
// comparison. The events below say what was eligible, what ranked how, what was chosen and what was
// rejected by which rule — mechanical vocabulary throughout, because that is all that happened.
//
// BOUNDED. Each event names its true total and caps only the SAMPLE LIST, flagging `truncated` when it
// does; a dump of every candidate per act would multiply the trail (287 acts on `raw1`). Worst case is
// one `pick` per act, one `route-choice` per route decision, one `retire` per drained route.
//
// NODE-SIDE ONLY. Every value emitted is already in memory — array lengths, Map lookups, graph fields
// the driver just read. Nothing here adds a page.evaluate, a screenshot, a CDP call or a navigation, so
// no causal window is opened and attribution stays exactly what statefulStep produced. In particular the
// SUCCESS path deliberately does NOT run `census` (pick-diagnose): that probes the DOM, and it stays
// where it belongs — on the dry path, where the loop is not making progress anyway.
const PICK_SAMPLE = 5;    // losers listed per pick   (the true total rides as rejectedTotal)
const ROUTE_SAMPLE = 6;   // routes listed per choice (the true total rides as rejectedTotal)
const RETIRE_SAMPLE = 8;  // leftovers listed per retire pass (counts are exact, only the list is capped)
// The `rank` comparator's three tiers, named. Indexed BY the rank value pickLive computes, so the label
// and the ordering can never drift apart into two descriptions of one rule.
const RANK_RULE = ['revealed-recency', 'ordinary', 'dismiss-last'];

// A landing that means "you are not signed in". Deliberately NARROW — matched against the LANDED route
// only, and only to detect a redirect INTO it, so a crawl legitimately exploring a login page (an
// unauthenticated run) is unaffected: `isAuthLanding(rk)` is checked too and suppresses the verdict.
const AUTH_LANDING = /^\/(login|log-in|signin|sign-in|auth|session\/new)(\/|$)/i;
const isAuthLanding = (rk) => AUTH_LANDING.test(String(rk || ''));

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

// PINNED-ROUTE MODE (`--route=<routeKey>`): drain ONE page to the bottom instead of covering breadth.
//
// The default breadth interleaving is a measured fix (49 routes discovered, 3 visited) and stays the
// default. But it makes a deep drain impossible: measured with decision tracing, 10 of 17 drain decisions
// ended `navigated` — an act moved the page and the driver went off to drain wherever it landed, so the
// recover-then-act pass (which only runs when a route reports drained) got 5 chances instead of dozens
// while 88 recoverable controls waited. Pinning removes the wandering: every departure returns here, the
// route queue is never consulted, and the run ends when THIS page owes nothing or the act budget is spent.
// Opt-in only — it is the "prove it on one page" mode, not a new default.
export async function statefulLoop(graph, { page, origin, ledger, step, budget = {}, onStep, runId, marker = null, runCreatedAccount = false, pinnedRoute = null, relogin = null } = {}) {
  const maxActs = Number.isFinite(budget.steps) ? budget.steps : DEFAULT_MAX_ACTS;
  const steps = [];
  // requested route → the route it actually lands on. Populated only by observation, never assumed.
  const routeAlias = new Map();
  // WHERE A ROUTE ACTUALLY LANDS. `routeAlias` has existed for a while but was consulted in ONE place
  // (`sameRoute` in pickLive). The DESTINATION choice never asked, and that is the single most expensive
  // defect measured this session: the entry route `/` redirects to a landing page, 17 templates carry
  // `route: '/'` from the pre-redirect baseline snapshot, so `routesWithWork` kept offering `/` while we
  // were standing on the page `/` resolves to. `r !== cur` compared `'/'` with the landing route and said
  // "a different route with work". Measured: 39 of 54 navigations in one run (72%) and 78 of 244 in
  // another were that same wrong bet — travel, land back where we started, drain the same candidates.
  // The barren guard could not catch it either, because the visit DOES produce acts (the landing page has
  // work), so the fruitless counter reset every time and the phantom was rehabilitated forever.
  const landsOn = (r) => routeAlias.get(r) || r;
  const isElsewhere = (r, cur) => landsOn(r) !== cur && r !== cur;
  const exhausted = new Set();  // routes the stall guard retired (never re-picked)
  const visits = new Map();     // route → driver-backtrack count (stall-guard input)
  let backtracks = 0;
  // RUN-SCOPED, and the scope IS the fix — see relocation-memo.mjs for what the per-call version cost.
  const relocMemo = createRelocationMemo();
  // RUN-SCOPED so the refusal census can say which instances it has ALREADY diagnosed. Without it every dry
  // scan re-diagnoses the same candidates and `firstTimeReasons` degenerates into `reasons`: measured on a
  // 948-act run, 107 censuses inspected 1957 candidates and reported `repeats: 0`, which is impossible for a
  // page scanned twenty-two times. A consumer summing that trail multiplies the same instances — the exact
  // tenfold inflation this field was added to prevent, left live because the set was never threaded here.
  const censusSeen = new Set();
  let stalled = false;          // a stall-guard retirement happened → the terminal is 'stalled', not drained
  let stopped = null;
  let sessionLost = null;   // set by goToRoute when a navigation redirects to the sign-in page
  // BARREN ROUTES. A route can sit in routesWithWork — it HOLDS unexplored candidates — while none of them
  // resolves on the live DOM any more (their container closed, their rows re-rendered). Travelling there
  // spends a navigation and returns without acting. With the breadth yield rotating between routes, that
  // becomes a ping-pong: measured on an isolated run, 19 consecutive navigations with ZERO acts between
  // them, and the act-per-navigation ratio falling to 1.17 near the end of the run. The trail called these
  // "barren navigations" twice before (147 and 651 of them) and nothing was ever built to stop them.
  // Two CONSECUTIVE fruitless visits retire a route from the rotation — two, not one, because a single
  // visit can legitimately land mid-transition. A visit that acts resets the count, so a route that
  // becomes reachable again returns to the rotation on its own.
  let lastTravelled = null;   // the route the driver last NAVIGATED to (may differ from where it landed)
  const barren = new Map();   // route → consecutive visits that produced no act
  const BARREN_LIMIT = 2;
  const isBarren = (r) => (barren.get(r) || 0) >= BARREN_LIMIT;
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
    // The GRANULAR code (NO_INSTANCE / NOT_VISIBLE / ALIAS_COLLISION / POST_CLICK_FAILED …) rides alongside
    // the message rather than being flattened into it: `err.envelope.code` is what statefulStep's own
    // recordFail writes to the trail, and a caller that has to regex a prose message to learn WHY an act
    // failed is one more place the answer degrades into "something went wrong".
    catch (err) { outcome = { error: err?.message || String(err), errorCode: err?.envelope?.code || null }; }
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
    // A CONTROL THAT JUST RETIRED, AND WHY. The frontier stops emitting it from here on, and a control that
    // silently stops being offered is exactly the shape of the coverage lie this project keeps finding in
    // its own trails: "why was this never touched again" has to be answerable from the run. Emitted at the
    // moment the retirement happens, naming the rule that fired.
    //
    // DISABLED IS A FINDING, NOT A FAILURE (docs/GOAL.md — the application rendered an affordance it will
    // not honour), so it is traced as one rather than being discarded with the retired control. The graph
    // keeps the blocked probe row either way; `knowledge.notOperableFindings` derives the report from it.
    // Node-side only: a graph read and a trace write, no page I/O, so no causal window is opened.
    if (runId) {
      const node = graph.elements[target.templateId];
      const rows = (node?.probes || []).filter((p) => p && (p.instanceKey == null || p.instanceKey === instanceKey));
      const rule = answeredTerminally(node, rows);
      if (rule) {
        // The node goes in so a DISABLED that has since flipped to enabled is not traced as the reason a
        // control retired — it did not retire on it, and it is not a `control-not-operable` finding either.
        const code = elementBlockedBy(rows, node);
        traceEvent(runId, 'retire-answered', {
          templateId: target.templateId, instanceKey, name: target.name || null,
          route: node?.route || null, rule, code: code || null, rows: rows.length,
          // The answer it kept giving — the evidence that re-asking had stopped paying.
          answer: rows.length ? `${rows[rows.length - 1].kind || '?'}:${rows[rows.length - 1].blocked || rows[rows.length - 1].verdict || '?'}` : null,
          finding: code === 'DISABLED' || code === 'NOT_FILLABLE' ? 'control-not-operable' : null,
        });
      }
    }
    // SESSION REPAIR. The act just ended the session — a Logout control, or a click onto an auth route.
    // Under explore-all these are FIRED rather than refused (that is the point of the mode), but without
    // re-authenticating here every subsequent act crawls as an anonymous user and the rest of the run
    // silently collects /login instead of the application. Measured on a pinned drain: an icon-only logout
    // at act 74 ended the run with 139 controls still owed. reconLoop has had this repair all along; the
    // stateful driver — the one explore-all actually runs — did not.
    if (outcome.needsRelogin) {
      const ok = relogin ? await relogin().catch(() => false) : false;
      steps[steps.length - 1][0].reloggedIn = !!ok;
      if (runId) traceEvent(runId, 'relogin', { after: target.templateId, name: target.name || null, ok: !!ok });
      // A failed repair is terminal on purpose: continuing logged-out poisons coverage with a second,
      // wrong surface, which is exactly the failure the SESSION LOST detector exists to make loud.
      if (!ok) { sessionLost = { requested: routeKey(page.url()), landed: routeKey(page.url()), relogin: 'failed' }; }
    }
    if (onStep) await onStep(graph);
    // The outcome goes BACK to the caller now (it used to die here). `recoverGated` needs it to say whether
    // the reopen it just bought actually delivered — see relocation-memo.mjs.
    return outcome;
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
    const rejected = [];
    for (const t of ordered) {
      const node = graph.elements[t.templateId];
      if (await resolvesLive(page, t, node)) {
        // WHY THIS ELEMENT. The comparator above just ranked every eligible control on this route and the
        // resolver just probed the top ones in order; both facts died here. `rank` IS the reason —
        // 0 a control some act revealed (with `revealedAt`, the recency that outranks an older reveal),
        // 1 ordinary page work, 2 a dismiss control held back so it cannot close what we are draining.
        // `probed` vs `outranked` separates the two ways a candidate lost: asked for a live handle and had
        // none, versus never asked because something ranked ahead of it.
        if (runId) {
          const r = rank(t);
          traceEvent(runId, 'pick', {
            route: cur,
            candidates: ordered.length,            // eligible on this route — the honest denominator
            chosen: {
              templateId: t.templateId, instanceKey: keyOf(t), name: (t.name || '').slice(0, 40),
              rank: r, rule: RANK_RULE[r], revealedAt: justRevealed.get(t.templateId) ?? null,
            },
            probed: rejected.length + 1,           // candidates the resolver was actually asked about
            outranked: Math.max(0, ordered.length - rejected.length - 1), // never asked: lost on rank
            rejected: rejected.slice(0, PICK_SAMPLE).map((x) => ({
              templateId: x.templateId, name: (x.name || '').slice(0, 40), why: 'no-live-handle',
            })),
            rejectedTotal: rejected.length,
            truncated: rejected.length > PICK_SAMPLE,
          });
        }
        return t;
      }
      rejected.push({ templateId: t.templateId, instance: t.instance, node, name: t.name, instanceKey: keyOf(t) });
    }
    // THE SCAN CAME UP EMPTY — and this is the moment the driver decides a page is finished. Until now it
    // recorded nothing at all: 107 controls on one page were rejected here on every pass of an entire run
    // and produced not one line of trail, while the outcome written next to them read `drained`. Whoever
    // read that log could not have found the hole, because the hole was the absence of writing.
    // Bounded and dry-path-only, so the hot loop is untouched.
    if (runId && rejected.length) {
      const c = await census(page, rejected, { seen: censusSeen }).catch(() => null);
      if (c) traceEvent(runId, 'pick-empty', { route: cur, candidates: ordered.length, ...c });
    }
    return null;
  };

  // Drain the CURRENT route to fixpoint: act every unexplored candidate that RESOLVES on the live DOM,
  // re-evaluating after each act (a reveal's fresh controls are picked up), until none resolves OR an
  // act NAVIGATED to another page. Returns whether we left the route (the "went to page 2" move).
  const drainRoute = async (budget = Infinity) => {
    const cur = routeKey(page.url());
    const startedAt = steps.length;
    while (steps.length < maxActs) {
      if (routeKey(page.url()) !== cur) return 'navigated';
      // BREADTH BUDGET. Draining a route to fixpoint before ever pulling from the route queue is a pure
      // depth-first discipline, and on a real application the queue then never gets a turn: measured on the
      // live target, 49 routes discovered, THREE visited, 46 still pending after a full run — one page
      // alone still had 49 unexplored controls, and every page behind it waited forever. The coverage
      // percentage was computed over a denominator built almost entirely from one page, which is a
      // statement about the crawler's appetite, not about the application.
      // Yielding here does NOT abandon the route: it stays in routesWithWork and the backtrack pass returns
      // to it. Termination is unaffected — 'budget' is not 'drained', and the loop only claims drained when
      // BOTH the candidate frontier and the route queue are empty.
      if (steps.length - startedAt >= budget) return 'budget';
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
          // DO NOT CONCEDE A ROUTE AT ITS MOST PRODUCTIVE MOMENT. Fresh work exists and does not resolve
          // YET — which is the normal condition a few hundred ms after an opener mounts a modal, not
          // evidence that the route is spent. Conceding here returned 'drained' straight into the main
          // loop's navigate-away, so the modal's interior was abandoned the instant it appeared: measured
          // in one run at acts 374, 382, 405, 475, 530 and 554, each "opener reveals modal → 1-3 acts →
          // nothing resolves → route left", and 45 of that run's 101 navigations carried ZERO acts.
          // Let the mount/animation finish and ask once more. BOUNDED by construction: settleAnimations
          // is itself bounded, this runs at most once per dry pick, and a still-dry re-ask falls through
          // to the same honest stop as before — so a template that never resolves cannot spin here.
          if (freshLeft) {
            await settleAnimations(page);
            picked = await pickLive(cur);
            if (!picked) return 'drained'; // asked twice, still nothing → honest stop, keep state
          }
        }
        // Only reach for the overlay dismissal when the settle re-ask above found nothing. Falling through
        // with a live pick would close the very modal we just waited for and discard the pick with it.
        if (!picked) {
          if (!(await dismissBlockingOverlay(page))) return 'drained';
          resetTrackerVerdicts(page);
          justRevealed = new Map();      // the overlay is gone; nothing is "fresh" behind it any more
          picked = await pickLive(cur);
          if (!picked) return 'drained';
        }
      }
      await runAct(picked);
    }
    return 'drained'; // act budget hit → the main loop stamps 'budget'
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
  // RECOVER-THEN-ACT — the largest single class of unfinished work in this project's graphs.
  //
  // A control revealed by an opener (a modal's field, a dropdown's item) resolves ONLY while its container
  // is open. The opener drains after one act (frontier.mjs instanceDrained), and `pickLive` can only choose
  // what resolves RIGHT NOW — so once the driver leaves the route the container closes and the child is
  // permanently unpickable. Measured on a full graph: 112 of 133 outstanding obligations sat behind a
  // drained opener, 51 of them on a single route. They were not blocked, not unreachable, and not
  // undiscovered — nothing could ask them.
  //
  // `reopenContainer` already solved the hard half and its answer was thrown away: retireLeftovers called
  // it, used `ok` only as "do not retire", and returned control to the main loop, which navigated away.
  // The reopened state was discarded every time — not retired because reopen proved it reachable, never
  // acted because the loop left. A livelock that reads as steady progress.
  //
  // So: reopen and ACT, while the container is open. Bounded three ways — a per-visit budget, one attempt
  // per instance (`attempted`), and the global act ceiling — because each recovery costs a navigation plus
  // its replay hops. Under explore-all those hops are real clicks, so the ownership rail inside
  // reopenContainer is what keeps this honest; it is not relaxed here.
  const REOPEN_BUDGET = 12;
  const recoverGated = async (cur, budget = REOPEN_BUDGET) => {
    const sameRoute = (r) => r === cur || routeAlias.get(r) === cur;
    // `attempted` USED TO BE DECLARED HERE, and that one line cost half of every pinned run: the set died
    // with the call, so each drained visit re-attempted the same hopeless targets from zero. Measured —
    // 228 attempts over 31 unique targets, six of them retried 18-19 times, 340s of 675s (50.4%) spent
    // re-buying failures already paid for. The memo is created ONCE per run (see `relocMemo` above) and
    // only ever remembers FAILURES, so a target that legitimately needs reopening twice still can.
    let recovered = 0;
    for (let i = 0; i < budget && steps.length < maxActs; i++) {
      let target = null;
      for (const t of candidates(graph)) {
        if (!sameRoute(t.route)) continue;
        if (!relocMemo.shouldAttempt(t.templateId, keyOf(t))) continue;
        const node = graph.elements[t.templateId];
        // Cheap test first: only a control with a recorded way back is recoverable at all.
        if (!(t.instance?.reveal?.statePath || node?.reveal?.statePath || []).length) continue;
        // Anything that resolves live is drainRoute's job, not ours — never act the same target twice.
        if (await resolvesLive(page, t, node)) continue;
        target = t; break;
      }
      if (!target) break;
      const re = await reopenContainer(page, graph, target, { origin, marker, runCreatedAccount }).catch(() => null);
      // PHASE 1 of the record: the reopen returned. NOT yet a success — see relocation-memo.mjs for the
      // eight `reopen{ok:true}` → `act.failed NO_INSTANCE` pairs this two-phase shape exists to stop
      // reporting as a 100% success rate.
      const settleReopen = relocMemo.record(target.templateId, keyOf(target), !!(re && re.ok), re?.code || 'REOPEN_THREW');
      // The trail could not previously explain page movement here: reopenContainer navigates with no event
      // of its own, so the page changed routes between two acts and events.ndjson was silent. Per the
      // project's log rule that is a defect to fix, not to work around — and it is exactly the mechanism
      // this change makes load-bearing, so it must be auditable.
      if (runId) {
        traceEvent(runId, 'reopen', {
          templateId: target.templateId, instanceKey: keyOf(target), name: target.name || null,
          route: cur, ok: !!(re && re.ok), code: re?.code || 'REOPEN_THREW', hops: re?.hops?.length ?? null,
          // Which rung of the relocation ladder paid — 'in-place' (zero navigation) vs 'reload-replay'.
          rung: re?.rung || null,
          // WHICH HOP DIED, AND HOW FAR WE GOT. Without these the trail carried one code for every cause
          // and no consumer could tell a stale breadcrumb from a genuinely vanished control.
          failedHop: re?.failedHop || null,
          hopsResolved: re?.hopsResolved ?? null,
          hopsTotal: re?.hopsTotal ?? null,
          attemptsTried: re?.attemptsTried ?? null,
        });
      }
      if (!(re && re.ok)) continue;   // honest failure: it stays in the frontier for retireLeftovers to judge
      // PHASE 2. The `finally` is the crash guard: any throw on the act path still closes the entry, and it
      // closes it as UNRESOLVED (outcome stays null) rather than letting a silent lie default to success.
      let outcome = null;
      try {
        outcome = await runAct(target);
      } finally {
        const delivered = !!(outcome && !outcome.error);
        settleReopen(delivered, outcome?.errorCode ? `REOPEN_ACT_${outcome.errorCode}` : null);
        // WHAT THE REOPEN ACTUALLY BOUGHT. The `reopen` event above is emitted BEFORE the act — it must be,
        // since it explains the page movement that precedes it — so on its own it can only ever report the
        // relocation's own verdict. This is the other half, and it is the half that was missing: without it
        // a reader summing `reopen{ok:true}` concludes the mechanism works on every consumer's evidence.
        if (runId) {
          traceEvent(runId, 'reopen-delivered', {
            templateId: target.templateId, instanceKey: keyOf(target), name: target.name || null,
            route: cur, delivered, code: outcome?.errorCode || null,
            error: delivered ? null : (outcome?.error || 'ACT_THREW'),
          });
        }
      }
      recovered++;
    }
    return recovered;
  };

  const retireLeftovers = async (cur, final) => {
    // WHAT THIS PASS DECIDED ABOUT EACH LEFTOVER, and it decided something about every one of them: a
    // vanished feed row is CHURN (quantified, drained, never counted unreachable), a vanished control with
    // no live representative is an honest gap, and one whose route has revisits left is DEFERRED rather
    // than written off. Three different verdicts, all of them previously invisible — the graph kept the
    // outcome, the trail kept nothing, so "why was this control never touched" could not be answered from
    // the run at all. Counts are EXACT; only the per-control list is capped.
    const tally = { reachable: 0, reopened: 0, churned: 0, unreachable: 0, deferred: 0 };
    const sample = [];
    const note = (t, verdict) => { if (sample.length < RETIRE_SAMPLE) sample.push({ templateId: t.templateId, name: (t.name || '').slice(0, 40), verdict }); };
    for (const t of candidates(graph)) {
      if (t.route !== cur) continue;
      if (await resolveHandle(page, t.instance, graph.elements[t.templateId])) { tally.reachable++; continue; } // still reachable
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
        if (re && re.ok) { tally.reopened++; continue; } // back inside; the frontier will hand it out again
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
        tally.churned++; note(t, 'churned');
      } else if (final) {
        markInstanceExplored(graph, t.templateId, keyOf(t));
        markInstanceUnreachable(graph, t.templateId, keyOf(t), 'NO_INSTANCE_on_live_route');
        tally.unreachable++; note(t, 'unreachable');
      } else {
        // Counting only — the control is deliberately left in the frontier, exactly as before. What is new
        // is that the trail now says so, instead of a leftover simply not appearing anywhere.
        tally.deferred++; note(t, 'deferred');
      }
    }
    if (runId) {
      const judged = tally.reachable + tally.reopened + tally.churned + tally.unreachable + tally.deferred;
      traceEvent(runId, 'retire', {
        route: cur,
        final,                    // the route is out of revisits: nothing later will re-open its states
        rule: final ? 'final-pass' : 'revisits-remain',
        judged, ...tally,
        sample, sampleTotal: tally.churned + tally.unreachable + tally.deferred,
        truncated: (tally.churned + tally.unreachable + tally.deferred) > RETIRE_SAMPLE,
      });
    }
  };

  // In-session navigation to a backtrack route (session/cookies preserved — NOT a per-act cold reset):
  // SSRF-gated gotoGated, settle, dismiss overlays + reset the load-burst's stale verdicts (both under
  // __idle__, edge-free), then snapshot the landed page so its controls are current for the next drain.
  const goToRoute = async (rk) => {
    // WHERE THE RUN'S TIME ACTUALLY GOES. Attributing every inter-event gap to the event that follows it,
    // across two audited runs: `route` events carried 68.6% (1032s of 1504s) and 74.9% (1645s of 2196s) of
    // wall time — and explained NONE of it, because `payload.timings` was undefined on 1200 of 1200 route
    // events. The act path is ~78% self-explained by the timings step.mjs already emits; the navigation
    // path was 0%. So "613 of 663 navigations produced neither an act nor a single new element" could be
    // counted and never diagnosed. Per the project's log rule that is a defect in the trail itself.
    //
    // Field names and shape MIRROR step.mjs's act timings ({actMs, settleMs, snapMs}) on purpose, so one
    // renderer draws an act row and a route row; `settleMs`/`snapMs` carry the same meaning in both.
    //
    // REPORTING ONLY, NEVER ATTRIBUTION. performance.now() is a Node-side clock read: it opens no causal
    // window, issues no page request, and adds no evaluate/screenshot/CDP call. Causal attribution stays
    // the in-page token AND the CDP initiator classifier — a wall-clock window must never feed it.
    const tTotal = performance.now();
    lastTravelled = rk;   // credited/blamed for what the following drain achieves
    const tGoto = performance.now();
    await gotoGated(page, new URL(rk, origin).href);
    const gotoMs = Math.floor(performance.now() - tGoto);
    const tSettle = performance.now();
    await waitSettled(page);
    const settleMs = Math.floor(performance.now() - tSettle);
    // resetTrackerVerdicts is FOLDED INTO overlayMs rather than given a field of its own: it is a
    // synchronous in-process Map lookup with no page I/O (never a measurable stage), and it belongs to the
    // same "clear what the load burst left behind before we look" preparation as the overlay sweep. Folding
    // it here also keeps `snapMs` meaning exactly what it means in step.mjs — the snapshot and nothing else.
    const tOverlay = performance.now();
    await dismissOverlays(page);
    resetTrackerVerdicts(page);
    const overlayMs = Math.floor(performance.now() - tOverlay);
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
    // SESSION LOSS IS NOT AN ALIAS. A redirect to the sign-in page means the crawl is no longer
    // authenticated, and every subsequent navigation will land there too. Run goal1 clicked an icon-only
    // logout at act 220 and then sent 124 of its remaining 174 navigations to /login, collecting nothing
    // from any of them — while the round ledger went on reporting rising coverage, because "landed
    // somewhere" and "landed where we asked" were recorded identically. Treating it as an alias is worse
    // than useless: it would map the requested route ONTO /login permanently.
    // Detect it, say so in the trail AND on stderr, and stop — a logged-out crawl cannot be salvaged by
    // continuing, and the operator needs to know the run ended for this reason rather than reading a
    // coverage number produced by a login page.
    if (isAuthLanding(landed) && !isAuthLanding(rk)) {
      sessionLost = { requested: rk, landed };
      const msg = `SESSION LOST: requested ${rk} but landed on ${landed} — the crawl is logged out; every further navigation would collect the sign-in page. Re-mint the storage state and re-run.`;
      console.error(`\n  !! ${msg}\n`);
      if (runId) traceEvent(runId, 'session-lost', { requested: rk, landed, message: msg });
      return;
    }
    if (landed !== rk) {
      routeAlias.set(rk, landed);
      // The page we ACTUALLY stood on must stop being 'pending', or the route frontier reports the
      // best-covered page in the run as never visited — measured: the landing page sat `pending: true`
      // after 78 landings on it. That is a denominator lie, not just a scheduling one.
      markRouteVisited(graph, landed);
    }
    const tSnap = performance.now();
    const snap = await snapshotStep(page, graph, ledger, landed);
    const snapMs = Math.floor(performance.now() - tSnap);
    // totalMs is the function's own wall time to the point of emission, NOT the sum of the parts. The
    // difference is unaccounted work (the URL build, routeKey, the alias / markRouteVisited bookkeeping,
    // and any await scheduling between stages) and keeping it VISIBLE is the point — a summed total would
    // report zero unaccounted time by construction and hide exactly what this instrumentation is for.
    // The parts floor while the total rounds, so `totalMs >= gotoMs + settleMs + overlayMs + snapMs` holds
    // by construction rather than by luck: four independently-rounded parts can otherwise out-total a
    // rounded whole by up to 2ms and make the trail claim negative unaccounted time.
    // Only the trailing `onStep` callback falls outside it — that is the caller's own work, not navigation.
    const totalMs = Math.round(performance.now() - tTotal);
    // The trail records BOTH now. Recording only the landed route is why 651 barren navigations could not
    // be diagnosed from the trail at all — it could not answer "where did it try to go, and what happened".
    if (runId) { const seq = traceEvent(runId, 'route', { route: landed, requested: rk, redirected: landed !== rk, ...snap, backtrack: true, timings: { gotoMs, settleMs, overlayMs, snapMs, totalMs } }); snapshotGraph(runId, seq); }
    if (onStep) await onStep(graph);
  };

  // Take the next route off the BFS queue, skipping ones already retired / refused. The ONE place the
  // queue is drained — both the breadth-yield (a route still has work but has had its turn) and the
  // drained path (the current route has nothing resolvable left) go through it, so they can never disagree
  // about what "queued" means. Both now consult it BEFORE falling back to a with-work route: they used to
  // disagree about the ORDER, and because the drained path dominates the decision (measured on hunt3: 39
  // `drained` outcomes against 2 `budget`), the inverted one was the crawl's effective breadth policy.
  // markRouteVisited clears `pending` BEFORE we travel, so each queued route is attempted exactly once and
  // neither caller can spin on it — every call strictly shrinks the queue, including for a route it
  // rejects.
  // WHICH ROUTE NEXT. Both pickers used `.find(...)` over `routesWithWork`, which returns its set SORTED —
  // so the destination was chosen by ALPHABETICAL POSITION, never by how much work a route holds or how
  // often it had already had a turn. Measured: 11 distinct routes received a driver navigation while 14
  // held untouched work; two settings routes holding 25 untouched controls sorted near the end of the list
  // and got ZERO navigations for the whole run. 15 of 16 depth-3/4 elements were untouched for the same
  // reason — the tail of the alphabet is where nested routes live.
  // Least-visited-first, ties broken by the old ascending key so the walk stays deterministic and
  // resumable. This is fair-share over ROUTES, the same argument as ROUTE_ACT_BUDGET is over acts.
  // Returns { route, withWork, eligible, rejected } — the SAME choice as before (the four conditions are
  // unchanged and still conjunctive; the chain below just names which one failed first), plus the set it
  // was made over. Nothing here reads the page: `routesWithWork` is a graph scan and every filter is a
  // Set/Map lookup, so making the census visible costs no DOM work and opens no causal window.
  const pickRoute = (cur, skipRefused) => {
    const withWork = routesWithWork(graph);
    const eligible = [];
    const rejected = [];
    for (const r of withWork) {
      let why = null;
      if (r === cur) why = 'current';                              // we are standing on it
      else if (landsOn(r) === cur) why = 'lands-here';             // it redirects to where we already are
      else if (exhausted.has(r)) why = 'exhausted';                // stall guard retired it
      else if (isBarren(r)) why = 'barren';                        // consecutive fruitless visits
      else if (skipRefused && routeRefused(r)) why = 'danger-route';
      if (why) rejected.push({ route: r, why }); else eligible.push(r);
    }
    let best = null;
    for (const r of eligible) if (best === null || (visits.get(r) || 0) < (visits.get(best) || 0)) best = r;
    return { route: best, withWork: withWork.length, eligible, rejected };
  };

  // WHY THIS ROUTE, AND WHY WORK ON THE LAST ONE ENDED. One line per destination decision, at every site
  // that takes one — so a run that spends 613 of 663 navigations on pages that yield nothing can be read
  // back rule by rule instead of inferred from the gaps between `route` events.
  //   trigger  — what ended work on the page we are leaving: 'budget' (the breadth quantum was spent while
  //              the route still held work), 'drained' (nothing resolvable left), 'pinned-return' (an act
  //              moved a pinned run off its page).
  //   source   — where the destination came from: 'queue' (BFS, a page never opened), 'with-work' (a route
  //              still holding unexplored controls), 'pinned', or 'none' (nowhere to go).
  //   censused — whether the with-work set was enumerated at all. On the queue path `pickRoute` is never
  //              called, so its rejection census genuinely does not exist; saying so beats emitting nulls
  //              that read as "nothing was rejected".
  //   blockedBy— a destination was chosen and NOT travelled to, and which ceiling stopped it.
  const traceRouteChoice = ({ trigger, from, source, pick = null, chosen = null, travelled, blockedBy = null }) => {
    if (!runId) return;
    const rejected = pick ? pick.rejected : [];
    traceEvent(runId, 'route-choice', {
      trigger, from, source,
      rule: source === 'with-work' ? 'least-visited' : (source === 'queue' ? 'bfs-queue' : null),
      chosen,
      visitsOfChosen: chosen ? (visits.get(chosen) || 0) : null,
      travelled, blockedBy,
      censused: !!pick,
      withWork: pick ? pick.withWork : null,
      eligible: pick ? pick.eligible.length : null,
      rejected: rejected.slice(0, ROUTE_SAMPLE),
      rejectedTotal: rejected.length,
      truncated: rejected.length > ROUTE_SAMPLE,
      backtracks, maxBacktracks: MAX_BACKTRACKS,
    });
  };

  const takeQueuedRoute = (cur) => {
    const skipPending = !exploreAllArmed(process.env);
    for (;;) {
      const rk = nextPendingRoute(graph);
      if (!rk) return null;
      markRouteVisited(graph, rk);
      if (rk !== cur && !exhausted.has(rk) && !(skipPending && routeRefused(rk))) return rk;
    }
  };

  while (true) {
    if (sessionLost) { stopped = 'session-lost'; break; }
    if (steps.length >= maxActs) { stopped = 'budget'; break; }
    // Key the fruitfulness on the route we TRAVELLED TO (`lastTravelled`), not the one we happen to be
    // standing on. Those differ exactly when the app REDIRECTS: measured on a write-mode run, eight
    // consecutive navigations to the same landing page, ~25s each and not one act between them, because
    // the requested route kept redirecting and the counter kept crediting the landing page instead of the
    // route that could not be opened. Fall back to the live route for the very first pass.
    const visited = lastTravelled || routeKey(page.url());
    const actsBefore = steps.length;
    const outcome = await drainRoute(ROUTE_ACT_BUDGET);
    // Fruitful or fruitless? Counted per VISIT, so a route that acts even once is fully rehabilitated.
    if (steps.length > actsBefore) barren.set(visited, 0);
    else barren.set(visited, (barren.get(visited) || 0) + 1);
    lastTravelled = null;
    if (steps.length >= maxActs) { stopped = 'budget'; break; }
    // WHY THE DRIVER DID WHAT IT DID NEXT. The trail recorded acts and routes but never the DECISION between
    // them, so "why did it leave a page with 88 recoverable controls" was unanswerable from the trail alone —
    // exactly the class of log defect this project treats as a defect in its own right. One line per drain.
    if (runId) {
      traceEvent(runId, 'drain-outcome', {
        route: visited, outcome, acts: steps.length - actsBefore,
        barren: (barren.get(visited) || 0), visits: visits.get(visited) || 0,
      });
    }
    // PINNED: an act moved the page. In breadth mode that is a discovery to follow; here it is a departure
    // to undo, because the page we are proving is this one. Come back and keep working it.
    if (pinnedRoute && routeKey(page.url()) !== pinnedRoute) {
      const here = routeKey(page.url());
      if (backtracks >= MAX_BACKTRACKS) {
        traceRouteChoice({ trigger: 'pinned-return', from: here, source: 'pinned', chosen: pinnedRoute, travelled: false, blockedBy: 'max-backtracks' });
        stopped = 'stalled'; break;
      }
      traceRouteChoice({ trigger: 'pinned-return', from: here, source: 'pinned', chosen: pinnedRoute, travelled: true });
      backtracks++;
      visits.set(pinnedRoute, (visits.get(pinnedRoute) || 0) + 1);
      await goToRoute(pinnedRoute);
      continue;
    }
    if (outcome === 'navigated') continue;   // an act moved us to a new page → drain it next

    // BREADTH YIELD: this route still has work, but it has had its turn. Give the route QUEUE a turn
    // before returning to it, so pages discovered-but-never-opened stop waiting behind a rich page's
    // long tail. If the queue is empty there is nothing to interleave with, so we simply keep draining
    // (the next drainRoute call gets a fresh budget) — no spin, because every pass either acts (steps
    // grows toward maxActs) or falls through to the drained path below.
    if (outcome === 'budget') {
      // PINNED: there is nobody to yield TO. The breadth budget exists to stop one rich page starving the
      // route queue; with a pinned route that queue is deliberately out of scope, so spending the budget
      // and continuing on the spot is the whole intent rather than the starvation it would otherwise be.
      if (pinnedRoute) continue;
      // YIELD TO SOMEONE, or the budget is decorative. The first version only consulted the pending QUEUE
      // and fell through to `continue` when it was empty — which re-entered drainRoute with a FRESH budget
      // on the same route. Audited on run goal2: runs of 38 and 37 consecutive acts on one route under a
      // declared budget of 20, and the number of distinct routes acted on went DOWN (28 → 25). The budget
      // was being spent and then immediately refunded.
      // So the yield has two candidates, in order: a page never visited (the queue), else another route
      // that still holds unexplored controls. Only when NEITHER exists — this is the sole route with work —
      // is continuing on the spot correct, and then it is not starvation, there is nowhere else to go.
      const cur = routeKey(page.url());
      const skipRefused = !exploreAllArmed(process.env);
      let target = takeQueuedRoute(cur);
      let source = target ? 'queue' : 'none';
      let pick = null;
      if (!target) {
        pick = pickRoute(cur, skipRefused);
        target = pick.route;
        source = target ? 'with-work' : 'none';
      }
      const willTravel = !!(target && backtracks < MAX_BACKTRACKS);
      traceRouteChoice({
        trigger: 'budget', from: cur, source, pick, chosen: target, travelled: willTravel,
        blockedBy: target && !willTravel ? 'max-backtracks' : null,
      });
      if (willTravel) {
        backtracks++;
        visits.set(target, (visits.get(target) || 0) + 1);
        await goToRoute(target);
      }
      continue;
    }

    // Current route is drained (no resolvable-unexplored). Retire its leftovers, then BACKTRACK to the
    // lowest-keyed route that still has work — the operator's "go back and finish the unfinished page".
    const cur = routeKey(page.url());
    // RECOVER BEFORE RETIRING. "Nothing resolves on this route" is the normal state of a page whose work
    // lives inside closed containers — it is not evidence the page is finished. Reopen those containers and
    // act what they hold; only what survives that gets judged by retireLeftovers. Recovering ≥1 means the
    // page just yielded new state, so go round again rather than navigating away from a page that is
    // actively producing.
    if (await recoverGated(cur) > 0) continue;
    // Retire only when this route is genuinely spent: it has been revisited to the ceiling, so no further
    // pass will surface a new state for its leftovers. Otherwise leave them in the frontier.
    await retireLeftovers(cur, (visits.get(cur) || 0) >= MAX_REVISITS);
    // PINNED TERMINAL. Nothing resolves, recovery found nothing to reopen, and leftovers have been judged —
    // this page is done as far as the driver can take it. Retire with final=true (no later pass will open a
    // new state for it, because there is no later pass) and stop, rather than falling through to a route
    // hunt that pinning exists to skip. `page-drained` is a DIFFERENT claim from 'frontier-drained': it is
    // scoped to one route and says nothing about the rest of the application.
    if (pinnedRoute) {
      await retireLeftovers(cur, true);
      // SAY WHAT IS LEFT, OR DO NOT CLAIM DRAINED. The previous version stamped `page-drained`
      // unconditionally — measured, it wrote `stopped: "page-drained"` on a run that still held 95
      // unexplored candidates, and 228 of them on the run before that. "Drained" and "I stopped" were
      // recorded identically, so the run's own summary was the last place the hole could be seen, and it
      // hid it. docs/GOAL.md: done means the obligation list is empty with nothing in an uncounted bucket.
      //
      // A residue is not a failure — a control whose container genuinely cannot be reopened is honestly
      // unreachable. What is forbidden is calling that "drained". So: count what remains on this route and
      // pick the label the evidence supports, then write the residue into the trail either way.
      const residue = candidates(graph).filter((t) => t.route === cur || routeAlias.get(t.route) === cur);
      stopped = residue.length === 0 ? 'page-drained' : 'page-residue';
      if (runId) {
        traceEvent(runId, 'page-terminal', {
          route: cur, outcome: stopped, residue: residue.length,
          sample: residue.slice(0, 10).map((t) => ({ templateId: t.templateId, name: (t.name || '').slice(0, 40) })),
        });
      }
      break;
    }
    // The backtrack route gate lifts under explore-all, mirroring persistentStep's navigation gate.
    // Otherwise the stateful driver would never backtrack to a danger route and would strand every
    // control that only lives there — the same coverage loss the mode exists to remove.
    const skipRefused = !exploreAllArmed(process.env);
    // THE WITH-WORK CENSUS IS COMPUTED FIRST AND CONSULTED SECOND. Computing it here costs nothing that
    // could perturb the crawl — `pickRoute` is a graph scan over Set/Map lookups, it reads no page, opens
    // no causal window and MUTATES NOTHING — and the trail needs it precisely BECAUSE the queue now wins:
    // "which pages holding untouched controls did we walk past, and why" is the substance of every
    // queue-first decision, and dropping the census would make the dominant path the one with no record.
    const pick = pickRoute(cur, skipRefused);
    // ROUTE-FRONTIER DRAIN, BEFORE the with-work fallback — the SAME order the breadth yield above uses,
    // for the same measured reason, and the two paths disagreeing about it is what this fixes.
    //
    // `routesWithWork` can only ever name routes we already hold CONTROLS for, so a page the crawl has not
    // stood on yet is invisible to it — which is how a run reached "everything reachable is collected"
    // having never queued /groups, /events, /nuggets or /setting. Consulting it FIRST meant the driver
    // structurally preferred a page it had already been to: measured on run hunt3 (200 acts, stateful +
    // explore-all), 30 of 35 route transitions were `least-visited` re-visits and only 5 came off the
    // queue, while 53 routes — 52 of them DISTINCT first-segment sections, not variants of a page already
    // seen — were still pending when the budget ran out. 33 of those navigations produced no act at all
    // (`pick-empty`), 16 on profile pages and 12 on the dashboard. The drained path dominates the
    // decision (39 `drained` outcomes against 2 `budget`), so its ordering IS the crawl's breadth policy.
    //
    // A never-opened page is worth more than another pass over a drained one: this branch only runs when
    // the CURRENT route has nothing resolvable left, so nothing productive is being abandoned, and a
    // with-work route keeps its unexplored controls in the frontier and is returned to once the queue
    // empties. Nothing here weakens a gate: `takeQueuedRoute` applies the SAME routeRefused skip (armed by
    // exploreAllArmed, never agent-settable) and `goToRoute` the same SSRF-gated gotoGated.
    //
    // markRouteVisited clears `pending` BEFORE we travel, so each queued route is attempted exactly once
    // and this cannot spin — the queue strictly shrinks on every call.
    const queued = takeQueuedRoute(cur);
    if (queued) {
      const willTravel = backtracks < MAX_BACKTRACKS;
      traceRouteChoice({
        trigger: 'drained', from: cur, source: 'queue', pick, chosen: queued,
        travelled: willTravel, blockedBy: willTravel ? null : 'max-backtracks',
      });
      if (willTravel) {
        backtracks++;
        visits.set(queued, (visits.get(queued) || 0) + 1);
        await goToRoute(queued);
        continue;
      }
      // The ceiling vetoed a destination we HAD. That is a stop, not a drain — claiming 'frontier-drained'
      // with a route still queued would be the coverage lie this project keeps finding in its own trails.
      // Retire this route's leftovers final=true for the same reason the terminal below does: no later pass
      // exists to open a new state for them.
      await retireLeftovers(cur, true);
      stopped = 'stalled';
      break;
    }
    const next = pick.route;
    if (!next) {
      // TERMINAL: the queue is empty (takeQueuedRoute just returned null) AND no route holds work, so no
      // future pass can open a new state for this route's leftovers either. Retire them NOW with
      // final=true — otherwise a deferred leftover would sit in the frontier forever and `remaining` could
      // never reach 0 (the honest terminator would never fire).
      traceRouteChoice({ trigger: 'drained', from: cur, source: 'none', pick, chosen: null, travelled: false });
      await retireLeftovers(cur, true);
      stopped = stalled ? 'stalled' : 'frontier-drained';
      break;
    }
    // Both ceilings that can veto the destination just chosen, named BEFORE either is applied — a route
    // retired by the stall guard is the single most common way a control ends the run untouched, and until
    // now that retirement happened silently (`exhausted.add`, no event, and the route simply stopped being
    // offered ever again).
    const blockedBy = backtracks >= MAX_BACKTRACKS ? 'max-backtracks'
      : ((visits.get(next) || 0) + 1 > MAX_REVISITS ? 'max-revisits' : null);
    traceRouteChoice({
      trigger: 'drained', from: cur, source: 'with-work', pick, chosen: next,
      travelled: !blockedBy, blockedBy,
    });
    if (backtracks >= MAX_BACKTRACKS) { stopped = 'stalled'; break; }
    backtracks++;
    visits.set(next, (visits.get(next) || 0) + 1);
    if (visits.get(next) > MAX_REVISITS) { exhausted.add(next); stalled = true; continue; } // stall guard
    await goToRoute(next);
  }

  // The relocation census goes OUT, not just into a counter nobody reads: `refusedRepeat` is the direct
  // measure of what the run no longer wastes, and if it ever reads 0 alongside a high `attempted`, the
  // memo has been re-scoped back inside the pass and the 50% regression is silently back.
  if (runId) traceEvent(runId, 'reloc-census', relocMemo.stats());
  return { steps, stopped: stopped || 'frontier-drained', stats: frontierStats(graph), reloc: relocMemo.stats() };
}
