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
async function walkAttempt(page, graph, node, inst, hops, { origin, marker, runCreatedAccount, navigate = true }) {
  const hopRecords = [];
  // Same navigation gate the other two navigators use — a reopen must not be the one path that walks onto a
  // logout/checkout route.
  if (routeRefused(node.route)) return { ok: false, code: 'REOPEN_ROUTE_REFUSED', hopRecords };
  // IN-PLACE FIRST (`navigate:false`). Re-entering a container by RELOADING THE PAGE is self-defeating: the
  // state we are trying to restore is destroyed by the first line of the attempt to restore it, and then
  // rebuilt by replaying clicks. When the container is already open — the common case straight after an act
  // inside it — the whole navigation is pure waste, and the hops that follow re-fire openers for nothing.
  // Measured: this path succeeded on 31 of 168 attempts (18%), and the driver's own recovery pass was its
  // heaviest caller. Computed over the graph, 1026-1135 admitted attempts each began with a full load, none
  // of them recorded as a navigation anywhere in the trail.
  //
  // So: try the hops against the LIVE DOM first and let the same oracle judge. A wrong in-place walk fails
  // exactly as a wrong cold walk does — the target does not resolve — and the caller then retries with
  // `navigate:true`, which restores the old behaviour verbatim. Nothing is admitted that `admitHop` did not
  // already admit, and the ownership rail below is unchanged.
  if (navigate) {
    await gotoGated(page, new URL(node.route, origin).href);
    await waitSettled(page);
    await dismissOverlays(page);
  }
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
      // OBSCURED IS NOT ABSENT. Playwright's actionability check requires the element to be the hit target,
      // so an overlay left open by an EARLIER hop fails this click with a timeout even though the control
      // resolved and is visible. Recorded paths routinely contain several mutually exclusive modal openers
      // (a session history, not a route), so this is the normal shape of a multi-hop walk rather than an
      // edge case — measured, 5 of 33 failures in one run. Clear the blocker once and retry; a second
      // failure is honest and reported as before. The dismissal runs outside any causal window.
      const first = String(e?.message || e).split('\n')[0].slice(0, 120);
      rec.obscured = first;
      try {
        await dismissOverlays(page);
        await got.handle.click({ timeout: HOP_TIMEOUT });
        rec.clicked = true;
        rec.viaDismiss = true;
      } catch (e2) {
        rec.error = String(e2?.message || e2).split('\n')[0].slice(0, 120);
        return { ok: false, code: 'REOPEN_HOP_CLICK_FAILED', hopRecords };
      }
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
  // RUNG 0 — already there. The cheapest relocation is none: after an act inside a container the container
  // is usually still open, and the target may resolve right now. Costs one resolve; saves a full load plus
  // every hop's re-fired opener when it hits.
  {
    const already = await resolveHandle(page, inst, node);
    if (already && already.handle) {
      return { ok: true, code: 'REOPEN_ALREADY', attempt: 0, hops: [], via: already.via, representative: already.representative === true, tried };
    }
  }
  // RUNG 1 then RUNG 3 (see the cost ladder in the header): replay every admitted suffix IN PLACE first,
  // and only fall back to reload-then-replay for the suffixes that failed. Ordering matters — a cold reload
  // destroys any state an in-place walk could have used, so trying it first would make rung 1 unreachable.
  for (const navigate of [false, true]) {
  for (const attempt of attempts) {
    if (!attempt.admitted) { if (!navigate) tried.push({ hops: attempt.hops, code: attempt.code, refused: true }); continue; }
    sawAdmitted = true;
    const walked = await walkAttempt(page, graph, node, inst, attempt.hops, { origin, marker, runCreatedAccount, navigate });
    if (!walked.ok) { tried.push({ hops: attempt.hops, code: walked.code, hopRecords: walked.hopRecords, navigate }); continue; }

    // THE ORACLE. Not "did a modal appear" — did the control we came for become resolvable? That is the
    // same predicate the driver uses to decide a control is actionable, so a pass here means the caller
    // can act immediately, and a fail is honest rather than optimistic.
    const got = await resolveHandle(page, inst, node);
    resetTrackerVerdicts(page);
    if (got && got.handle) {
      return {
        ok: true, code: 'REOPEN_OK', attempt: attempt.hops.length,
        // Which rung paid: `in-place` means the container was re-entered with ZERO navigation. The caller
        // stamps this into the trail, so "did the cheap path work" is answerable from the log rather than
        // by inference — the same reason the navigation itself is now recorded.
        rung: navigate ? 'reload-replay' : 'in-place',
        hops: walked.hopRecords, via: got.via, representative: got.representative === true, tried,
      };
    }
    tried.push({ hops: attempt.hops, code: 'REOPEN_UNVERIFIED', hopRecords: walked.hopRecords, navigate });
  }
  }
  // WHICH FAILURE DO WE REPORT? Not the last one — that was the rule, and it made every diagnosis a lie.
  //
  // `attempts` is ordered shortest-suffix-first and the loops run `navigate:false` then `navigate:true`,
  // so the LAST entry in `tried` is always the DEEPEST suffix on the reload rung. A deep suffix is a
  // cumulative breadcrumb of everything clicked since the last navigation — it routinely leads with an
  // opener belonging to some unrelated panel that happened to be open at capture time. After a reload that
  // panel is gone, so hop 0 cannot resolve, and the attempt is guaranteed to die `REOPEN_HOP_STALE`
  // regardless of what went wrong with the suffix that actually mattered.
  //
  // Measured: 189 of 189 failures in one run reported `REOPEN_HOP_STALE`, and for the top templates the
  // short suffix (n=1, rooted at a live `#root` opener) was admitted and tried FIRST — its real failure
  // never reached the trail. A single code covering every distinct cause is worth nothing to whoever
  // reads the log.
  //
  // So report the attempt that got FURTHEST — most hops actually resolved — breaking ties toward the
  // SHORTER suffix, which is the one whose failure carries information. The full `tried` array still goes
  // back to the caller unchanged; this only decides the headline.
  const informative = tried.reduce((best, cur) => {
    if (!best) return cur;
    const depth = (t) => (t.hopRecords || []).filter((r) => r.resolved).length;
    if (depth(cur) !== depth(best)) return depth(cur) > depth(best) ? cur : best;
    return (cur.hops || []).length < (best.hops || []).length ? cur : best;
  }, null);
  // The hop that actually died, named — `walkAttempt` has always assembled these records and the caller
  // has always thrown them away, which is why "which hop broke, and why" was unanswerable from the trail.
  const rec = (informative?.hopRecords || []);
  const died = rec.find((r) => !r.clicked) || rec[rec.length - 1] || null;
  return {
    ok: false,
    code: sawAdmitted ? (informative?.code || 'REOPEN_UNVERIFIED') : 'REOPEN_REFUSED',
    reason: informative?.code || null,
    failedHop: died ? { i: died.i, templateId: died.templateId, name: died.name, resolved: !!died.resolved, error: died.error || null } : null,
    hopsResolved: rec.filter((r) => r.resolved).length,
    hopsTotal: rec.length,
    attemptsTried: tried.length,
    tried,
  };
  } finally {
    // Every exit, including a mid-click timeout that may already have let requests out.
    resetTrackerVerdicts(page);
  }
}
