// stateful-step — the IN-SESSION recon step (the operator's actual loop). Where
// persistentStep (recon-run.mjs) re-navigates the page COLD before every act and then brittly
// reconstructs revealed state via reveal-replay, this step acts on the LIVE, already-accumulated
// page WITHOUT any re-navigation. State ACCUMULATES: an act that opens a modal/dropdown/panel
// leaves it open, so the post-act snapshot merges its contents as NEW templates/instances and
// the frontier hands them out next round — naturally reaching every revealed control at depth,
// no reveal-path replay needed. This is why coverage is incomplete on any site under the cold
// path: statelessness loses a modal/dropdown/feed the instant the act ends.
//
// CAUSAL DISCIPLINE (identical to persistentStep, minus the re-nav): the ONE causal window is
// actStep's beginCause→click→endCause, unchanged. resetTrackerVerdicts BEFORE each act clears
// the previous act's sticky path verdicts (the reused-page discipline cross-act.test guards — an
// earlier act's foreground path must not suppress a later act's same-path poll rejection). The
// post-act snapshotStep opens NO causal window (pure DOM read + graph merge), so attribution stays
// exactly as actStep produced it. actStep also carries the PRE-CLICK danger-floor + off-origin
// guards on the LIVE handle (DANGER_FLOOR / NO_INSTANCE / NOT_VISIBLE / external), so those guards
// are mirrored by DELEGATION, not duplicated.
//
// FIRST stateful increment: GREEDY in-session reach until the frontier drains. It does NOT yet
// BACKTRACK — once an act closes/replaces a sibling's state (a modal that swaps the page, a
// dropdown that collapses another), the sibling is only reachable by re-opening its own path,
// which this increment does not replay. Nor does it navigate to routes discovered off the baseline
// (the route-frontier's cold visits would hand this step controls that do not resolve on the live
// page). Both are the NEXT increment; see the recon-run report note.

import { markInstanceExplored, saveGraph } from '../graph/graph-store.mjs';
import { resetTrackerVerdicts, waitSettled } from '../browser/causal.mjs';
import { snapshotStep, actStep } from './step.mjs';
import { routeKey, sameOrigin } from './scope.mjs';
import { gotoGated } from '../browser/session.mjs';
import { dismissBlockingOverlay } from './overlay-dismiss.mjs';
import { makeCapture, traceEvent, snapshotGraph } from '../debug/trace.mjs';
import { resolveHandle } from './resolve-handle.mjs';
import { fieldsFor, looksLikeSubmit } from './form-fill.mjs';
import { attachPageSignals, readOutcome, wasRefused, announcedSuccess, liveRegionTexts } from '../browser/observables.mjs';
import { verdictOf } from './knowledge.mjs';
import { classifyEndpoint } from './endpoint-class.mjs';
import { isDismissControl } from './danger-floor.mjs';

