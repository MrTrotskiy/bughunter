// The shared browser step primitive: snapshot a page into the graph, and act on one
// control while capturing exactly the requests it caused. Both whats-new (single
// manual step) and the recon loop-driver (many steps) use these, so the causal
// act+capture sequence — bughunter's whole value — lives in ONE place, not two.

import { snapshotDom } from '../graph/dom-snapshot.mjs';
import { assignId } from '../graph/ids.mjs';
import { mergeSnapshot, addTrigger, toUrlPattern, markOpener, tagParamInstance } from '../graph/graph-store.mjs';
import { beginCause, endCause, waitSettled, resetCause } from '../browser/causal.mjs';
import { settleDom } from '../browser/dom-settle.mjs';
import { dangerFloor, REFUSED, routeRefused } from './danger-floor.mjs';
import { routeKey, sameOrigin, isOffOriginHttp } from './scope.mjs';
import { pushNavEdge } from './nav-links.mjs';
import { resolveHandle } from './resolve-handle.mjs';
import { ownsTarget, ownsViaReveal, inOwnableItem, ownsAnyHunt, invisibleMark, ANY_MARK_RE } from './hunt-gate.mjs';
import { actuateAll, actuateField } from './field-actuate.mjs';
import { actuationKindFor } from './probe-kinds.mjs';
import { claimNode, actorKey } from './act-alias.mjs';
import { decide as decidePolicy, OWNERSHIP } from './explore-policy.mjs';
import { openEntry, closeEntry, captureBefore, applyRestore } from './restore-journal.mjs';
import { envelopeError } from '../core/envelope.mjs';

// Controls the fire path REFUSES to click (REFUSED — the single source in danger-floor.mjs,
// shared with the recon-run navigation guard). The coarse floor is a backstop, not the judge,
// but it must guard the ACT, not just the post-hoc record: an obvious delete/logout/checkout
// is never fired, whatever path reached actStep (whats-new --act-template, the loop, a mis-
// judging agent). Under EXPLORE-ALL this floor does NOT gate — the mode exists to fire those
// controls — and explore-policy.mjs supplies the one rail that survives (foreign content).

// Mint stable ids onto each element (template + instance) before merge.
export function idify(ledger, elements) {
  for (const el of elements) {
    el.templateId = assignId(ledger, 'tpl:' + el.templateSelector);
    el.instanceId = assignId(ledger, 'inst:' + el.templateSelector + '::' + String(el.instanceKey));
  }
  return elements;
}

// Fill the target HANDLE if it is itself fillable, else the nearest input in its form/container.
// Takes the RESOLVED handle (not a selector) so a durable-locator / representative act fills the LIVE
// element actStep is about to click, never a stale positional selector. Returns whether anything filled.
//
// TYPED FIRST. `handle.fill()` is defined for <input>/<textarea> only, so a radio, an antd Select, a date
// picker or a file input silently took the sibling branch and filled some UNRELATED input nearby — or
// returned false and the field was recorded as touched-but-inert. `actuateField` already implements all six
// actuation modes; `actuationKindFor` is the one map from what dom-snapshot OBSERVED to how to drive it, and
// bypassing it is the exact drift `probe-kinds.mjs` exists to prevent.
async function fillTarget(handle, value, { page, factsKind, stateDir, selfTarget = false } = {}) {
  if (!handle) return false;
  if (page && factsKind) {
    const kind = actuationKindFor(factsKind);
    if (kind !== 'fill') {
      const done = await actuateField(page, handle, { kind, value }, { stateDir }).catch(() => false);
      if (done) return true;
    }
  }
  // Bounded fill: a hidden/disabled/readonly input would otherwise stall Playwright's full
  // 30s default action timeout on the fill actionability check — the same stall the click
  // gate kills. Fail in seconds instead.
  const fillable = await handle.evaluate((el) => ['input', 'textarea'].includes(el.tagName.toLowerCase())).catch(() => false);
  if (fillable) { await handle.fill(value, { timeout: 5000 }); return true; }
  // THE SIBLING FALLBACK IS FOR A DIFFERENT JOB. When the target is a SUBMIT and we are populating the form
  // around it, filling the nearest input is the point. When the target IS the field being probed, filling a
  // neighbour answers nothing about the target and would record the neighbour's behaviour under the
  // target's name — so for a self-target the honest answer is "could not fill it".
  if (selfTarget) return false;
  const sib = await handle.evaluateHandle((el) => {
    const scope = (el.closest('form') || el.parentElement) || document;
    return scope.querySelector('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea');
  });
  const elh = sib.asElement();
  if (elh) { await elh.fill(value, { timeout: 5000 }); return true; }
  return false;
}

