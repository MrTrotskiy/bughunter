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
import { snapshotStep, actStep, captureFailureSkeleton } from './step.mjs';
import { routeKey, sameOrigin } from './scope.mjs';
import { gotoGated } from '../browser/session.mjs';
import { dismissBlockingOverlay, clickIntercepted } from './overlay-dismiss.mjs';
import { makeCapture, traceEvent, snapshotGraph } from '../debug/trace.mjs';
import { resolveHandle, resolveWithAttempts } from './resolve-handle.mjs';
import { fieldsFor, looksLikeSubmit } from './form-fill.mjs';
import { attachPageSignals, readOutcome, wasRefused, announcedSuccess, liveRegionTexts, domFingerprint, domChanged } from '../browser/observables.mjs';
import { verdictOf } from './knowledge.mjs';
import { valueForProbe } from './probe-battery.mjs';
import { probeStatus } from './knowledge.mjs';
import { formFactsFrom, formBattery, fillsFor } from './form-battery.mjs';
import { fieldScopeSelector, settleField } from './field-scope.mjs';
import { classifyEndpoint } from './endpoint-class.mjs';
import { isDismissControl } from './danger-floor.mjs';
import { isShapedType } from './probe-kinds.mjs';

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
  // The kind a recorded row CLAIMS. `selfFill` means the act actuated the target field itself before
  // committing, which is exactly the `fill-valid` transaction a field's battery owes — recording it as a
  // bare `click` is why 14 measured fields sat at L2 with an obligation nothing could ever discharge
  // (`probe-kinds.mjs` deliberately refuses to let a click answer for a field, and it is right to).
  // `selfFilled` is the OUTCOME reported by actStep, not the value we hoped to type. A field we could not
  // fill (readonly, a widget whose typed actuation failed, a control that turned out not to be a field)
  // must not mint a `fill-valid` row — that would discharge the one obligation the fill exists to answer,
  // on evidence that does not exist.
  // WHICH obligation a row discharges. It used to say `fill-valid` for every self-fill, so a boundary or
  // empty-commit probe was recorded as the valid-value probe — the battery could never empty, and the
  // element would be re-probed with the same input forever. The act now declares what it was testing.
  // WHICH obligation a row discharges. Two traps, both measured in review before they could ship:
  //  1. It honoured the caller's `kind` only when a SELF-FILL landed. A form rung is not a self-fill — the
  //     empty rung fills NOTHING by definition — so `submit-empty` would have been recorded as a plain
  //     `click`, which satisfies the click obligation and can never satisfy the rung. The ladder could
  //     then never empty and the form would be probed with an empty submit forever.
  //  2. `fill-submit` is the right name only when the act filled fields and was NOT executing a named
  //     rung. A named rung always wins, because it is the question the script actually asked.
  const kindOf = (prefill, selfFilled, kind) => {
    if (kind) return kind;                       // the script named the obligation — that is what this is
    if (selfFilled) return 'fill-valid';
    return prefill && prefill.length ? 'fill-submit' : 'click';
  };

  const recordProbe = async (g, target, res, { page: pg, prefill, selfFill, seen, blocked, domBefore, kind }) => {
    // The fill is credited ONLY when actStep reports it landed.
    const selfFilled = res?.selfFilled === true;
    const node = g?.elements?.[target?.templateId];
    if (!node) return;
    // AN ACT THAT FAILED STILL TAUGHT US SOMETHING, and losing it was the worst gap in the first run: the
    // only 5xx of the whole crawl (`POST /app/addfriendgroup -> 500`) came from an act that threw, so
    // it recorded NO row — the single most interesting event existed only in the trail, while the element
    // still counted as explored. A blocked row keeps it in the ladder as L-1 with its reason, which is the
    // bucket that was structurally empty before this.
    if (blocked) { (node.probes || (node.probes = [])).push({ kind: kindOf(prefill, false, kind), blocked, instanceKey: target.instance?.instanceKey ?? null }); return; }
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
    // `POST /app/sendfriendrequests -> 200` (a friend request genuinely sent) and
    // `POST /app/addnuggets` were both recorded as `read` because of exactly this. The classifier
    // judges by the endpoint's own verb rather than the HTTP method, which this target requires — it reads
    // over POST, so method alone says nothing.
    const requests = (res.requests || []).map((q) => {
      const urlPattern = q.urlPattern || q.url;
      return { method: q.method, urlPattern, status: q.status, class: classifyEndpoint({ method: q.method, url: q.url, urlPattern }) };
    });
    // THE FIELD'S OWN ANSWER. A field we filled that caused no request is not necessarily silent: its
    // declared constraints are enforced by the CLIENT, and AntD validates on `onChange` by default, so the
    // verdict is readable from the field's own region with no submit at all. Read AFTER the causal window
    // has closed, scoped to that one region — page-scoped would credit a neighbouring field's leftover
    // error to this one, the same borrowed-evidence fallacy that once made a single toast the recorded
    // outcome of three separate acts. Measured cause: 4 filled textboxes recorded `inert` with nothing
    // wrong with the fill — they simply have no commit to answer to.
    let localRefused = false;
    if (selfFilled) {
      const live = await resolveHandle(pg, target.instance, node).catch(() => null);
      if (live) {
        await settleField(pg, live.handle);
        const scope = await fieldScopeSelector(pg, live.handle);
        if (scope) {
          const local = await readOutcome(pg, { scope, seen }).catch(() => null);
          localRefused = local ? wasRefused(local) : false;
        }
      }
    }
    // A field we MEANT to fill and could not is recorded as such — otherwise it silently degrades to a
    // `click` row and the field looks like an ordinary control that simply did nothing. The kind is the
    // obligation the act was DISCHARGING (`kindOf`, matching the blocked-path at line 118): hardcoding
    // `fill-valid` here filed a NOT_FILLABLE answer under the valid-value probe while the real owed kind
    // (`fill-invalid`/`fill-overflow`/`fill-empty`) stayed outstanding forever — the exact never-drain
    // class this file exists to close. Benign only while fill-valid drains first; an ordering change resurrects it.
    if (selfFill && !selfFilled) {
      (node.probes || (node.probes = [])).push({ kind: kindOf(prefill, false, kind), blocked: 'NOT_FILLABLE', instanceKey: target.instance?.instanceKey ?? null });
    }
    const domAfter = await domFingerprint(pg);
    const structural = domChanged(domBefore, domAfter);
    const row = {
      // WHEN A SELF-FILL WAS ATTEMPTED AND DID NOT LAND, the main row must NOT claim the fill obligation.
      // `kindOf` honours a NAMED `kind` unconditionally, so a click that revealed/read nothing would be
      // stamped `fill-invalid`/`fill-valid`, land in `done`, and `probeStatus`'s `blocked.delete(k)` would
      // then wipe the NOT_FILLABLE block pushed just above — flipping the obligation from an honest
      // "unfillable, with a reason" to "answered" on evidence that never existed (invariant #3, and this
      // file's own rule at line 88-91). Passing `undefined` lets kindOf fall back to `click`/`fill-submit`,
      // preserving the click's own evidence (requests/reveals) while the NOT_FILLABLE row keeps the obligation.
      kind: kindOf(prefill, selfFilled, (selfFill && !selfFilled) ? undefined : kind),
      verdict: verdictOf({
        requests, revealed: (res.newElements || []).length,
        navigated: !!(res.route && target.route && res.route !== target.route),
        refused: localRefused || (outcome ? wasRefused(outcome) : false),
        succeeded: outcome ? announcedSuccess(outcome) : false,
        // "COULD NOT LOOK" IS NOT "NOTHING HAPPENED". `domChanged` returns null when the fingerprint could
        // not be read (a navigation mid-measure, a detached document). Collapsing that to `false` made the
        // verdict `inert` on evidence we never had — manufacturing exactly the dead-control reading that
        // caps this project's coverage. A null is carried through so `verdictOf` can tell absence of
        // change from absence of measurement.
        domChanged: structural ? structural.changed : null,
      }),
      instanceKey: target.instance?.instanceKey ?? null,
      // HOW WE FOUND THE NODE, recorded WITH the verdict. The trail had this and the graph did not, so the
      // one fact that decides whether a verdict can be trusted was unavailable to every consumer of the
      // graph. Measured in probe6: seven instances of template 392 were acted through the `text` fallback
      // and reported an IDENTICAL rect — one node clicked seven times and credited to seven instances. A
      // verdict from a representative act describes whatever node the fallback happened to land on, which
      // is why an `inert` row can never be read as "this control is dead" without it.
      via: res.via ?? null,
      representative: res.representative === true,
      requests: requests.map((q) => `${q.method} ${q.urlPattern}${q.status ? ` -> ${q.status}` : ''}`),
      revealed: (res.newElements || []).length,
      ...(prefill && prefill.length ? { filled: prefill.length } : {}),
      ...(outcome && outcome.validity.length ? { validity: outcome.validity } : {}),
      ...(outcome && outcome.frameworkErrors.length ? { errors: outcome.frameworkErrors } : {}),
      ...(outcome && outcome.liveRegions.length ? { announced: outcome.liveRegions.map((r) => r.text) } : {}),
    };
    (node.probes || (node.probes = [])).push(row);

    // CREDIT THE FIELDS THAT WERE ACTUALLY FILLED — and it costs nothing, because the transaction already
    // happened. `fieldsFor` fills every field in the container before the commit, so one act teaches us
    // about N fields; recording a single row on the submit button threw N-1 of those lessons away. That is
    // why 41 field elements were structurally stuck at L2: their battery owes `fill-valid`, the transaction
    // performed exactly that, and nothing wrote it down.
    //
    // The alternative — probing each field with its own submit — would cost roughly one real submit per
    // field on a live target under explore-all (59 fields across 14 forms). Batching is not just cheaper,
    // it is the only shape that does not spam the operator's stand.
    //
    // The value is read BACK from the row so `accepted` is what the field HELD, never what we typed: a
    // field that truncates at its declared limit is enforcing it, and judging on the attempted length would
    // fabricate a boundary defect — the most damaging kind of false finding.
    if (prefill && prefill.length) {
      const byInstance = new Map();
      for (const [tid, n] of Object.entries(g.elements || {})) {
        for (const inst of n.instances || []) if (inst.instanceSelector) byInstance.set(inst.instanceSelector, { tid, n, inst });
      }
      // CREDIT WHAT ACTUATED, NOT WHAT WE MEANT TO ACTUATE. `prefill` is the INTENTION — the field census
      // `fieldsFor` builds by reading the DOM before anything is typed. `actuateAll` reports what actually
      // happened in `{attempted, actuated, skipped[]}`, and `actStep` returns it as `res.prefill`; this
      // branch was not looking at it. Measured in run probe8: one field (tpl 341 "Post Ad") reported
      // attempted 1 / actuated 0 and still received a `fill-valid` row, because the intention array said it
      // was going to be filled. The self-fill path was fixed for exactly this and its sibling was not — the
      // same bug through the next door along, which is why an audit found it and the fix did not.
      const skipped = new Set(((res && res.prefill && res.prefill.skipped) || []).map((sk) => sk.selector));
      for (const pf of prefill) {
        const hit = byInstance.get(pf.selector);
        if (!hit || !hit.n.fieldFacts) continue;
        if (skipped.has(pf.selector)) {
          // Named, not dropped: the field stays owed and the reason survives.
          (hit.n.probes || (hit.n.probes = [])).push({
            kind: 'fill-valid', blocked: 'NOT_FILLABLE',
            instanceKey: hit.inst.instanceKey ?? null, via: 'batched-with-submit',
          });
          continue;
        }
        const fieldRow = {
          kind: 'fill-valid',
          verdict: row.verdict,
          instanceKey: hit.inst.instanceKey ?? null,
          via: 'batched-with-submit',
          submittedBy: target.templateId,
        };
        // The length ATTEMPTED, named as such. The previous field was called `input.length` beside a comment
        // promising a read-back of what the field HELD, which is a different number and the one that decides
        // whether a declared boundary was enforced.
        if (pf.value != null) fieldRow.input = { attemptedLength: String(pf.value).length };
        (hit.n.probes || (hit.n.probes = [])).push(fieldRow);
      }
    }
    return row;
  };

  return async (graph, target) => {
    // Record a FAILED act on the debug timeline (opt-in via runId) so the admin shows the
    // "why didn't it reach X?" cases (NO_INSTANCE / NOT_VISIBLE / DANGER_FLOOR) that reconLoop's
    // catch would otherwise swallow into markUnreachable with no trail entry.
    // A FAILED act's row must answer HOW, not only THAT. It used to write 9 fields where a successful act
    // writes 16, dropping `via` and `instanceSelector` in particular — and an audit of run probe9 found 11
    // of its 20 failures were resolver COLLISIONS, i.e. precisely the class whose diagnosis needs to know
    // how the instance was resolved and onto what. The trail could say an act failed and could not say
    // which element it had found, which is the same blind spot that hid a wrong-control bug for seven runs.
    //
    // THE KIND IS `act.failed`, NOT `act`. `trace.readActFailed` — the source `report --unreached` prefers
    // over the graph's COARSE unreachable reason — filters on `kind === 'act.failed'`, and only the agent
    // path (whats-new) ever wrote that kind. Every run produced by the live driver (recon-run → statefulLoop
    // → statefulStep) therefore returned [] from that reader: measured, `hygge2`, `goal1`, `goal2` and every
    // `explore*` run contain ZERO act.failed events, so the precise NO_INSTANCE / NOT_VISIBLE / REVEAL_*
    // codes this function computes were written down and then silently discarded by the one consumer that
    // exists for them. Field names follow that reader's contract (`instance`, `message`).
    //
    // `requested`, NEVER `route`. The success payload writes `route: res.route` — where the act LANDED —
    // while this one wrote `route: target.route`, where it was AIMED. Measured divergence: 67 of 301 acts
    // in `hygge2`, 199 of 352 in `goal1`, so any viewer with a single "route" column was mixing intent with
    // fact. `route` events already carry the aimed URL as `requested` (stateful-loop.mjs), so this adopts
    // the existing vocabulary rather than inventing one — and it is the same defect class as the trail that
    // once logged an act's INTENDED target instead of the element actually clicked, which hid a
    // wrong-control bug for seven runs.
    //
    // AND THE SKELETON — the only visual evidence a failed act can have. `shots` below is null for every
    // failure that threw BEFORE actStep's `capture.before` (the whole pre-click gate stack), which on run
    // raw1 was all 146 of them. `captureFailureSkeleton` (step.mjs) fills that gap with a schematic of the
    // page as it stood at the failure. Every call site below is reached under `__idle__` — the gate stack
    // precedes `beginCause`, and the one causal window resets the token on both exits (see the helper's
    // header) — and it returns null rather than throwing, so the original error re-throws unchanged.
    // Unlike the cold driver's, EVERY recordFail here is post-failure on the LIVE page the act ran on, so
    // there is no pre-navigation case to opt out of.
    const recordFail = async (err) => {
      if (!runId) return;
      const message = err?.message || String(err);
      const skel = await captureFailureSkeleton(page, { runId, templateId: target.templateId });
      // WHAT THE RESOLVER TRIED, not merely that it failed — the answer to the question asked of this project
      // four times: "why did the agent not find that button, and what did it DO to find it". Measured on run
      // `raw3` (the live stateful driver): `via` — how a SUCCESSFUL act found its control — rode 119 of 119
      // acts, while the attempt record rode 0 of 31 failures. So the half of the run that needs explaining was
      // the half with no evidence, and three completely different diagnoses rendered identically as "не нашли":
      //   - `selector` ran with raw 0 while the durable strategies never ran → the stored positional path went
      //     stale and the durable locator was not even tried,
      //   - `role-name` ran with raw 0 → a genuine coverage gap: nothing on the page carries that name,
      //   - `role-name` ran with raw 3 and sameTemplate 0 → candidates were FOUND and the structural guard
      //     refused every one, which is a resolver bug and not a missing control (and that guard compares a
      //     full ancestor path while promising to tolerate an element that MOVED, so it is a live suspect).
      //
      // TWO SOURCES, ONE VOCABULARY — deliberately `step.mjs`'s `target` slot and its field names, so the
      // viewer needs one renderer rather than two, and `failure-hints.revealKnowledge` (which already reads
      // `step.target.hadRevealPath`) keeps working with no change:
      //   - actStep's OWN envelope evidence where the failure carried it (NO_INSTANCE / NOT_VISIBLE, measured
      //     at the failing instant). It wins field-for-field, and its discriminators (`resolvedVia`,
      //     `hiddenAfterResolve`, `representative`) ride along.
      //   - otherwise the pre-act resolution THIS step already performed for its click-interception check.
      //     That is what gives the codes carrying no envelope evidence an attempt record at all — on raw3,
      //     ALIAS_COLLISION 13, DISABLED 8, ACT_FAILED 6 of the 31, i.e. 30 failures that would stay mute.
      //     For a collision it is the whole diagnosis: the message names the `via` that landed on the wrong
      //     node, and the attempts say what else was on the page when it did.
      //
      // NO new DOM work and NO causal window: every count was computed by a resolution that had already
      // happened, both sources are read under `__idle__` (the pre-act one precedes actStep's `beginCause`; the
      // envelope one is built inside actStep's pre-click gate stack), and this function adds no page call.
      const envTarget = err?.envelope?.target && typeof err.envelope.target === 'object' ? err.envelope.target : null;
      const evidence = {
        templateId: target.templateId,
        instanceKey: target.instance?.instanceKey ?? null,
        selector: target.instance?.instanceSelector ?? null,
        attempts: preResolve ? preResolve.attempts : null,
        // The field that separates "we never knew how to open this" from "the path broke" — 33 vs 20 on the
        // previous run, and the single most explanatory bit available about an unreached control.
        hadRevealPath: !!(target.instance?.reveal?.statePath?.length
          || graph?.elements?.[target.templateId]?.reveal?.statePath?.length),
        locatorType: target.instance?.locator?.type ?? null,
        ...(envTarget || {}),
      };
      traceEvent(runId, 'act.failed', {
        templateId: target.templateId,
        instance: target.instance?.instanceKey ?? null,  // readActFailed's field name
        instanceKey: target.instance?.instanceKey ?? null,
        name: target.name, role: target.role,
        requested: target.route,   // where the act was AIMED — never `route`, which means LANDED
        instanceSelector: target.instance?.instanceSelector ?? null,
        code: err?.envelope?.code || (err?.clicked ? 'POST_CLICK_FAILED' : 'ACT_FAILED'),
        clicked: err?.clicked === true,   // did the control already FIRE before the failure?
        selfFill: selfFill != null,
        probeKind,
        message,               // readActFailed's field name
        error: message,        // the admin's outcome classifier reads `error`
        target: evidence,      // WHAT WAS TRIED — step.mjs's structured slot, same shape, one renderer
        requests: [], revealed: 0,
        // WHAT THE ACT GOT AS FAR AS. A failed act used to ride with `shots: null` and no `timings` at all
        // — 54 of 355 acts in `hygge2`, 56 of 408 in `goal1`, i.e. 15% of a run about which the trail could
        // say neither where the element was nor how long the attempt took. The before-frame (shot + rect +
        // viewport) is captured by actStep under `__idle__` BEFORE every failure path, so it exists; it was
        // simply dropped on the throw. Both stages below are whatever COMPLETED — never a fabricated value.
        timings: { attemptMs: Math.round(performance.now() - tAct) },
        shots: beforeFrame
          ? { before: beforeFrame.shot ?? null, after: null, rect: beforeFrame.rect ?? null, viewport: beforeFrame.viewport ?? null }
          : null,
        // The schematic stand-in for the key-frame this failure could never have (ref, not bytes —
        // the skeleton lands in the run's skel/ dir exactly as a shot lands in shots/).
        skeleton: skel,
      });
    };

    // Reused page: clear the PREVIOUS act's initiator verdicts so a path it click-rooted does not
    // suppress THIS act's same-path background poll's timer-rejection (the cross-act discipline).
    resetTrackerVerdicts(page);
    let seenBefore = [];
    let domBefore = null;
    let prefillUsed = null;
    let selfFill = null;
    let probeKind = null;   // which battery obligation THIS act is discharging
    // How long THIS act's attempt ran, so a FAILURE is not blind about its own cost. Named `attemptMs` and
    // deliberately not `actMs`: the success path's `actMs` measures the causal window ONLY, and an act that
    // threw before/inside its click never completed one — reusing the name would report a number that means
    // something else. Node-side performance.now(), inert, opens nothing.
    const tAct = performance.now();
    // The before-frame actStep captured, retained across the throw (see recordFail).
    let beforeFrame = null;
    // The resolver's own attempt record from the resolution this step ALREADY performs before acting — kept
    // for recordFail, which otherwise has no evidence at all for the failure codes actStep throws without an
    // envelope `target` (ALIAS_COLLISION / DISABLED / a raw click failure). Never a second resolution.
    let preResolve = null;

    // Reset the provenance chain when the live route changed (a prior nav act moved us, or off-origin
    // recovery re-navigated): the accumulated breadcrumb belongs to ONE route.
    const cur = routeKey(page.url());
    if (cur !== chainRoute) { chain = []; chainRoute = cur; }
    // This act's opener hop + the reveal path to stamp on whatever it reveals (chain-so-far + this hop).
    // Hop shape MATCHES revealPathFor (reveal-replay.mjs): { templateId, instanceKey }. Built here (before
    // the try) and reused for the overlay-retry call so both actStep passes stamp the SAME path.
    const hop = { templateId: target.templateId, instanceKey: target.instance && target.instance.instanceKey };
    // THE PATH IS A PARENT POINTER IN THE REVEAL TREE, NOT THE ACT LOG.
    //
    // This read `chain.concat([hop])` — the accumulated breadcrumb of EVERY act since the last route change.
    // That is a session history, and a history is not a route. Measured on one graph: a ten-hop path opened a
    // board at hop 4 and then, at hop 5, clicked the breadcrumb that navigates back OUT of it, followed by
    // three MUTUALLY EXCLUSIVE modal openers. No suffix of such a path can be walked, at any length — which
    // is why raising the reopen cap was measured to change admission by exactly zero (1100/1120 at maxHops
    // 3, 8 and 20) while adding 831 attempts, and why the audited run recovered 15 controls using ONE hop
    // and never more.
    //
    // The parent pointer is the target's OWN recorded path plus this hop, so the result is acyclic and
    // single-route BY CONSTRUCTION rather than by a filter that has to catch every way a log goes wrong.
    //
    // And the filters below could not have saved it anyway: they gate whether `hop` joins `chain` for FUTURE
    // acts, while the value STAMPED on everything this act reveals was computed here, unfiltered. So an act
    // on a dismiss control — which reveals whatever sat behind the overlay, and therefore passes the
    // revealed>0 test — stamped a path ending in its own "Cancel" onto every control it uncovered.
    const parent = (target.instance && target.instance.reveal && target.instance.reveal.statePath)
      || (graph.elements[target.templateId] && graph.elements[target.templateId].reveal
          && graph.elements[target.templateId].reveal.statePath)
      || [];
    // Defence in depth: a parent path is acyclic by construction, but a graph carried over from an older
    // scheme may still hold a poisoned one. Never stamp a path that already contains this hop.
    const cyclic = parent.some((h) => h && h.templateId === target.templateId);
    const revealPath = cyclic || isDismissControl({ name: target.name }) ? null : parent.concat([hop]);

    let res;
    // The ONE causal window (unchanged): beginCause→click→endCause, IN PLACE on the live page. revealPath +
    // statefulProvenance stamp the accumulated breadcrumb as PROVENANCE (stateful:true, method-agnostic) —
    // it is NOT replayed; the state is already accumulated. Location honesty, not a reach mechanism.
    // RETAIN WHAT THE CAPTURE ALREADY PRODUCED. actStep takes the before-frame (shot + rect + viewport)
    // while the cause is still `__idle__`, BEFORE every failure path — then throws with only `.envelope`
    // and `.clicked` attached, so the frame it had already taken went nowhere. Recording the collaborator's
    // return value here keeps it available to recordFail WITHOUT changing what actStep captures or when: the
    // wrapper adds no call, takes no screenshot of its own, and never runs inside a causal window, so
    // attribution is byte-for-byte what it was.
    const rawCapture = runId ? makeCapture(runId, target.templateId) : undefined;
    const capture = rawCapture && {
      ...rawCapture,
      before: async (pg, handle) => (beforeFrame = await rawCapture.before(pg, handle)),
    };
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
        // THE FORM LADDER (docs/GOAL.md). Filling every field and submitting once answers the happy path
        // and nothing else. The script derives what the form DECLARES required, and this act executes the
        // NEXT outstanding rung: empty first — does anything stop us at all, the client or the server? —
        // then one required field at a time. Each rung is an ordinary act with its own causal window, so
        // attribution is untouched; the ladder truncates itself the moment an incomplete submit is
        // accepted, because that question is then answered.
        const submitNode = graph.elements[target.templateId];
        if (submitNode && prefill && prefill.length) {
          // Stamp what the form declares — additive metadata, never an identity input.
          if (!submitNode.formFacts) submitNode.formFacts = formFactsFrom(prefill);
          const owed = formBattery(submitNode.formFacts, submitNode.probes || []);
          if (owed.length) {
            const rung = owed[0];
            const slice = fillsFor(rung, submitNode.formFacts, prefill);
            if (slice !== null) { prefill = slice; prefillUsed = slice; probeKind = rung; }
          }
        }
      }
      // THE TARGET IS ITSELF A FIELD → the act is a FILL, not a click. Clicking a textbox teaches nothing
      // about what it accepts, which is why `probe-kinds.mjs` refuses to let a click discharge a field's
      // `fill-valid` obligation. Measured: 14 elements stranded at L2 owing `fill-valid` and holding only
      // `click` rows — an obligation the loop could never have satisfied, however many times it acted.
      // A field the page DECLARES unusable is not filled: that is a fact about the field, and forcing a
      // value into a readonly input would fabricate an answer it never gave.
      // ONE ACT IS NOT A STUDY. The battery that says WHAT a field owes — a valid value, plus a boundary
      // probe wherever the field DECLARES a limit, plus an empty commit where it declares itself required,
      // plus a wrong-shape value where it declares a pattern or a range — has existed and been
      // revert-proven for a while, and NOTHING CALLED IT. Every act filled one valid value and moved on,
      // so a field was "studied" on a single happy-path input: we learned it accepts a value, and never
      // what it REFUSES. That is the difference between touching a control and understanding it, and
      // understanding is the whole point of Phase 1 — turning a black box into a white one WITHOUT the
      // source.
      // So the script picks the NEXT OUTSTANDING obligation and the act discharges that one. The element
      // stays in the frontier until the list is empty (frontier.instanceDrained), which is what makes the
      // loop grind an element until it is genuinely characterised instead of after one touch.
      const node = graph.elements[target.templateId];
      const facts = node?.fieldFacts;
      if (facts && !facts.disabled && !facts.readOnly) {
        const owed = probeStatus(node, node.probes || []).outstanding;
        // `outstanding` is ordered as batteryFor built it: the valid value first, so a field is never
        // probed at its boundary before we know it accepts anything at all.
        const kind = owed.find((k) => k.startsWith('fill-')) || 'fill-valid';
        const value = valueForProbe(kind, facts);
        // `valueForProbe` returns null when a probe has no prediction to falsify (a boundary probe on a
        // field declaring no boundary). Fall back to the valid fill rather than inventing an input.
        selfFill = value === null ? valueForProbe('fill-valid', facts) : value;
        probeKind = value === null ? 'fill-valid' : kind;
      }
      // CLEAR THE WAY BEFORE CLICKING, not after failing. Ask the page whether something would intercept
      // the click on this target; if so, close the overlay now. Purely an idle-time UI op — no causal
      // window is open yet, so this forges no edge — and it is skipped entirely when the target lives
      // INSIDE the overlay, which is how studying a modal's own contents keeps working.
      // The post-failure dismiss+retry below stays as the backstop for what this cannot foresee.
      //
      // WIDENED, NOT MOVED. `resolveHandle` is a thin PROJECTION of `resolveWithAttempts` (resolve-handle.mjs
      // returns `r.handle ? {handle,via,representative} : null` off the identical call), so switching here
      // performs BYTE-IDENTICAL DOM work and merely keeps the per-strategy record the projection discards —
      // which is the evidence recordFail below needs and had no other source for.
      // THE TRAP THE PROJECTION EXISTS FOR: the widened form ALWAYS returns an object, so a bare `if (live)`
      // would read true on a total resolution failure and hand `clickIntercepted` a null handle. `live.handle`
      // is non-null in exactly the cases the old truthiness test passed, so the branch is unchanged. The three
      // other call sites in this file take only a handle and deliberately stay on the projection.
      const live = await resolveWithAttempts(page, target.instance, graph.elements[target.templateId]).catch(() => null);
      preResolve = live;
      if (live?.handle && await clickIntercepted(page, live.handle)) {
        await dismissBlockingOverlay(page, live.handle);
        resetTrackerVerdicts(page);
      }
      seenBefore = await liveRegionTexts(page);
      domBefore = await domFingerprint(page);
      res = await actStep(page, graph, ledger, target, { capture, revealPath, statefulProvenance: true, exploreAll, stateDir, marker, runCreatedAccount, runId, fill: selfFill || undefined, prefill: prefill && prefill.length ? prefill : undefined });
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
        // THE NATIVE FIELD ENFORCED ITS SHAPE — a terminal L3 answer, not a transient failure to act.
        // A native input[type=number|date|…] REFUSES a wrong-shape fill by THROWING (actStep tags the
        // throw site as `err.duringFill`; the message is "Malformed value"). For a SHAPE probe that throw
        // IS the field holding the line, so it drains the obligation as NOT_FILLABLE — reaching L3 and
        // minting no false finding (blocked rows are skipped). Recording it ACT_FAILED (a TRANSIENT code
        // that discharges nothing) left `fill-invalid`/`fill-overflow` outstanding forever, stalling the
        // field at L2 while the frontier reported it retired — the never-drain disagreement GOAL.md forbids.
        //
        // TWO GATES, so a transient throw is never mistaken for shape enforcement. (1) EVIDENCE, NOT the
        // message: only a NATIVE constrained input (`isShapedType(fieldFacts.kind)`) has a shape a fill can
        // enforce — a custom widget / text input throwing during a fill is a transient failure, not the type
        // holding a line. (2) A SHAPED input can STILL throw transiently (detached by a re-render, a
        // navigation destroying the context, an overlay timing out the fill), so those messages fall through
        // to the retry/ACT_FAILED path below rather than being frozen as a terminal answer. On AntD/React
        // number is a text input and coerces without throwing, so this bites only genuinely-constrained
        // native inputs — the apps this crawler has never seen.
        const shapedField = isShapedType(graph.elements[target.templateId]?.fieldFacts?.kind);
        const transientFillThrow = /not attached to the DOM|Execution context was destroyed|Target (page|frame)?.*(closed|crashed)|Timeout .*exceeded/i.test(String(err?.message || ''));
        if (err.duringFill && (probeKind === 'fill-invalid' || probeKind === 'fill-overflow')
            && shapedField && !transientFillThrow) {
          await recordProbe(graph, target, null, { page, prefill: prefillUsed, selfFill, kind: probeKind, blocked: 'NOT_FILLABLE' });
          await recordFail(err);
          throw err;
        }
        // The blocked handle drives the verdict here too: on a framework that blocks via
        // `pointer-events: none` on the body, the curated overlay signature never changes, so the retry
        // was skipped even when Escape had actually closed the dialog.
        const reBlocked = await resolveWithAttempts(page, target.instance, graph.elements[target.templateId]).catch(() => null);
        // A FRESHER answer to the same question, measured ON the failure path — so it supersedes the pre-act
        // record as the evidence for whatever this retry ends up throwing. `reBlocked?.handle` reads null for
        // BOTH the catch's null and a failed resolution's `{handle: null}`, so the dismiss argument below is
        // exactly the value it always was.
        if (reBlocked) preResolve = reBlocked;
        const dismissed = await dismissBlockingOverlay(page, reBlocked?.handle || null);
        resetTrackerVerdicts(page);
        if (dismissed) {
          try {
            res = await actStep(page, graph, ledger, target, { capture, revealPath, statefulProvenance: true, exploreAll, stateDir, marker, runCreatedAccount, runId });
          } catch (err2) { await recordProbe(graph, target, null, { page, prefill: prefillUsed, selfFill, kind: probeKind, blocked: err2?.envelope?.code || (err2?.clicked ? 'POST_CLICK_FAILED' : 'ACT_FAILED') }); await recordFail(err2); throw err2; }
        } else if (!err.clicked && /not attached to the DOM/i.test(String(err?.message || ''))) {
          // THE ELEMENT WAS RE-RENDERED BETWEEN RESOLVE AND CLICK. On a framework that re-renders on every
          // state change this is routine, not a failure of reach: the control is still on the page, the
          // HANDLE is simply stale. Measured in a write-mode run, 5 of 24 acts died this way — the retry
          // path existed but was reachable only after an overlay dismiss, so a detached handle (no overlay
          // involved) fell straight through to unreachable.
          // SAFE TO RETRY because `err.clicked` is false: the click never went through, so re-acting
          // cannot double-fire a mutation. resolveHandle inside actStep re-resolves from scratch.
          try {
            res = await actStep(page, graph, ledger, target, { capture, revealPath, statefulProvenance: true, exploreAll, stateDir, marker, runCreatedAccount, runId });
          } catch (err2) { await recordProbe(graph, target, null, { page, prefill: prefillUsed, selfFill, kind: probeKind, blocked: err2?.envelope?.code || (err2?.clicked ? 'POST_CLICK_FAILED' : 'ACT_FAILED') }); await recordFail(err2); throw err2; }
        } else { await recordProbe(graph, target, null, { page, prefill: prefillUsed, selfFill, kind: probeKind, blocked: err?.envelope?.code || (err?.clicked ? 'POST_CLICK_FAILED' : 'ACT_FAILED') }); await recordFail(err); throw err; }
      } else {
        // NO_INSTANCE / NOT_VISIBLE / DANGER_FLOOR — re-throw so the loop marks it unreachable
        // (coverage unchanged). The instance not resolving on the live page IS the honest outcome
        // when a prior sibling act collapsed its state (the backtracking gap noted in the header).
        await recordProbe(graph, target, null, { page, prefill: prefillUsed, selfFill, kind: probeKind, blocked: err?.envelope?.code || (err?.clicked ? 'POST_CLICK_FAILED' : 'ACT_FAILED') });
        await recordFail(err);
        throw err;
      }
    }

    // OUTSIDE the try, deliberately. Inside it, a throw from the observation landed in the overlay-aware
    // retry branch above and fired the SAME control a second time — under explore-all that is a duplicated
    // destructive act, recorded in the trail as one. An observation that fails is not an act that failed.
    const probeRow = await recordProbe(graph, target, res, { page, prefill: prefillUsed, selfFill, kind: probeKind, seen: seenBefore, domBefore });

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
        // THE VERDICT, in the trail and not only in the graph. An audit of run probe9 could not tell
        // `inert` from `client-change` from `rejected` reading the trail alone — the one distinction the
        // whole outcome layer exists to draw. A trail that cannot answer "what did the page do" forces
        // every consumer back into the graph, and the graph is a snapshot while the trail is the history.
        verdict: probeRow?.verdict || null,
        // WHICH OBLIGATION THIS ACT WAS DISCHARGING. The script picks the next outstanding battery rung
        // (fill-valid / fill-overflow / submit-empty / …) and every recordProbe call is already threaded
        // with it — it was simply never written to the trail: 0 of 355 acts in `hygge2` and 0 of 408 in
        // `goal1` carry it. Without it the trail can say a control was clicked and cannot say what question
        // the click was asking, so "how did it act, and why that way" stays permanently unanswerable there.
        probeKind,
        selfFilled: res.selfFilled === true,
        instanceSelector: target.instance?.instanceSelector ?? null,
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
