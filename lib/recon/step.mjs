// The shared browser step primitive: snapshot a page into the graph, and act on one
// control while capturing exactly the requests it caused. Both whats-new (single
// manual step) and the recon loop-driver (many steps) use these, so the causal
// act+capture sequence — bughunter's whole value — lives in ONE place, not two.

import { snapshotDom } from '../graph/dom-snapshot.mjs';
import { assignId } from '../graph/ids.mjs';
import { mergeSnapshot, addTrigger, toUrlPattern, markOpener, tagParamInstance } from '../graph/graph-store.mjs';
import { beginCause, endCause, waitSettled, resetCause } from '../browser/causal.mjs';
import { settleDom } from '../browser/dom-settle.mjs';
import { dangerFloor, REFUSED, routeRefused, authoredIdOf } from './danger-floor.mjs';
import { routeKey, sameOrigin, isOffOriginHttp } from './scope.mjs';
import { pushNavEdge } from './nav-links.mjs';
import { resolveWithAttempts } from './resolve-handle.mjs';
import { ownsTarget, ownsViaReveal, inOwnableItem, ownsAnyHunt, invisibleMark, ANY_MARK_RE } from './hunt-gate.mjs';
import { actuateAll, actuateField } from './field-actuate.mjs';
import { actuationKindFor, isShapedType } from './probe-kinds.mjs';
import { claimNode, actorKey } from './act-alias.mjs';
import { decide as decidePolicy, OWNERSHIP } from './explore-policy.mjs';
import { openEntry, closeEntry, captureBefore, applyRestore } from './restore-journal.mjs';
import { envelopeError } from '../core/envelope.mjs';
import { captureSkeleton } from '../graph/dom-skeleton.mjs';
import { writeSkeleton } from '../debug/trace.mjs';

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
//
// A SHAPED input (number/range/date/color/…) refuses the mark HARDER: the mark is a zero-width unicode run
// (hunt-gate.invisibleMark), and appending it to a value the browser parses by TYPE — `"0"` into a range,
// a date into `type=date` — yields a string that is no longer a valid value for that type, so `handle.fill`
// throws "Malformed value" and the probe fails on a purely cosmetic marker. Measured: every malformed-fill
// failure in the trails was a shaped field carrying the mark. The mark is pointless there anyway — a numeric
// value has no free text for a mark to hide in, and ownership of a shaped field is proven through the record
// it belongs to, not the scalar. So skip stamping shaped types; keep it on text/textarea where hunt-gate
// reads it back. `factsKind` is what dom-snapshot observed for the field.
export function stampOwnership(field, marker, factsKind) {
  if (!field || !marker) return field;
  if ((field.kind || 'fill') !== 'fill') return field;
  if (isShapedType(factsKind)) return field;
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

// FAILURE-PATH EVIDENCE. A failed act has no key-frame and structurally CANNOT have one: every
// pre-click gate in actStep below (DANGER_FLOOR / NOT_VISIBLE / NO_INSTANCE / DISABLED / the
// explore-all rails / ALIAS_COLLISION) throws before `capture.before` at the bottom of the gate
// stack, and the reveal failures (REVEAL_*) throw from applyReveal before the capture collaborator
// is even constructed. Measured on run raw1 (287 acts): key-frames on 140 of 141 SUCCESSES and 0 of
// 146 FAILURES — structural, not sampling. So the half of the run an operator most needs to see
// ("what did the crawler see when it could not find that control?") had no visual evidence at all.
//
// The DOM skeleton (lib/graph/dom-skeleton.mjs) is what those failures leave behind instead: one
// read-only page.evaluate returning a schematic of the rendered tree, measured CHEAPER than the PNG
// it stands in for. It is called ONLY from the drivers' `recordFail` — never on the success path,
// which already carries `shots` and would pay twice for nothing.
//
// CAUSAL SAFETY is the binding constraint, and it holds BY CONSTRUCTION at every caller — audited
// against the current code, not inherited from the module's own claim:
//   - actStep's gate stack (lines up to the alias claim) runs entirely BEFORE `beginCause`.
//   - the ONE causal window is beginCause → fill → click → endCause; its catch `await resetCause(page)`
//     BEFORE re-throwing, and endCause itself writes `__idle__` back in the same evaluate that reads
//     the fires — so both exits from the window leave the token idle.
//   - everything after endCause (settle, snapshot, merge, restore) already runs under `__idle__`.
//   - applyReveal/replayRevealPath never call beginCause at all (their clicks are deliberately
//     `__idle__` so the token filter drops their fires).
//   - the drivers' pre-navigation policy refusals (OFF_ORIGIN / ROUTE_DANGER) sit between acts, after
//     the previous act's endCause.
// The property is PROVEN by test (tests/unit/fail-skeleton.test.mjs, the causal-proof case reads the
// token the stub page holds at the instant of capture), never merely asserted here.
//
// The capture is BEST-EFFORT and must never change control flow: captureSkeleton never throws and
// writeSkeleton never throws, and this wrapper swallows anyway, so a caller always gets a ref-or-null
// and re-throws its ORIGINAL error with its code untouched — the trail's failure taxonomy
// (failure-hints.mjs) depends on that code arriving unchanged.
//
// STEM: the same `<ordinal>-t<templateId>` shape makeCapture uses for key-frames, because a template
// can fail more than once per run and templateId alone would silently overwrite the earlier evidence
// (the exact defect the capture ordinal was added to fix for shots). The ordinal is a SEPARATE `f`
// counter rather than makeCapture's `a`: trace.mjs's captureSeq is module-private, so an `a` prefix
// here would imply a correspondence between the two ordinals that does not exist. The act↔skeleton
// join is the `skeleton` ref carried in the act.failed payload, not a guessable filename.
// The counter is per-PROCESS, at parity with makeCapture's — bounded here because both drivers that
// call this live in the ONE recon-run process and share this module instance, and two crawls sharing
// a run id is already forbidden (BUGHUNTER_STATE_DIR per run, decisions.md measurement discipline).
let failSkeletonSeq = 0;
export async function captureFailureSkeleton(page, { runId, templateId } = {}) {
  if (!runId || !page) return null;
  try {
    const stem = `f${String(++failSkeletonSeq).padStart(4, '0')}-t${templateId}-fail`;
    return writeSkeleton(runId, stem, await captureSkeleton(page));
  } catch {
    return null; // evidence about a failure must never replace the failure
  }
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
  // The AUTHORED id joins the haystack: an icon-only control has NO accessible name, so a name-only gate
  // is blind to exactly the controls whose labels are icons — including logout. Run goal1 clicked
  // an icon-only logout control (its authored test id names it) and spent its remaining 70% logged out.
  const gateAuthored = authoredIdOf(node, target.instance);
  const floor = dangerFloor({ name: gateName, route: gateRoute, authored: gateAuthored });
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
  const resolved = await resolveWithAttempts(page, target.instance, node);
  if (!resolved.handle) {
    // WHAT WE TRIED, not merely that we failed. The resolver just ran six strategies and measured each
    // one; that record is the answer to "why did it not find that button, and what did it DO to find it".
    // It rides the envelope's structured `target` slot rather than being flattened into the message,
    // because a consumer needs `attempts[i].raw` as a number, not as prose to re-parse.
    //
    // `hadRevealPath` is the field that separates two failures a single NO_INSTANCE conflates: a control
    // we never knew how to reach (no recorded path — a discovery gap) from one whose recorded path BROKE
    // (a path existed and replaying it did not produce the element — a reach regression).
    // PRIVACY: selectors and ids only — no url, so no query string can ride along.
    const evidence = {
      templateId: tid,
      instanceKey: target.instance.instanceKey ?? null,
      selector: sel ?? null,
      attempts: resolved.attempts,
      hadRevealPath: !!(target.instance?.reveal?.statePath?.length || node?.reveal?.statePath?.length),
      locatorType: target.instance?.locator?.type ?? null,
    };
    // Preserve the NO_INSTANCE vs NOT_VISIBLE distinction (the fast-fail contract): a stored selector
    // still present but hidden (and no visible representative) is NOT_VISIBLE; a control gone from the
    // DOM with no live representative is NO_INSTANCE.
    //
    // The stored selector's own attempt already answers this. It used to be re-queried here with a third
    // `page.$(sel)` — one frame after the resolver had asked the identical question twice — so the verdict
    // was decided on a LATER read of a page that may have re-rendered in between. Reading it off the
    // attempt makes the code and the recorded evidence describe the same instant, and removes a DOM
    // roundtrip from the failure path.
    const storedAttempt = resolved.attempts.find((a) => a.strategy === 'selector');
    if (storedAttempt && storedAttempt.raw > 0) {
      throw envelopeError({ code: 'NOT_VISIBLE', message: `instance ${sel} is present but not visible in the current viewport`, target: evidence });
    }
    throw envelopeError({ code: 'NO_INSTANCE', message: `cannot resolve instance ${sel}`, target: evidence });
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
      // Same authored-id widen as the pre-resolve gate above — a durable representative resolved by
      // role+name is exactly where an icon-only control arrives with no name to classify.
      const liveFloor = dangerFloor({ name: liveName || node?.name || target.name, route: routeKey(startUrl), authored: gateAuthored });
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
    // `via`/`representative` ride this return too. It is the ONE success path that skipped them, so an
    // off-origin link was recorded as reached with no statement of HOW it was located — and a
    // representative resolution (a live stand-in for a churned instance) read identically to an exact
    // hit. Same fields, same meaning as the main return below: provenance belongs on every outcome.
    return { cause, requests: [], newElements: [], route: routeKey(startUrl), external: { href }, via, representative };
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
  if (!visible) {
    // A DIFFERENT STORY UNDER THE SAME CODE, and the structured slot is what tells them apart: this
    // NOT_VISIBLE is not "the resolver could not find a visible one" — it RESOLVED one (via `via`) and the
    // element went hidden in the gap before the click. `resolvedVia` is the discriminator; without it both
    // failures read identically in the trail and a layout race is indistinguishable from a dead control.
    throw envelopeError({
      code: 'NOT_VISIBLE',
      message: `instance ${sel} is present but not visible in the current viewport`,
      target: {
        templateId: tid,
        instanceKey: target.instance.instanceKey ?? null,
        selector: sel ?? null,
        resolvedVia: via,
        representative: representative === true,
        hiddenAfterResolve: true,
        locatorType: target.instance?.locator?.type ?? null,
      },
    });
  }

  // DISABLED IS A VERDICT, NOT A WAIT. Playwright's actionability check treats a disabled control as
  // "not ready yet" and retries for the full click timeout before failing — so a permanently disabled
  // button costs 5 seconds to learn nothing. Measured on one pinned run: 16 acts hit this, 83 of 675
  // seconds (12%) spent waiting for elements that were never going to become enabled, and the state a
  // sibling act had just opened often closed while we waited.
  //
  // Asking first is ~10ms and turns the wait into a FINDING: docs/GOAL.md counts "the control announces
  // itself but refuses to be operated" as something to record and attribute, not as noise to time out on.
  // Fails OPEN (unreadable → treat as enabled) so an exotic control still gets its click and its timeout,
  // rather than being silently dropped from coverage by a probe that could not answer.
  const enabled = await handle.isEnabled().catch(() => true);
  if (!enabled) throw envelopeError({ code: 'DISABLED', message: `instance ${sel} is visible but disabled — it cannot be operated in this state` });

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
    prefillResult = await actuateAll(page, prefill.map((pf) => stampOwnership(pf, marker, pf.factsKind)), { stateDir });
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
      try {
        const factsKind = graph.elements[target.templateId]?.fieldFacts?.kind;
        selfFilled = await fillTarget(handle, stampOwnership({ value: fill }, marker, factsKind).value, {
          page, factsKind, stateDir, selfTarget: true,
        });
      } catch (fillErr) {
        // TAG THE THROW SITE. A native input[type=number|date|…] REFUSES a wrong-shape fill by THROWING
        // (handle.fill('not-a-number') → "Malformed value"), rather than coercing it as a text/AntD input
        // would. Only the throw site can say the FILL — not the click after it — is what failed, and the
        // caller needs that to record NOT_FILLABLE (the field enforced its shape, a terminal answer) rather
        // than a transient ACT_FAILED that would leave the shape probe owed forever. Guessing this from the
        // error message downstream is the message-sniffing this project keeps getting burned by; the flag is
        // evidence, not inference.
        fillErr.duringFill = true;
        throw fillErr;
      }
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
    //
    // ORIGIN + STARTEDAT are the EVIDENCE fields (never identity): `urlPattern` is path-shaped and
    // deliberately host-less, so a trail could say a request was refused "off-origin" while holding
    // nothing an operator could check that claim against. NOTE the dedup key below is unchanged
    // (method + urlPattern, so the census still folds a 50-row listing into one) — two hosts sharing
    // a path therefore collapse onto ONE record and the FIRST origin seen wins. That is a known,
    // deliberately-accepted narrowing: widening the key would change how many request records an act
    // emits, which is the census semantics this field exists to leave alone.
    const req = {
      method: f.method,
      urlPattern,
      origin: f.origin ?? null,
      startedAt: f.startedAt ?? null,
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