// Stamp the run's ownership mark into a value that does not already carry one.
//
// The mark is INVISIBLE (zero-width, hunt-gate.invisibleMark). A visible `[HUNT-<runId>]` prefix worked as
// a proof but announced to any human reading the site that a bot wrote the content — the opposite of how a
// QA engineer's test data looks. The invisible mark satisfies both: the page reads as ordinary content, and
// ownsTarget/ownsAnyHunt can still prove the item is ours before any edit or delete.
//
// form-fill already marks the values it generates, so stamping again here would apply the mark TWICE.
// ANY_MARK_RE detects an existing mark and leaves the value alone. Only a text value can carry a mark —
// a select, checkbox or upload has no string for one to live in.
function stampOwnership(field, marker) {
  if (!field || !marker) return field;
  if ((field.kind || 'fill') !== 'fill') return field;
  const v = String(field.value ?? '');
  if (!v || ANY_MARK_RE.test(v)) return field;
  return { ...field, value: v + invisibleMark(marker) };
}

// Snapshot the current page → mint ids → merge into the graph. Returns the baseline
// counters (total elements, how many were new, opaque regions seen).
export async function snapshotStep(page, graph, ledger, route) {
  const snap = await snapshotDom(page);
  idify(ledger, snap.elements);
  const merge = mergeSnapshot(graph, route, snap.elements);
  return {
    total: snap.elements.length,
    new: merge.newTemplates.length + merge.newInstances.length,
    opaque: snap.opaque.length,
  };
}

