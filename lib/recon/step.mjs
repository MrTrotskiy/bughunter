// The shared browser step primitive: snapshot a page into the graph, and act on one
// control while capturing exactly the requests it caused. Both whats-new (single
// manual step) and the recon loop-driver (many steps) use these, so the causal
// act+capture sequence — bughunter's whole value — lives in ONE place, not two.

import { snapshotDom } from '../graph/dom-snapshot.mjs';
import { assignId } from '../graph/ids.mjs';
import { mergeSnapshot, addTrigger, toUrlPattern } from '../graph/graph-store.mjs';
import { beginCause, endCause, waitSettled, resetCause } from '../browser/causal.mjs';
import { dangerFloor } from './danger-floor.mjs';
import { routeKey, sameOrigin, isOffOriginHttp } from './scope.mjs';
import { envelopeError } from '../core/envelope.mjs';

// Controls the fire path REFUSES to click. The coarse floor (danger-floor.mjs) is a
// backstop, not the judge — but it must guard the ACT, not just the post-hoc record.
// Refusing before the click means an obvious delete/logout/checkout is never fired,
// whatever path reached actStep (whats-new --act-template, the loop, a mis-judging
// agent). The deliberate-mutation phase (firing your OWN HUNT-tagged control) is a
// future scoped override, not a hole here.
const FIRE_BLOCKED = new Set(['destructive', 'auth', 'payment']);

// Mint stable ids onto each element (template + instance) before merge.
export function idify(ledger, elements) {
  for (const el of elements) {
    el.templateId = assignId(ledger, 'tpl:' + el.templateSelector);
    el.instanceId = assignId(ledger, 'inst:' + el.templateSelector + '::' + String(el.instanceKey));
  }
  return elements;
}

// Fill the target instance if it is itself fillable, else the nearest input in its
// form/container. Returns whether anything was filled.
async function fillTarget(page, instanceSelector, value) {
  const handle = await page.$(instanceSelector);
  if (!handle) return false;
  // Bounded fill: a hidden/disabled/readonly input would otherwise stall Playwright's full
  // 30s default action timeout on the fill actionability check — the same stall the click
  // gate kills. Fail in seconds instead.
  const fillable = await handle.evaluate((el) => ['input', 'textarea'].includes(el.tagName.toLowerCase()));
  if (fillable) { await handle.fill(value, { timeout: 5000 }); return true; }
  const sib = await page.evaluateHandle((sel) => {
    const el = document.querySelector(sel);
    const scope = (el && (el.closest('form') || el.parentElement)) || document;
    return scope.querySelector('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea');
  }, instanceSelector);
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
export async function actStep(page, graph, ledger, target, { fill, capture } = {}) {
  const sel = target.instance.instanceSelector;
  const tid = target.templateId;

  // Fire-path danger gate: refuse to touch the page (no fill, no click) for an obvious
  // destructive/auth/payment control. Uses the graph node when present, else falls back
  // to the target's own name/route so a manual --act-template is guarded too.
  const node = graph.elements[tid];
  const floor = dangerFloor({
    name: node?.name ?? target.name,
    route: node?.route ?? target.route,
  });
  if (FIRE_BLOCKED.has(floor)) {
    throw envelopeError({
      code: 'DANGER_FLOOR',
      message: `refusing to fire a ${floor} control "${node?.name ?? target.name ?? sel}" (template ${tid})`,
      exit: 'VIOLATION',
    });
  }

  const cause = String(tid);
  const startUrl = page.url();
  // Resolve the instance BEFORE setting the cause token — an unreachable control must
  // not leave a cause set that nothing reads back.
  const handle = await page.$(sel);
  if (!handle) throw envelopeError({ code: 'NO_INSTANCE', message: `cannot resolve instance ${sel}` });

  // Origin scope: never FIRE an off-origin HTTP link. Clicking it would navigate the page
  // out of scope (the SSRF gate only guards OUR gotoGated calls, not a browser link-follow),
  // burn budget on a foreign site, and pollute the graph. Record it as reachable-but-not-
  // fired (external) and return — the caller counts it, never marks it unreachable. Only
  // http(s) cross-origin links qualify: a javascript:/mailto:/tel: href is an in-page
  // control or a no-op and falls through to the normal click (isOffOriginHttp gates that).
  const href = await handle.evaluate((el) => (el.tagName === 'A' && el.href) ? el.href : null);
  if (href && isOffOriginHttp(startUrl, href)) {
    return { cause, requests: [], newElements: [], route: routeKey(startUrl), external: { href } };
  }

  // Fast-fail on a control that is present in the DOM but NOT visible (e.g. a responsive
  // layout's mobile menu hidden on desktop). Without this, handle.click() waits the full
  // 30s Playwright actionability timeout on every such element — crippling on real sites
  // where hidden/duplicated controls are everywhere. Cheap isVisible() check instead.
  const visible = await handle.isVisible().catch(() => false);
  if (!visible) throw envelopeError({ code: 'NOT_VISIBLE', message: `instance ${sel} is present but not visible in the current viewport` });

  // Debug capture — BEFORE frame. Taken here on purpose: the cause is still __idle__ and no
  // click has fired, so the viewport screenshot cannot enter the causal window. Captures the
  // pristine state + the target's rect (the highlight box the admin draws).
  const before = capture ? await capture.before(page, handle) : null;

  if (fill != null && fill !== '') await fillTarget(page, sel, String(fill));

  const seq0 = await beginCause(page, cause);
  let fires;
  const tAct = performance.now();
  try {
    // Bounded click timeout: a visible-but-transiently-unclickable control (covered,
    // animating) fails in seconds, not 30s, and the cause token is reset on throw.
    await handle.click({ timeout: 5000 });
    fires = await endCause(page, seq0, cause);
  } catch (err) {
    await resetCause(page); // click failed mid-window — never strand the cause on a reused page
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
    const req = { method: f.method, urlPattern };
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
  let route = routeKey(startUrl);
  if (sameOrigin(startUrl, landedUrl)) {
    route = landedRoute;
    const afterMerge = mergeSnapshot(graph, landedRoute, after.elements);
    newElements = afterMerge.newInstances.map((i) => ({ templateId: i.templateId, instanceKey: i.instanceKey }));
  }
  const result = { cause, requests, newElements, route };
  if (capture) {
    // AFTER frame — the cause was reset by endCause (or resetCause on throw), so we are
    // __idle__ again; this viewport shot shows the EFFECT (a revealed modal / new rows).
    const after2 = await capture.after(page);
    result.debug = { timings: { actMs, settleMs, snapMs }, before, after: after2 };
  }
  return result;
}