// Build the in-session step reconLoop drives. Acts on the target's instance on the CURRENT live
// page (no cold re-nav, no reveal replay), then re-snapshots the live page so whatever the act
// revealed merges into the graph. baselineUrl is the in-scope URL we recover to if a JS onclick
// strands the page off-origin — the ONE re-navigation stateful mode keeps (exceptional recovery,
// never a per-act cold nav). Mutates graph + ledger, mirroring persistentStep's contract.
// EXPLORE-ALL threading (2026-07-18): all four fields are load-bearing, not optional polish.
//   exploreAll        — without it step.mjs falls through to the `REFUSED.has(floor)` arm and silently
//                       reinstates the destructive/auth/payment refusals the mode exists to remove.
//   stateDir          — the restore journal is gated on it; absent, a foreign edit commits with NO
//                       rollback captured, which is strictly worse than not editing at all.
//   marker            — `ownsTarget(handle, null)` returns false immediately, so WITHOUT it content this
//                       run created reads as FOREIGN and loses full rights.
//   runCreatedAccount — gates account deletion.
export function statefulStep({ page, origin, baselineUrl, ledger, runId, graphPath, exploreAll, stateDir, marker, runCreatedAccount }) {
  // LOCATION-HONESTY provenance (NOT replay). Stateful mode reaches a revealed control by ACCUMULATED
  // in-session state, not by replaying a path, so the breadcrumb below is a REPORTING signal only: the
  // ordered opener hops acted since the last navigation. It is stamped stateful:true (via actStep's
  // statefulProvenance) so a consumer tells it from a replayable stateless reveal — nothing replays it,
  // hence the stamp is method-agnostic.
  // RESET BY ROUTE: on a constant-URL SPA (onClick nav, URL never changes) the chain accumulates
  // the WHOLE session, restoring the distinct locationKeys the report otherwise collapses to one; a multi-
  // URL app resets the chain per navigation. Accepted residual: the breadcrumb is ORDER-DEPENDENT and an
  // over-approximation — a control reachable by two accumulated paths records only the first, and the chain
  // is every in-place act since nav, not a minimized path. That is fine: it is provenance, not a route.
  // Buffer console errors / page errors / dialogs for the whole session. Idempotent per page, and the
  // dialog handler is load-bearing rather than diagnostic: an unhandled confirm() blocks every subsequent
  // Playwright command, so without this a single confirmation dialog freezes the crawl outright.
  attachPageSignals(page);

  let chain = [];        // accumulated in-session opener breadcrumb since the last navigation
  let chainRoute = null; // the route the chain belongs to; a route change resets it
  // RECORD WHAT THE ACT TAUGHT US. Until now an act updated `explored` and nothing else — so the graph knew
  // a control had been touched and never what touching it did. That is why coverage could read 67% while
  // every user flow was still at zero: the number counted effort, not knowledge.
  //
  // A probe row is that knowledge, and it is append-only: a control acted three times carries three rows,
  // and a later row never overwrites an earlier one. The verdict comes from evidence — requests, revealed
  // elements, navigation, and what the PAGE SAID (validation, framework errors, success toasts) — so
  // `rejected` finally exists as a fact distinct from `inert`. Read under `__idle__`, after the causal
  // window has closed, so it forges nothing.
  const recordProbe = async (g, target, res, { page: pg, prefill, seen, blocked }) => {
    const node = g?.elements?.[target?.templateId];
    if (!node) return;
    // AN ACT THAT FAILED STILL TAUGHT US SOMETHING, and losing it was the worst gap in the first run: the
    // only 5xx of the whole crawl (`POST /rawcaster/addfriendgroup -> 500`) came from an act that threw, so
    // it recorded NO row — the single most interesting event existed only in the trail, while the element
    // still counted as explored. A blocked row keeps it in the ladder as L-1 with its reason, which is the
    // bucket that was structurally empty before this.
    if (blocked) { (node.probes || (node.probes = [])).push({ kind: prefill && prefill.length ? 'fill-submit' : 'click', blocked, instanceKey: target.instance?.instanceKey ?? null }); return; }
    if (!res) return;
    let outcome = null;
    // `seen` is the announcement text that was ALREADY on screen before this act. Without it a toast from
    // the previous act is credited here — measured in the first run: one "Internal Server Error !" became
    // the recorded outcome of three separate acts, and the act that actually caused the 500 recorded
    // nothing. A verdict decided by what is on screen in a time window is the same fallacy the causal
    // invariant forbids on the request channel.
    try { outcome = await readOutcome(pg, { seen }); } catch { /* an observation that fails is not an act that failed */ }
    // CLASSIFY HERE — the request records carry no `class` of their own, and a verdict that reads
    // `q.class === 'write'` against an absent field silently calls every mutation a read. Measured: a real
    // `POST /rawcaster/sendfriendrequests -> 200` (a friend request genuinely sent) and
    // `POST /rawcaster/addnuggets` were both recorded as `read` because of exactly this. The classifier
    // judges by the endpoint's own verb rather than the HTTP method, which this target requires — it reads
    // over POST, so method alone says nothing.
    const requests = (res.requests || []).map((q) => {
      const urlPattern = q.urlPattern || q.url;
      return { method: q.method, urlPattern, status: q.status, class: classifyEndpoint({ method: q.method, url: q.url, urlPattern }) };
    });
    const row = {
      kind: prefill && prefill.length ? 'fill-submit' : 'click',
      verdict: verdictOf({
        requests, revealed: (res.newElements || []).length,
        navigated: !!(res.route && target.route && res.route !== target.route),
        refused: outcome ? wasRefused(outcome) : false,
        succeeded: outcome ? announcedSuccess(outcome) : false,
      }),
      instanceKey: target.instance?.instanceKey ?? null,
      requests: requests.map((q) => `${q.method} ${q.urlPattern}${q.status ? ` -> ${q.status}` : ''}`),
      revealed: (res.newElements || []).length,
      ...(prefill && prefill.length ? { filled: prefill.length } : {}),
      ...(outcome && outcome.validity.length ? { validity: outcome.validity } : {}),
      ...(outcome && outcome.frameworkErrors.length ? { errors: outcome.frameworkErrors } : {}),
      ...(outcome && outcome.liveRegions.length ? { announced: outcome.liveRegions.map((r) => r.text) } : {}),
    };
    (node.probes || (node.probes = [])).push(row);
  };

  return async (graph, target) => {
    // Record a FAILED act on the debug timeline (opt-in via runId) so the admin shows the
    // "why didn't it reach X?" cases (NO_INSTANCE / NOT_VISIBLE / DANGER_FLOOR) that reconLoop's
    // catch would otherwise swallow into markUnreachable with no trail entry.
    const recordFail = (err) => {
      if (!runId) return;
      traceEvent(runId, 'act', {
        templateId: target.templateId, instanceKey: target.instance?.instanceKey ?? null,
        name: target.name, role: target.role, route: target.route,
        error: err?.message || String(err), requests: [], revealed: 0, shots: null,
      });
    };

    // Reused page: clear the PREVIOUS act's initiator verdicts so a path it click-rooted does not
    // suppress THIS act's same-path background poll's timer-rejection (the cross-act discipline).
    resetTrackerVerdicts(page);
    let seenBefore = [];
    let prefillUsed = null;

    // Reset the provenance chain when the live route changed (a prior nav act moved us, or off-origin
    // recovery re-navigated): the accumulated breadcrumb belongs to ONE route.
    const cur = routeKey(page.url());
    if (cur !== chainRoute) { chain = []; chainRoute = cur; }
    // This act's opener hop + the reveal path to stamp on whatever it reveals (chain-so-far + this hop).
    // Hop shape MATCHES revealPathFor (reveal-replay.mjs): { templateId, instanceKey }. Built here (before
    // the try) and reused for the overlay-retry call so both actStep passes stamp the SAME path.
    const hop = { templateId: target.templateId, instanceKey: target.instance && target.instance.instanceKey };
    const revealPath = chain.concat([hop]);

    let res;
    // The ONE causal window (unchanged): beginCause→click→endCause, IN PLACE on the live page. revealPath +
    // statefulProvenance stamp the accumulated breadcrumb as PROVENANCE (stateful:true, method-agnostic) —
    // it is NOT replayed; the state is already accumulated. Location honesty, not a reach mechanism.
    const capture = runId ? makeCapture(runId, target.templateId) : undefined;
    try {
      // FORM FILL before a SUBMIT-like control. Clicking Submit on an empty form is why 13 of 16 submit
      // buttons fired nothing while being scored covered: client-side validation refused and no request
      // left the page. Filling first is a REACH mechanism — an unsubmitted form never opens its success /
      // validation-error / next-step state, and that is where the unreachable controls live.
      // Resolved BEFORE the causal window opens (a read-only page.evaluate under __idle__), so the field
      // census forges no edge; actStep then performs the fills inside the act it measures.
      let prefill;
      if (exploreAll && looksLikeSubmit({ role: target.role, name: target.name })) {
        const live = await resolveHandle(page, target.instance, graph.elements[target.templateId]);
        if (live) prefill = await fieldsFor(page, live.handle, marker);
        prefillUsed = prefill;
      }
      seenBefore = await liveRegionTexts(page);
      res = await actStep(page, graph, ledger, target, { capture, revealPath, statefulProvenance: true, exploreAll, stateDir, marker, runCreatedAccount, runId, prefill: prefill && prefill.length ? prefill : undefined });
    } catch (err) {
      // OVERLAY-AWARE RETRY (stateful path only, the modal-heavy-site fix): a RAW click failure —
      // the target RESOLVED and was visible, but the click TIMED OUT because an EARLIER act left a
      // modal/backdrop obscuring it. That raw Playwright error carries NO `.envelope`, unlike our
      // structured NO_INSTANCE / NOT_VISIBLE / DANGER_FLOOR throws (which ARE honest-unreachable and
      // must NOT retry). So: for a non-envelope error, close the blocking overlay under __idle__
      // (actStep already reset the cause on the throw; reset the tracker verdicts after — the dismiss
      // opens no causal window and forges no edge) and RETRY the SAME target ONCE. Bounded: dismiss
      // returning false (nothing to close) → no retry → honest unreachable, so this cannot loop.
      if (err && !err.envelope) {
        const dismissed = await dismissBlockingOverlay(page);
        resetTrackerVerdicts(page);
        if (dismissed) {
          try {
            res = await actStep(page, graph, ledger, target, { capture, revealPath, statefulProvenance: true, exploreAll, stateDir, marker, runCreatedAccount, runId });
          } catch (err2) { await recordProbe(graph, target, null, { page, prefill: prefillUsed, blocked: err2?.envelope?.code || 'ACT_FAILED' }); recordFail(err2); throw err2; }
        } else { await recordProbe(graph, target, null, { page, prefill: prefillUsed, blocked: err?.envelope?.code || 'ACT_FAILED' }); recordFail(err); throw err; }
      } else {
        // NO_INSTANCE / NOT_VISIBLE / DANGER_FLOOR — re-throw so the loop marks it unreachable
        // (coverage unchanged). The instance not resolving on the live page IS the honest outcome
        // when a prior sibling act collapsed its state (the backtracking gap noted in the header).
        await recordProbe(graph, target, null, { page, prefill: prefillUsed, blocked: err?.envelope?.code || 'ACT_FAILED' });
        recordFail(err);
        throw err;
      }
    }

    // OUTSIDE the try, deliberately. Inside it, a throw from the observation landed in the overlay-aware
    // retry branch above and fired the SAME control a second time — under explore-all that is a duplicated
    // destructive act, recorded in the trail as one. An observation that fails is not an act that failed.
    await recordProbe(graph, target, res, { page, prefill: prefillUsed, seen: seenBefore });

    // Re-snapshot the LIVE page IN PLACE — the operator's "re-snapshot after acting". An act that
    // opened a modal/dropdown/panel left it open, so its contents merge as NEW templates/instances
    // and the frontier picks them up next round. actStep already merges its own post-click DOM, so
    // this is idempotent belt-and-suspenders that ALSO catches content mounting AFTER actStep's
    // snapshot (a fetch that resolved during this extra settle — dynamic feeds). It opens NO causal
    // window (pure DOM read + graph merge under __idle__), so attribution is exactly what actStep
    // produced. Guarded on same-origin: a JS onclick that slipped off-origin must NOT snapshot the
    // foreign page into the graph (actStep already refused to merge it and returned the in-scope route).
    if (sameOrigin(page.url(), origin)) {
      await waitSettled(page);
      await snapshotStep(page, graph, ledger, routeKey(page.url()));
    } else if (baselineUrl) {
      // OFF-ORIGIN RECOVERY: a JS onclick navigated us out of scope. Re-navigate to the in-scope
      // baseline (the one exceptional re-nav) so subsequent acts resolve against an in-scope page
      // instead of failing NO_INSTANCE on a foreign origin. This resets accumulated in-session
      // state — an honest, rare cost of leaving scope, not the per-act cold nav stateful mode drops.
      await gotoGated(page, baselineUrl);
      await waitSettled(page);
    }

    // Append this act's hop to the provenance chain ONLY IF it stayed IN PLACE (same origin AND the route
    // unchanged from where the act started). A nav act changed the route → do NOT push; the next act's
    // route-check resets the chain. Reached only on the SUCCESS path — a thrown/unreachable act re-threw
    // above and never gets here (a control that did not act reveals nothing, so it contributes no hop).
    if (sameOrigin(page.url(), origin) && routeKey(page.url()) === cur) {
      // An act that REVEALED nothing is not an opener, so it is not part of any path TO something — it is
      // just something that happened. Appending it anyway turned the breadcrumb into a full session
      // history: measured live, Create Event's form fields carried a 20-hop chain (`51x8, 53, 55x8, 57,
      // 79, 98`) where the real path to the modal is ONE hop. Everything past REVEAL_MAX_DEPTH=10 then
      // fails REVEAL_TOO_DEEP before the click, which is why every field inside a modal opened later in a
      // session was permanently unreachable — Create Event, Add Connection's search, the profile menu.
      const revealed = (res.newElements?.length || 0) + (res.newlyReachable?.length || 0);
      // Two more hops that must never enter the breadcrumb, both measured on the live graph:
      //   - a DISMISS control ("cancel"/"close"). It reveals whatever was BEHIND the overlay, so it passes
      //     the revealed>0 test, and then sits in the path of everything discovered afterwards. tpl 933
      //     "Group Name" recorded [26, 98, 79, 900 "cancel", 902] — a path that closes its own modal.
      //   - a REPEAT of a template already in the chain. A path that revisits an opener is cyclic by
      //     definition, and reveal-replay refuses it outright (REVEAL_CYCLE): 39 of 494 paths died this way.
      // Refusing to append is strictly better than appending and failing later — a shorter honest path
      // still reaches its target, whereas a poisoned one is frozen by first-reveal-wins forever.
      const repeats = chain.some((h) => h.templateId === target.templateId);
      if (revealed > 0 && !isDismissControl({ name: target.name }) && !repeats) {
        chain.push(hop); chainRoute = cur;
      }
      // A non-revealing act does not extend the chain, but it also must not INVALIDATE it: the page state
      // is unchanged, so the existing breadcrumb still describes where we are.
    }

    // Mark the acted template explored (idempotent — reconLoop marks it again after step returns);
    // done here so the debug graph snapshot below shows the just-acted control as explored.
    markInstanceExplored(graph, target.templateId, target.instance && target.instance.instanceKey);

    // Debug trail (opt-in via runId): record this act + snapshot the merged graph.
    if (runId) {
      // `revealed` alone (a COUNT) cannot answer the one question that matters about the walk: after an
      // act opened a modal, did the NEXT act go INSIDE it, or wander off? Answering that needs the
      // identities, so the trail records them. Purely observational — the trail is never read back into
      // the graph, so this touches no identity input.
      const revealedIds = [...(res.newElements || []), ...(res.newlyReachable || [])]
        .map((r) => r.templateId).filter((id) => id != null);
      const seq = traceEvent(runId, 'act', {
        templateId: target.templateId, instanceKey: target.instance?.instanceKey ?? null,
        name: target.name, role: target.role, route: res.route,
        requests: res.requests, revealed: res.newElements.length,
        revealedTemplateIds: [...new Set(revealedIds)], external: res.external || null,
        // What the form filler actually managed to put in before this click. A submit that fires nothing
        // is otherwise indistinguishable from a submit we never filled — which is exactly how six runs
        // read as "validation refused" when the truth was "the required select was never touched".
        prefill: res.prefill || null,
        // HOW the acted element was found, and whether it is the stored instance or a live stand-in. Without
        // these two fields the trail records only the INTENDED target, so an act that resolved a same-named
        // control from a different template is indistinguishable from a clean hit — which is exactly how
        // "clicked the opener, recorded the submit" survived seven runs and every log review of them.
        via: res.via || null, representative: res.representative === true,
        timings: res.debug?.timings || null,
        shots: res.debug ? { before: res.debug.before?.shot, after: res.debug.after?.shot, rect: res.debug.before?.rect, viewport: res.debug.before?.viewport } : null,
        bodies: res.debug?.bodies || null,
      });
      if (graphPath) saveGraph(graphPath, graph);
      snapshotGraph(runId, seq);
    }
    return res;
  };
}
