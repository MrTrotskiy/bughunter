// REOPEN CONTAINER — re-enter an in-app state by replaying the SUFFIX of a recorded reveal path (INC.7).
//
// The verb `reveal-replay.mjs` deliberately refuses to provide. That refusal stays: REVEAL_PROVENANCE_ONLY
// is the law for the COLD stateless path, where a whole recorded path is walked from a fresh load. This is a
// separate, stricter admission path for the STATEFUL driver, and the difference that makes it sound is the
// VERIFICATION: after the walk, the intended target must actually resolve. A wrong path therefore degrades
// to "still unreachable" — it can never produce a mis-attributed act.
//
// CAUSAL DISCIPLINE. Zero `beginCause`, so no causal window is opened and no edge can be added — the same
// guarantee `replayRevealPath` and the route-frontier's navigation give. `resetTrackerVerdicts` runs after
// every hop and — via the `finally` below — on EVERY exit including the failure paths, so a hop that timed
// out mid-flight cannot leave dirty verdicts for the caller's measured act. `markInstanceExplored` is NEVER
// called here: Explored ⟺ observed holds, and a reopen only relocates the page.
//
// TWO GATES, TWO PLACES, and the split is structural. `reopen-policy.admitHop` decides what is answerable
// from the graph alone (dismiss / repeat / danger floor / whether we have measured proof for a
// mutation-named hop). Ownership is NOT answerable there — it is proven live off the resolved handle — so
// the foreign-content rail runs HERE, at the handle seam, exactly where actStep runs it. Without that, a
// reopen would be the one path that clicks with LESS protection than a measured act rather than more.

import { gotoGated } from '../browser/session.mjs';
import { waitSettled, resetTrackerVerdicts } from '../browser/causal.mjs';
import { settleAnimations } from '../browser/anim-settle.mjs';
import { dismissOverlays } from './overlays.mjs';
import { resolveHandle } from './resolve-handle.mjs';
import { routeKey } from './scope.mjs';
import { reopenAttempts } from './reopen-policy.mjs';
import { routeRefused } from './danger-floor.mjs';
import { decide as decidePolicy, OWNERSHIP } from './explore-policy.mjs';
import { ownsTarget, ownsAnyHunt, inOwnableItem } from './hunt-gate.mjs';

const HOP_TIMEOUT = 5000;

function instanceOf(node, key) {
  return (node?.instances || []).find((i) => i.instanceKey === key) || null;
}

// Walk ONE candidate suffix from a fresh navigation. Returns a per-hop record either way — a failure that
// cannot say WHICH hop died and why is not worth having.
async function walkAttempt(page, graph, node, inst, hops, { origin, marker, runCreatedAccount }) {
  const hopRecords = [];
  // Same navigation gate the other two navigators use — a reopen must not be the one path that walks onto a
  // logout/checkout route.
  if (routeRefused(node.route)) return { ok: false, code: 'REOPEN_ROUTE_REFUSED', hopRecords };
  await gotoGated(page, new URL(node.route, origin).href);
  await waitSettled(page);
  await dismissOverlays(page);
  resetTrackerVerdicts(page);

  for (let i = 0; i < hops.length; i++) {
    const hop = hops[i];
    const hopNode = graph.elements[hop.templateId];
    const hopInst = instanceOf(hopNode, hop.instanceKey) || (hopNode?.instances || [])[0] || null;
    const rec = { i, templateId: hop.templateId, name: hopNode?.name || null, resolved: false, clicked: false };
    hopRecords.push(rec);

    const got = hopInst ? await resolveHandle(page, hopInst, hopNode) : null;
    if (!got || !got.handle) { rec.error = 'REOPEN_HOP_STALE'; return { ok: false, code: 'REOPEN_HOP_STALE', hopRecords }; }
    rec.resolved = true; rec.via = got.via; rec.representative = got.representative === true;

    // OWNERSHIP RAIL AT THE HANDLE SEAM — the same check actStep performs, for the same reason, and it
    // cannot live in the policy: ownership is proven LIVE off the resolved handle, and admitHop is pure.
    // Without this, a reopen would be the one path that clicks a control while bypassing the foreign-content
    // refusal, the restore journal, and the live-name re-check — with LESS downstream protection than a
    // measured act, not more. The live name matters because a role-name resolution can hand back a different
    // element than the stored instance, so the stored name is not trustworthy here (INC.6b).
    const liveName = await got.handle.evaluate((el) => (el.innerText || el.getAttribute('aria-label') || '').trim().slice(0, 120)).catch(() => null);
    const gateName = liveName || hopNode?.name || '';
    let ownership = OWNERSHIP.NONE;
    if (marker && (await ownsTarget(got.handle, marker).catch(() => false) || await ownsAnyHunt(got.handle).catch(() => false))) ownership = OWNERSHIP.OWN;
    // NO `.catch(() => false)` HERE, deliberately. `inOwnableItem` fails CLOSED by returning TRUE — a
    // handle it cannot evaluate is treated as inside an item, so the unowned write is blocked. Wrapping it
    // in a catch that yields `false` inverts that: ownership stays NONE, `decide()` returns ALLOWED with
    // full rights, and the exact leak the function was written to prevent is reintroduced. `actStep` calls
    // it bare for this reason; the rule is not duplicated here, but its FAIL DIRECTION must not diverge.
    else if (await inOwnableItem(got.handle)) ownership = OWNERSHIP.FOREIGN;
    const verdict = decidePolicy({ name: gateName, route: node.route, ownership, runCreatedAccount });
    rec.liveName = gateName; rec.ownership = ownership;
    // A reopen hop never gets the needsRestore bracket (there is no restore pass around plumbing), so an act
    // that WOULD need one is refused here rather than performed unbracketed.
    if (!verdict.allow || verdict.needsRestore || verdict.needsRelogin) {
      rec.error = verdict.allow ? 'REOPEN_HOP_NEEDS_BRACKET' : verdict.code;
      return { ok: false, code: rec.error, hopRecords };
    }

    try {
      await got.handle.click({ timeout: HOP_TIMEOUT });
      rec.clicked = true;
    } catch (e) {
      rec.error = String(e?.message || e).split('\n')[0].slice(0, 120);
      return { ok: false, code: 'REOPEN_HOP_CLICK_FAILED', hopRecords };
    }
    await waitSettled(page);
    rec.animSettled = await settleAnimations(page);
    resetTrackerVerdicts(page);

    // A hop that NAVIGATES has left the state we are assembling; the remaining hops mean nothing there.
    const landed = routeKey(page.url());
    rec.routeAfter = landed;
    if (landed !== node.route) return { ok: false, code: 'REOPEN_NAVIGATED', hopRecords };
  }
  return { ok: true, code: 'REOPEN_WALKED', hopRecords };
}