// Act on one control (target = { templateId, instance:{ instanceSelector } }) and
// report what it CAUSED (requests bound by token + initiator) and REVEALED (new
// instances a re-snapshot found), plus the `route` it LANDED on (routeKey of page.url()
// after settle — may differ from where it started if the act navigated). The revealed
// elements are merged under that LANDED route, so a nav act discovers a new page's
// controls under the correct route, not the one it started on. The origin comes from the
// page's CURRENT url (the caller already gated-navigated there), so no route/base
// parameter is threaded in. Throws NO_INSTANCE if the instance no longer resolves,
// NOT_VISIBLE if it is present but hidden.
export async function actStep(page, graph, ledger, target, { fill, prefill, capture, revealPath, openerReplayable, statefulProvenance, marker, runCreatedAccount, exploreAll, stateDir, runId } = {}) {
  const sel = target.instance.instanceSelector;
  const tid = target.templateId;

  // Fire-path danger gate: refuse to touch the page (no fill, no click) for an obvious
  // destructive/auth/payment control. Uses the graph node when present, else falls back
  // to the target's own name/route so a manual --act-template is guarded too.
  const node = graph.elements[tid];
  const gateName = node?.name ?? target.name;
  const gateRoute = node?.route ?? target.route;
  const floor = dangerFloor({ name: gateName, route: gateRoute });
  if (exploreAll) {
    // EXPLORE-ALL (explore-policy.mjs): the blanket REFUSED gate does NOT apply — destructive, payment,
    // communication and unknown controls are all fired, because a control nobody clicks is a control
    // nobody can classify. Only ONE verdict is decidable here, before a handle exists: account deletion,
    // which is name-scoped and has no item marker to read. Every other decision needs the live ownership
    // proof and is taken after resolveHandle, at the ownership rail below.
    const pre = decidePolicy({ name: gateName, route: gateRoute, ownership: OWNERSHIP.NONE, runCreatedAccount });
    if (!pre.allow) {
      throw envelopeError({ code: pre.code, message: `${pre.reason} — "${gateName ?? sel}" (template ${tid})`, exit: 'VIOLATION' });
    }
  } else if (REFUSED.has(floor)) {
    throw envelopeError({
      code: 'DANGER_FLOOR',
      message: `refusing to fire a ${floor} control "${gateName ?? sel}" (template ${tid})`,
      exit: 'VIOLATION',
    });
  }

  const cause = String(tid);
  const startUrl = page.url();
  // explore-all bookkeeping, declared here because the href gate below sets the re-login flag before the
  // ownership rail runs: `exploreEntry` is the open restore-journal row for a foreign edit (settled by a
  // restore pass), `exploreRelogin` says this act ends the session so the driver re-authenticates.
  let exploreEntry = null;
  let exploreRelogin = false;
  // Resolve BEFORE setting the cause token (an unreachable control must not strand a cause). DURABLE
  // resolution (resolve-handle.mjs): the stored positional instanceSelector first (the exact instance),
  // else the durable locator (page-unique id, else a role+name LIVE REPRESENTATIVE) — so a stale nth-child
  // on a re-rendering feed keeps the control reachable, not a premature NO_INSTANCE. No causal window, no
  // graph mutation.
  const resolved = await resolveHandle(page, target.instance, node);
  if (!resolved) {
    // Preserve the NO_INSTANCE vs NOT_VISIBLE distinction (the fast-fail contract): a stored selector
    // still present but hidden (and no visible representative) is NOT_VISIBLE; a control gone from the
    // DOM with no live representative is NO_INSTANCE.
    const raw = await page.$(sel).catch(() => null);
    if (raw) throw envelopeError({ code: 'NOT_VISIBLE', message: `instance ${sel} is present but not visible in the current viewport` });
    throw envelopeError({ code: 'NO_INSTANCE', message: `cannot resolve instance ${sel}` });
  }
  const { handle, via, representative } = resolved;

  // REPRESENTATIVE safety (mirrors reveal-replay.mjs's H1 pre-click guards): a role-name match may be a
  // DIFFERENT live element than the stored instance, so the stored name can't be trusted — re-run the
  // danger-floor on the LIVE handle's own name (+ the current route) so a re-located destructive/auth/
  // payment control is refused BEFORE the click, not fired on a stale-name pass.
  if (representative) {
    const liveName = await handle.evaluate((el) => {
      const pick = (v) => (v && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, 80) : '');
      return pick(el.getAttribute('aria-label')) || pick(el.textContent) || pick(el.getAttribute('placeholder')) || pick(el.getAttribute('title'));
    }).catch(() => null);
    if (exploreAll) {
      // explore-all: re-run the ONE name-decidable refusal on the LIVE name, so a representative that
      // re-located onto a "Delete account" is caught even though the stored name said otherwise. The
      // foreign-content rail below reads this same live handle, so ownership is never taken on trust.
      const liveN = liveName || node?.name || target.name;
      const liveVerdict = decidePolicy({ name: liveN, ownership: OWNERSHIP.NONE, runCreatedAccount });
      if (!liveVerdict.allow) {
        throw envelopeError({ code: liveVerdict.code, message: `${liveVerdict.reason} — live representative "${liveN || sel}" (template ${tid})`, exit: 'VIOLATION' });
      }
    } else {
      const liveFloor = dangerFloor({ name: liveName || node?.name || target.name, route: routeKey(startUrl) });
      if (REFUSED.has(liveFloor)) {
        throw envelopeError({
          code: 'DANGER_FLOOR',
          message: `refusing to fire a ${liveFloor} live representative "${liveName || node?.name || sel}" (template ${tid})`,
          exit: 'VIOLATION',
        });
      }
    }
  }

  // Origin scope on the LIVE handle (exact or representative): never FIRE an off-origin HTTP link.
  // Clicking it would navigate the page out of scope (the SSRF gate only guards OUR gotoGated calls, not
  // a browser link-follow), burn budget on a foreign site, and pollute the graph. Record it as reachable-
  // but-not-fired (external) and return — the caller counts it, never marks it unreachable. Only http(s)
  // cross-origin links qualify: a javascript:/mailto:/tel: href is an in-page control or a no-op and
  // falls through to the normal click (isOffOriginHttp gates that).
  const href = await handle.evaluate((el) => (el.tagName === 'A' && el.href) ? el.href : null);
  if (href && isOffOriginHttp(startUrl, href)) {
    return { cause, requests: [], newElements: [], route: routeKey(startUrl), external: { href } };
  }
  // Same-origin DANGER-ROUTE href gate (security H1): an icon-only <a href="/logout"> or an
  // /item/42/delete link with NO accessible name slips the name-floor above and, as a GET, would
  // navigate/delete on click — the name gate never sees the destination. Refuse BEFORE the click on
  // the SAME already-computed href (mirrors reveal-replay.mjs's pre-click route gate). Throws here, so
  // EVERY actStep caller (persistentStep + whats-new + statefulStep) is protected, not just recon-run.
  // Lifted under explore-all: an icon-only <a href="/logout"> is exactly the kind of control the mode
  // exists to classify. It is fired, and the driver re-authenticates afterwards (result.needsRelogin).
  if (href && !exploreAll && routeRefused(routeKey(href))) {
    throw envelopeError({ code: 'DANGER_FLOOR', message: `refusing to click a link to a danger route ${routeKey(href)} (template ${tid})`, exit: 'VIOLATION' });
  }
  // An explore-all click on a danger-route link ends the session just as a named logout does — flag it
  // so the driver re-logins, otherwise the rest of the crawl silently proceeds logged out.
  if (href && exploreAll && routeRefused(routeKey(href))) exploreRelogin = true;

  // EXPLORE-ALL ownership rail — the ONE refusal left in this mode, and the restore bracket.
  // Ownership is read LIVE off the resolved handle (never taken on the agent's word):
  //   OWN     — our HUNT marker, from THIS run (ownsTarget) or ANY prior run (ownsAnyHunt), including the
  //             portal-dropdown case where the marker lives on the reveal TRIGGER's item, not the control's.
  //   NONE    — not inside a content item at all (a nav control, a create composer): nothing to own.
  //   FOREIGN — a real item carrying no marker of ours → editable-with-restore, never deletable.
  if (exploreAll) {
    let ownership;
    if (await ownsTarget(handle, marker) || await ownsAnyHunt(handle)) ownership = OWNERSHIP.OWN;
    else if (revealPath && revealPath.length && marker && await ownsViaReveal(page, graph, revealPath, marker)) ownership = OWNERSHIP.OWN;
    else if (!(await inOwnableItem(handle))) ownership = OWNERSHIP.NONE;
    else ownership = OWNERSHIP.FOREIGN;

    const verdict = decidePolicy({ name: gateName, route: gateRoute, ownership, runCreatedAccount });
    if (!verdict.allow) {
      throw envelopeError({ code: verdict.code, message: `${verdict.reason} — "${gateName ?? sel}" (template ${tid})`, exit: 'VIOLATION' });
    }
    // A logout is FIRED, not refused — the caller re-authenticates afterwards (login.mjs), so the control
    // gets classified without the crawl ending its own session and dumping the remainder onto /login.
    exploreRelogin = !!verdict.needsRelogin;
    // Capture-then-journal BEFORE the click, so a crash mid-act still leaves a replayable rollback on
    // disk. The entry stays OPEN until a restore pass writes the original back — an edit whose rollback
    // never ran is visible as a pending entry, never silently forgotten.
    if (verdict.needsRestore && stateDir) {
      const before = await captureBefore(handle);
      if (before) {
        exploreEntry = openEntry(stateDir, {
          runId: runId || null, route: gateRoute, url: startUrl,
          templateId: tid, instanceKey: target.instance.instanceKey, name: gateName, before,
        });
      }
    }
  }

  // Defensive visibility re-check: resolveHandle already returned a visible handle, but a fast layout
  // change could hide it between resolve and click — keep the cheap fast-fail rather than hang the click.
  const visible = await handle.isVisible().catch(() => false);
  if (!visible) throw envelopeError({ code: 'NOT_VISIBLE', message: `instance ${sel} is present but not visible in the current viewport` });

  // Debug capture — BEFORE frame. Taken here on purpose: the cause is still __idle__ and no
  // click has fired, so the viewport screenshot cannot enter the causal window. Captures the
  // pristine state + the target's rect (the highlight box the admin draws).
  const before = capture ? await capture.before(page, handle) : null;

  // REVEAL PROVENANCE (Fable design): the set of controls VISIBLE IMMEDIATELY BEFORE this act, so
  // mergeSnapshot can tell which controls THIS act revealed — a portal dropdown menuitem that MOUNTS on open
  // is NOT in this set but is visible after → revealed by this act → backfill its reveal path (the fix for
  // the in-app-state NO_INSTANCE gap, superseding the structurally-always-false `hiddenWhenSeen` for mount-on-
  // reveal controls). Captured ONLY when this act carries a reveal path to stamp (an opener replay); a
  // read-only page.evaluate under __idle__ (before beginCause) — it opens no causal window, forges no edge.
  const preVisible = revealPath
    ? new Set((await snapshotDom(page)).elements.filter((e) => e.visible).map((e) => `${e.templateSelector}::${e.instanceKey}`))
    : undefined;

  // PREFILL (multi-step form support): fill AUXILIARY fields (a composer textarea, a required input) BEFORE
  // clicking the target (a Post/Submit/Save button), in ONE act — so a CREATE whose value lives in a separate
  // field commits on the re-navigating agent path, where a separate fill act would be lost on the next
  // navigation. Each prefill is {selector, value}; the value gets the HUNT-<runId> marker so the created
  // content is provably OURS. Best-effort: a selector that does not resolve is skipped (the click still fires).
  // Actuation is TYPED (field-actuate.mjs): a select is opened and picked, a picker's cell is clicked, a
  // file input is set. Filling was the only mode before, and it is the reason a create form with a
  // required dropdown could never submit.
  let prefillResult = null;
  if (Array.isArray(prefill)) {
    prefillResult = await actuateAll(page, prefill.map((pf) => stampOwnership(pf, marker)), { stateDir });
  }
  // ALIAS GATE — refuse to act on a node another instance already acted on. Taken HERE, immediately
  // before the click, and deliberately not earlier: every refusal path above (danger floor, off-origin,
  // route danger, the ownership rail) returns or throws WITHOUT clicking, and a claim stamped before
  // them would mark a node we never acted on. A later legitimate instance resolving there would then be
  // refused with a collision naming an act that never happened — a false record, in a mechanism whose
  // whole purpose is telling us when a record is false.
  const claim = await claimNode(handle, actorKey(target.templateId, target.instance?.instanceKey));
  if (!claim.ok) {
    throw envelopeError({
      code: 'ALIAS_COLLISION',
      message: `instance resolved (via ${via}) onto the node already acted for ${claim.heldBy} — identity unproven, not acted`,
    });
  }

  let fires;
  let seq0;
  let selfFilled = false;
  let clicked = false;
  const tAct = performance.now();
  try {
    seq0 = await beginCause(page, cause);
    // FILLING THE TARGET IS PART OF THE ACT, so it belongs INSIDE the causal window — unlike `prefill`
    // above, which is setup for a different element's commit. On a search box the entire observable IS the
    // keystroke-triggered request: typing fires a debounced XHR and the subsequent click fires nothing.
    // With the fill outside the window that request had no open cause, so every search field on the target
    // recorded `inert` — the field was doing its job and we were looking away while it did it.
    // Stamp the per-run ownership marker so created/edited content is provably OURS (the proof the
    // foreign-content rail reads back) and cleanup can find it.
    if (fill != null && fill !== '') {
      // WHETHER IT ACTUALLY FILLED IS THE FACT WE RECORD. Discarding this boolean is how a probe row comes
      // to claim `fill-valid` for a field nothing was typed into: a readonly input, a widget whose typed
      // actuation failed, a control that is not a field at all. A row minted from INTENTION rather than
      // outcome is the exact shape of every inflated number this project has had to walk back.
      selfFilled = await fillTarget(handle, stampOwnership({ value: fill }, marker).value, {
        page, factsKind: graph.elements[target.templateId]?.fieldFacts?.kind, stateDir, selfTarget: true,
      });
    }
    // Bounded click timeout: a visible-but-transiently-unclickable control (covered,
    // animating) fails in seconds, not 30s, and the cause token is reset on throw.
    await handle.click({ timeout: 5000 });
    clicked = true;
    fires = await endCause(page, seq0, cause);
  } catch (err) {
    await resetCause(page); // click failed mid-window — never strand the cause on a reused page
    // DID THE CLICK ALREADY HAPPEN? A failure in endCause / settle / snapshot lands here too, and by then
    // the control has FIRED. Retrying it would fire it a second time — under explore-all that is a
    // duplicated real write on the operator's stand, and the restore journal would open a second entry for
    // an edit that happened once. The caller distinguishes the two so only a PRE-click failure is retried.
    err.clicked = clicked;
    throw err;
  }
  const actMs = Math.round(performance.now() - tAct); // the causal window ONLY (no capture/settle)

  const requests = [];
  const seen = new Set();
  for (const f of fires) {
    const urlPattern = toUrlPattern(f.url);
    const rk = `${f.method} ${urlPattern}`;
    if (seen.has(rk)) continue;
    seen.add(rk);
    // Carry the causally-joined response metadata (attached in endCause) onto the request:
    // status/resourceType summarize onto the graph node (addTrigger), and all three ride
    // the returned requests[] so the debug trail preserves the per-act request↔response pair.
    const req = {
      method: f.method,
      urlPattern,
      status: f.status ?? null,
      resourceType: f.resourceType ?? null,
      durationMs: f.durationMs ?? null,
    };
    addTrigger(graph, tid, req);
    requests.push(req);
  }

  const tSettle = performance.now();
  await waitSettled(page);
  // WAIT FOR THE PAGE TO STOP CHANGING, not merely for the network to go quiet. An AntD dropdown or modal
  // mounts from client state and issues NO request, so `waitSettled` returns instantly and truthfully while
  // the revealed panel does not exist yet — and the control then records `inert`: no request, no revealed
  // template, nothing at all.
  //
  // Measured on the live target: 925 DOM nodes and 0 dropdowns before clicking `more_horiz`, 925 and 0
  // IMMEDIATELY after, 942 and 2 after 700ms. It opened a 17-node menu every time and we filed it as dead
  // surface. On run probe10 that shape was 17 of the 25 elements stuck at L2.
  //
  // NOT `settleAnimations`, which was tried here first and measured returning `true` after ONE millisecond
  // with zero dropdowns present — at that instant nothing is animating, because the thing that will animate
  // has not mounted. See dom-settle.mjs for why a mutation-quiet predicate is the signal that covers a
  // reveal regardless of what drives it.
  //
  // Runs under `__idle__` — `endCause` closed the window above — so it forges no edge, and it is bounded by
  // its own deadline.
  await settleDom(page).catch(() => null);
  const settleMs = Math.round(performance.now() - tSettle);
  const landedUrl = page.url();
  const landedRoute = routeKey(landedUrl);
  const tSnap = performance.now();
  const after = await snapshotDom(page);
  const snapMs = Math.round(performance.now() - tSnap);
  idify(ledger, after.elements);
  // Merge the revealed controls under the route the act LANDED on — but only if we are
  // still on the same origin. A JS onclick that redirected off-origin (slipping the href
  // check above) must not pollute the graph with a foreign page; the next act re-navigates
  // back in-scope, so nothing is lost. In that case report the IN-SCOPE start route, not the
  // foreign pathname (which would falsely read as an in-scope navigation to the agent).
  let newElements = [];
  let newlyReachable = [];
  let route = routeKey(startUrl);
  if (sameOrigin(startUrl, landedUrl)) {
    // GAP 2: stamp reveal only on a stay-on-page act. Default replayability is ALL-GET (a mutating
    // opener's children stay unreachable — the safe deterministic ceiling the node loop keeps).
    // openerReplayable is an OPT-IN widen for a POST-that-READS opener (apps like the first target fire
    // read/list queries over POST): the AGENT path sets it ONLY after judging the caused requests
    // are non-mutating, so those children become replayable too. The node loop never sets it, so
    // its GET-only ceiling is unchanged. The danger-floor still refuses destructive/auth/payment
    // openers by name regardless, so the widened residual is a non-floored generic write.
    // statefulProvenance is the METHOD-AGNOSTIC widen: stateful mode stamps reveal as a REPORTING
    // breadcrumb (location honesty), not a replay path, so it drops the GET-only gate — nothing replays
    // it, so the method it was recorded under carries no replay risk.
    // The stamp is marked stateful:true so consumers tell a provenance breadcrumb from a replayable path.
    const allGet = requests.every((r) => String(r.method || 'GET').toUpperCase() === 'GET');
    // EXPLORE-ALL joins the widen list. The GET-only default exists so a MUTATING opener is never
    // re-fired during a later replay — a safety ceiling that is void in a mode which commits writes
    // deliberately. Measured cost of leaving it on: on the first target's POST-read /dashboard only 22% of
    // instances got a reveal path stamped (vs 81-92% on GET-only form pages), so 83 of 100 NO_INSTANCE
    // failures were controls that never had a path to replay in the first place.
    const stamp = revealPath && landedRoute === route
      && (statefulProvenance === true || allGet || openerReplayable === true || exploreAll === true);
    // A1: a measured act that LANDED on a different same-origin route is an onClick/pushState navigation —
    // record it as a structural page→page nav edge (via = the causal control to click). Observed from the
    // committed page.url(), NOT a causal window: it never addTriggers, never touches request attribution.
    if (landedRoute !== route) pushNavEdge(graph, route, landedRoute, { provenance: 'act', via: tid });
    route = landedRoute;
    const afterMerge = mergeSnapshot(graph, landedRoute, after.elements, stamp ? { revealPath, stateful: statefulProvenance === true, preVisible } : {});
    tagParamInstance(graph, landedRoute); // GOAL 2: a drill-act that navigated to a concrete /x/123 links it to /x/:param (metadata, post-endCause)
    newElements = afterMerge.newInstances.map((i) => ({ templateId: i.templateId, instanceKey: i.instanceKey }));
    // "panel reach" fill: pre-existing PATHLESS controls this act just made VISIBLE — they acquired
    // a reveal path and shed `unreachable` (graph-store mergeSnapshot). Count them toward the reveal
    // effect so a pure-UNCOVER opener (a "…more" that reveals already-in-DOM tabs, adding NO new
    // instances) is still flagged an opener and re-emitted for its now-reachable children.
    newlyReachable = afterMerge.filled || [];
    // OPENER detection (state model): this control revealed new instances OR uncovered hidden ones
    // WITHOUT leaving the route — a stay-on-page opener. Flag its template so the frontier walks its
    // OTHER instances too (a nav bar of 3 links that are instances of one template gets all three
    // explored, not just the first; a "…more" that uncovers hidden tabs gets them re-emitted).
    if ((newElements.length + newlyReachable.length) > 0 && landedRoute === routeKey(startUrl)) markOpener(graph, tid);
  }
  // HONEST representative marker: reached via a LIVE role-name representative, not the exact stored
  // positional instance. report() surfaces viaRepresentative so the TEMPLATE reads covered without
  // claiming that specific (possibly vanished) instance was individually tested. A genuinely-gone control
  // with no live representative never gets here (resolveHandle → null → NO_INSTANCE), so no over-count.
  if (representative) {
    const gInst = node?.instances?.find((i) => i.instanceKey === target.instance.instanceKey);
    if (gInst) gInst.viaRepresentative = true;
  }
  const result = { cause, requests, newElements, route, via, representative, selfFilled };
  if (newlyReachable.length) result.newlyReachable = newlyReachable;
  // Which fields we actually managed to actuate. Without this, a form that submits nothing is
  // indistinguishable from a form we never filled — and for six runs it was read as the former when it
  // was the latter. `skipped` names the field, so the next diagnosis starts from a selector, not a guess.
  if (prefillResult) result.prefill = prefillResult;
  // SETTLE THE ROLLBACK. The journal entry was opened BEFORE the click with the item's original field
  // values; now that the act (and its settle) are done, write them back and close the entry. This runs
  // under __idle__ — endCause has already reset the cause — so the restore's own fills forge no causal
  // edge. Best-effort by nature: if the item no longer resolves (the edit navigated away, the row
  // re-rendered), the entry closes as `failed` and stays visible in `pendingEntries` for a later pass to
  // retry. It is never optimistically marked restored — an unrestored edit to someone else's content is
  // exactly the thing that must not be silently forgotten.
  if (exploreEntry && stateDir) {
    const r = await applyRestore(page, exploreEntry.before).catch((err) => ({ ok: false, restored: 0, detail: err?.message || 'restore threw' }));
    closeEntry(stateDir, exploreEntry.seq, r.ok ? 'restored' : 'failed', r.detail);
    result.restored = r.ok;
    if (!r.ok) result.restoreFailed = r.detail || true;
  }
  // explore-all bookkeeping the DRIVER acts on: an open rollback to settle, and whether this act ended
  // the session (so the driver re-logins before the next act rather than crawling as an anonymous user).
  if (exploreEntry) result.restoreSeq = exploreEntry.seq;
  if (exploreRelogin) result.needsRelogin = true;
  if (capture) {
    // AFTER frame — the cause was reset by endCause (or resetCause on throw), so we are
    // __idle__ again; this viewport shot shows the EFFECT (a revealed modal / new rows).
    const after2 = await capture.after(page);
    result.debug = { timings: { actMs, settleMs, snapMs }, before, after: after2 };
    // BODIES (only when BUGHUNTER_CAPTURE_BODIES=1 attached a redacted body to a kept fire):
    // they flow to the TRAIL as file REFS, NEVER into requests[] (which reaches stdout + the
    // graph node). Bodies are per-instance and never touch the graph — a POST returns a
    // different body each call and would fight the urlPattern masking.
    if (capture.bodies) {
      const withBody = fires
        .filter((f) => f.reqBody != null || f.respBody != null)
        .map((f) => ({ method: f.method, urlPattern: toUrlPattern(f.url), mimeType: f.mimeType, reqBody: f.reqBody, respBody: f.respBody }));
      if (withBody.length) result.debug.bodies = capture.bodies(withBody);
    }
  }
  return result;
}
