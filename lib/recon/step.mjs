// The shared browser step primitive: snapshot a page into the graph, and act on one
// control while capturing exactly the requests it caused. Both whats-new (single
// manual step) and the recon loop-driver (many steps) use these, so the causal
// act+capture sequence — bughunter's whole value — lives in ONE place, not two.

import { snapshotDom } from '../graph/dom-snapshot.mjs';
import { assignId } from '../graph/ids.mjs';
import { mergeSnapshot, addTrigger, toUrlPattern, markOpener, tagParamInstance } from '../graph/graph-store.mjs';
import { beginCause, endCause, waitSettled, resetCause } from '../browser/causal.mjs';
import { dangerFloor, mutationFloor, REFUSED, routeRefused, isAccountDeletion, requiresOwnership } from './danger-floor.mjs';
import { routeKey, sameOrigin, isOffOriginHttp } from './scope.mjs';
import { pushNavEdge } from './nav-links.mjs';
import { resolveHandle } from './resolve-handle.mjs';
import { ownsTarget, ownsViaReveal } from './hunt-gate.mjs';
import { envelopeError } from '../core/envelope.mjs';

// Controls the fire path REFUSES to click (REFUSED — the single source in danger-floor.mjs,
// shared with the recon-run navigation guard). The coarse floor is a backstop, not the judge,
// but it must guard the ACT, not just the post-hoc record: an obvious delete/logout/checkout
// is never fired, whatever path reached actStep (whats-new --act-template, the loop, a mis-
// judging agent). The deliberate-mutation phase (your OWN HUNT-tagged control) is a future override.

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
async function fillTarget(handle, value) {
  if (!handle) return false;
  // Bounded fill: a hidden/disabled/readonly input would otherwise stall Playwright's full
  // 30s default action timeout on the fill actionability check — the same stall the click
  // gate kills. Fail in seconds instead.
  const fillable = await handle.evaluate((el) => ['input', 'textarea'].includes(el.tagName.toLowerCase())).catch(() => false);
  if (fillable) { await handle.fill(value, { timeout: 5000 }); return true; }
  const sib = await handle.evaluateHandle((el) => {
    const scope = (el.closest('form') || el.parentElement) || document;
    return scope.querySelector('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea');
  });
  const elh = sib.asElement();
  if (elh) { await elh.fill(value, { timeout: 5000 }); return true; }
  return false;
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
export async function actStep(page, graph, ledger, target, { fill, prefill, capture, revealPath, openerReplayable, refuseMutations, revealOpener, statefulProvenance, huntWrites, marker, runCreatedAccount, huntWindow } = {}) {
  const sel = target.instance.instanceSelector;
  const tid = target.templateId;

  // Fire-path danger gate: refuse to touch the page (no fill, no click) for an obvious
  // destructive/auth/payment control. Uses the graph node when present, else falls back
  // to the target's own name/route so a manual --act-template is guarded too.
  const node = graph.elements[tid];
  const gateName = node?.name ?? target.name;
  const gateRoute = node?.route ?? target.route;
  const floor = dangerFloor({ name: gateName, route: gateRoute });
  if (huntWrites) {
    // WRITE-HUNT mode (operator-armed): relax the read-only refusals so SAFE own-content mutations COMMIT —
    // create/edit-own/delete-own/comment/like/chat/call/pay are allowed. The ONE hard rail (never edit/delete
    // NON-owned content) is enforced by the DOM ownsTarget marker + the firewall's destructive method-gate
    // (below). Two name-checkable exceptions stay refused here (no handle needed): (1) AUTH — logging out mid-
    // crawl ends the authed session (not in the allowed set; test logout separately); (2) ACCOUNT-DELETION —
    // NAME-scoped (route excluded so a content-delete on an /account route is NOT misclassified into skipping
    // the ownsTarget rail), allowed ONLY when THIS run created the account (a disposable agent-made account is
    // fair game, a persistent test account is not). The off-origin + danger-route href gates below STILL run.
    if (floor === 'auth') {
      throw envelopeError({ code: 'DANGER_FLOOR', message: `refusing an auth control "${gateName ?? sel}" in hunt mode (would end the session) (template ${tid})`, exit: 'VIOLATION' });
    }
    if (isAccountDeletion({ name: gateName }) && !runCreatedAccount) {
      throw envelopeError({
        code: 'HUNT_ACCOUNT_PROTECTED',
        message: `refusing to delete an account this run did not create "${gateName ?? sel}" (template ${tid})`,
        exit: 'VIOLATION',
      });
    }
  } else if (REFUSED.has(floor)) {
    throw envelopeError({
      code: 'DANGER_FLOOR',
      message: `refusing to fire a ${floor} control "${gateName ?? sel}" (template ${tid})`,
      exit: 'VIOLATION',
    });
  }
  // ADDITIVE read-only mutation gate (opt-in — the default crawl never sets refuseMutations, so default
  // behavior is unchanged): in a read-only crawl a control literally NAMED with a mutation verb
  // (Follow/Like/…) is refused BEFORE the click. This covers the write the network firewall's URL-path
  // gate CANNOT see — a mutation-named control firing a BENIGN-named endpoint. An icon control (no name →
  // mutationFloor 'unknown') is NOT refused here and falls through to the network gate, which aborts its
  // write while the causal edge still records (the map is preserved). Defense in depth, not the enforcer.
  //
  // REVEAL-OPENER (agent-judged, opt-in): a mutation-NAMED control that OPENS a form/modal (a READ that
  // reveals UI — "Create post" → the composer) rather than SUBMITTING. When the agent judges this, the
  // click is allowed so the revealed compose surface is COLLECTED, and the network write-firewall stays
  // the HARD net that ABORTS any actual submit POST the click fires (server side-effect prevented, the
  // causal map preserved). It exempts ONLY this softer 'mutation' class — the dangerFloor REFUSED gate
  // above (destructive/auth/payment/COMMUNICATION) already ran UNCONDITIONALLY and is NEVER exempt, so a
  // Delete/Logout/Pay/Video-Call opener is still hard-refused. SAFETY SCOPE: reveal-opener trusts the
  // write-firewall, which nets HTTP(S) only — a target that mutates over a WebSocket frame (security
  // review M1) is NOT aborted, so this is sound only on HTTP-mutating targets (rawcaster: POST-based).
  if (refuseMutations && !revealOpener && !huntWrites && mutationFloor({ name: gateName, route: gateRoute }) === 'mutation') {
    throw envelopeError({
      code: 'MUTATION_FLOOR',
      message: `refusing to fire a mutation-named control "${gateName ?? sel}" in read-only mode (template ${tid})`,
      exit: 'VIOLATION',
    });
  }

  const cause = String(tid);
  const startUrl = page.url();
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
    if (huntWrites) {
      // hunt: the blanket REFUSED classes are relaxed, but AUTH + account-deletion are re-checked on the LIVE
      // NAME (name-scoped, so a route does not misclassify), and the ownsTarget edit/delete rail below reads
      // the LIVE handle, so a mislabeled representative is still gated.
      const liveN = liveName || node?.name || target.name;
      if (dangerFloor({ name: liveN }) === 'auth') {
        throw envelopeError({ code: 'DANGER_FLOOR', message: `refusing an auth live representative "${liveN || sel}" in hunt mode (template ${tid})`, exit: 'VIOLATION' });
      }
      if (isAccountDeletion({ name: liveN }) && !runCreatedAccount) {
        throw envelopeError({ code: 'HUNT_ACCOUNT_PROTECTED', message: `refusing to delete an account this run did not create "${liveN || sel}" (template ${tid})`, exit: 'VIOLATION' });
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
  if (href && routeRefused(routeKey(href))) {
    throw envelopeError({ code: 'DANGER_FLOOR', message: `refusing to click a link to a danger route ${routeKey(href)} (template ${tid})`, exit: 'VIOLATION' });
  }

  // WRITE-HUNT ownership rail (the ONE hard rule): NEVER edit/delete NON-owned content. Compute `huntOwned`
  // for THIS act — the firewall's destructive method-gate consumes it, so an ICON-only delete (no name the
  // classifiers can read) on another user's item is still ABORTED (huntOwned=false → the DELETE is refused
  // at the network layer). Ownership = the HUNT-<runId> marker in the target's OWN item DOM (read LIVE off
  // the handle; survives re-render / cold re-nav; fail-closed). Account-deletion is authorized by the run-
  // created signal instead (an account has no item marker). Additive create/comment/like need no ownership —
  // the firewall lets them through regardless. A NAME-known destructive control on non-owned content throws
  // early for a clear agent signal; the icon-only case is caught by the firewall, and the server's own
  // ownership enforcement is the final backstop.
  let huntOwned = false;
  if (huntWrites) {
    if (isAccountDeletion({ name: gateName })) {
      huntOwned = !!runCreatedAccount;
    } else {
      huntOwned = await ownsTarget(handle, marker);
      // PORTAL-DROPDOWN fallback: a delete/edit rendered in a body-portal is detached from its row, so
      // ownsTarget on it finds no marker. Its ownership is its reveal-TRIGGER's item (the row's "…" opener,
      // which IS in the card). Check that — fail-closed if no reveal path / trigger not in a marked item.
      if (!huntOwned && revealPath && revealPath.length) huntOwned = await ownsViaReveal(page, graph, revealPath, marker);
      if (!huntOwned && requiresOwnership({ name: gateName, route: gateRoute })) {
        throw envelopeError({
          code: 'HUNT_NOT_OWNED',
          message: `refusing to modify content this run did not create — no ${marker || 'HUNT'} marker on "${gateName ?? sel}" (template ${tid})`,
          exit: 'VIOLATION',
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

  // PREFILL (multi-step form support): fill AUXILIARY fields (a composer textarea, a required input) BEFORE
  // clicking the target (a Post/Submit/Save button), in ONE act — so a CREATE whose value lives in a separate
  // field commits on the re-navigating agent path, where a separate fill act would be lost on the next
  // navigation. Each prefill is {selector, value}; in hunt mode the value gets the HUNT marker so the created
  // content is provably OURS. Best-effort: a selector that does not resolve is skipped (the click still fires).
  if (Array.isArray(prefill)) {
    for (const pf of prefill) {
      if (!pf || !pf.selector) continue;
      const h = await page.$(pf.selector).catch(() => null);
      if (!h) continue;
      const v = huntWrites && marker ? `${pf.value ?? ''} [${marker}]` : String(pf.value ?? '');
      await fillTarget(h, v);
    }
  }
  if (fill != null && fill !== '') {
    // WRITE-HUNT: stamp the per-run HUNT-<runId> marker into the value so created/edited content is provably
    // OURS (the ownership proof a later edit/delete needs) and cleanup can find it. Never in read-only.
    const value = huntWrites && marker ? `${fill} [${marker}]` : fill;
    await fillTarget(handle, String(value));
  }

  let fires;
  let seq0;
  const tAct = performance.now();
  try {
    // WRITE-HUNT: open the firewall write window for THIS act only. `on` marks the hunt act; `owned` gates a
    // DESTRUCTIVE write (the firewall aborts an unowned DELETE/PUT/PATCH even from an icon-only control).
    // Inside the try so the finally ALWAYS resets it (even if beginCause throws) — the window never outlives
    // the act. Gated on huntWrites (defense in depth — a caller must never open it on a non-hunt act).
    if (huntWindow && huntWrites) { huntWindow.on = true; huntWindow.owned = huntOwned; }
    seq0 = await beginCause(page, cause);
    // Bounded click timeout: a visible-but-transiently-unclickable control (covered,
    // animating) fails in seconds, not 30s, and the cause token is reset on throw.
    await handle.click({ timeout: 5000 });
    fires = await endCause(page, seq0, cause);
  } catch (err) {
    await resetCause(page); // click failed mid-window — never strand the cause on a reused page
    throw err;
  } finally {
    if (huntWindow && huntWrites) { huntWindow.on = false; huntWindow.owned = false; } // window closes with the act
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
    // openerReplayable is an OPT-IN widen for a POST-that-READS opener (apps like rawcaster fire
    // read/list queries over POST): the AGENT path sets it ONLY after judging the caused requests
    // are non-mutating, so those children become replayable too. The node loop never sets it, so
    // its GET-only ceiling is unchanged. The danger-floor still refuses destructive/auth/payment
    // openers by name regardless, so the widened residual is a non-floored generic write.
    // statefulProvenance is the METHOD-AGNOSTIC widen: stateful mode stamps reveal as a REPORTING
    // breadcrumb (location honesty), not a replay path, so it drops the GET-only gate — safety of any
    // FUTURE replay is delegated to the session-wide read-only firewall (default-ON in stateful mode).
    // The stamp is marked stateful:true so consumers tell a provenance breadcrumb from a replayable path.
    const allGet = requests.every((r) => String(r.method || 'GET').toUpperCase() === 'GET');
    const stamp = revealPath && landedRoute === route && (statefulProvenance === true || allGet || openerReplayable === true);
    // A1: a measured act that LANDED on a different same-origin route is an onClick/pushState navigation —
    // record it as a structural page→page nav edge (via = the causal control to click). Observed from the
    // committed page.url(), NOT a causal window: it never addTriggers, never touches request attribution.
    if (landedRoute !== route) pushNavEdge(graph, route, landedRoute, { provenance: 'act', via: tid });
    route = landedRoute;
    const afterMerge = mergeSnapshot(graph, landedRoute, after.elements, stamp ? { revealPath, stateful: statefulProvenance === true } : {});
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
  const result = { cause, requests, newElements, route, via, representative };
  if (newlyReachable.length) result.newlyReachable = newlyReachable;
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
