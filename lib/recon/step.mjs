// The shared browser step primitive: snapshot a page into the graph, and act on one
// control while capturing exactly the requests it caused. Both whats-new (single
// manual step) and the recon loop-driver (many steps) use these, so the causal
// act+capture sequence — bughunter's whole value — lives in ONE place, not two.

import { snapshotDom } from '../graph/dom-snapshot.mjs';
import { assignId } from '../graph/ids.mjs';
import { mergeSnapshot, addTrigger, toUrlPattern } from '../graph/graph-store.mjs';
import { beginCause, endCause, waitSettled, resetCause } from '../browser/causal.mjs';
import { dangerFloor } from './danger-floor.mjs';
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
  const fillable = await handle.evaluate((el) => ['input', 'textarea'].includes(el.tagName.toLowerCase()));
  if (fillable) { await handle.fill(value); return true; }
  const sib = await page.evaluateHandle((sel) => {
    const el = document.querySelector(sel);
    const scope = (el && (el.closest('form') || el.parentElement)) || document;
    return scope.querySelector('input:not([type=hidden]):not([type=submit]):not([type=button]), textarea');
  }, instanceSelector);
  const elh = sib.asElement();
  if (elh) { await elh.fill(value); return true; }
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
// instances a re-snapshot found). Adds the causal trigger edge to the graph. Throws
// NO_INSTANCE if the instance selector no longer resolves (e.g. a control behind
// in-app state a cold-start reload cannot reach).
export async function actStep(page, graph, ledger, route, target, { fill } = {}) {
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

  if (fill != null && fill !== '') await fillTarget(page, sel, String(fill));

  const cause = String(tid);
  // Resolve the instance BEFORE setting the cause token — an unreachable control must
  // not leave a cause set that nothing reads back.
  const handle = await page.$(sel);
  if (!handle) throw envelopeError({ code: 'NO_INSTANCE', message: `cannot resolve instance ${sel}` });
  const seq0 = await beginCause(page, cause);
  let fires;
  try {
    await handle.click();
    fires = await endCause(page, seq0, cause);
  } catch (err) {
    await resetCause(page); // click failed mid-window — never strand the cause on a reused page
    throw err;
  }

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

  await waitSettled(page);
  const after = await snapshotDom(page);
  idify(ledger, after.elements);
  const afterMerge = mergeSnapshot(graph, route, after.elements);
  return {
    cause,
    requests,
    newElements: afterMerge.newInstances.map((i) => ({ templateId: i.templateId, instanceKey: i.instanceKey })),
  };
}