// reopenContainer(page, graph, target, {origin}) → { ok, code, attempt, hops, via, representative }
//
// Codes: REOPEN_OK (the target resolves — the only success) · REOPEN_NO_PATH (nothing recorded to try) ·
// REOPEN_REFUSED (policy rejected every suffix) · REOPEN_HOP_STALE / REOPEN_HOP_CLICK_FAILED /
// REOPEN_NAVIGATED (this suffix died; a longer one may still work) · REOPEN_UNVERIFIED (every hop clicked
// and the target STILL does not resolve — the honest "this breadcrumb is not a path" verdict, and the one
// that decides whether the whole approach is worth wiring).
export async function reopenContainer(page, graph, target, { origin, maxHops, marker, runCreatedAccount } = {}) {
  const node = graph?.elements?.[target?.templateId];
  const inst = target?.instance || instanceOf(node, target?.instanceKey);
  if (!node || !inst) return { ok: false, code: 'REOPEN_NO_PATH', attempts: [] };

  const attempts = reopenAttempts(graph, node, inst, maxHops ? { maxHops } : {});
  if (attempts.length === 0) return { ok: false, code: 'REOPEN_NO_PATH', attempts: [] };

  const tried = [];
  let sawAdmitted = false;
  try {
  for (const attempt of attempts) {
    if (!attempt.admitted) { tried.push({ hops: attempt.hops, code: attempt.code, refused: true }); continue; }
    sawAdmitted = true;
    const walked = await walkAttempt(page, graph, node, inst, attempt.hops, { origin, marker, runCreatedAccount });
    if (!walked.ok) { tried.push({ hops: attempt.hops, code: walked.code, hopRecords: walked.hopRecords }); continue; }

    // THE ORACLE. Not "did a modal appear" — did the control we came for become resolvable? That is the
    // same predicate the driver uses to decide a control is actionable, so a pass here means the caller
    // can act immediately, and a fail is honest rather than optimistic.
    const got = await resolveHandle(page, inst, node);
    resetTrackerVerdicts(page);
    if (got && got.handle) {
      return {
        ok: true, code: 'REOPEN_OK', attempt: attempt.hops.length,
        hops: walked.hopRecords, via: got.via, representative: got.representative === true, tried,
      };
    }
    tried.push({ hops: attempt.hops, code: 'REOPEN_UNVERIFIED', hopRecords: walked.hopRecords });
  }
  const last = tried[tried.length - 1];
  return {
    ok: false,
    code: sawAdmitted ? (last?.code || 'REOPEN_UNVERIFIED') : 'REOPEN_REFUSED',
    reason: last?.code || null,
    tried,
  };
  } finally {
    // Every exit, including a mid-click timeout that may already have let requests out.
    resetTrackerVerdicts(page);
  }
}
