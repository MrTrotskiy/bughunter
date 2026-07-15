// reveal-replay — the stay-on-page REACH prologue (GAP 2 first slice; decisions.md
// 2026-07-15 "GAP 2 stay-on-page reach"). A control revealed ONLY by an in-page action
// (a modal button) is CLOSED by persistentStep's per-act re-navigation, so its instance
// throws NO_INSTANCE and it is marked unreachable. This replays the recorded reveal PATH
// on the freshly-navigated page, so the target's instance is present when the measured
// actStep runs. It lives in its own file so recon-run.mjs / step.mjs stay < 200 lines.
//
// CAUSAL SAFETY (why replay can never forge an edge): every replay click runs UNDER
// __idle__ — NO beginCause — so its fires carry cause '__idle__' and are dropped by the
// token filter (selectKept). resetTrackerVerdicts after EACH step clears any sticky path
// verdict, matching persistentStep's per-act discipline, so the measured act starts clean.
//
// SAFETY / HONESTY: the WHOLE path is refused (throw → reconLoop marks the target unreachable,
// never fired) if any reveal step is danger-floored, if its LIVE element is an off-origin link
// or links to a danger route (the H1 fix — mirror actStep's PRE-CLICK guards on the resolved
// handle so a replay hop can NEVER self-logout / follow an off-origin or private-host link /
// hit a destructive GET under an authed session BEFORE any post-hoc abort), if a step's
// instance no longer resolves (staleness → unreachable, never guess), if the path is deeper
// than REVEAL_MAX_DEPTH, or if a replay click CHANGES the route (no longer stay-on-page).

import { waitSettled, resetTrackerVerdicts } from '../browser/causal.mjs';
import { routeKey, isOffOriginHttp } from './scope.mjs';
import { dangerFloor, REFUSED, routeRefused } from './danger-floor.mjs';
import { envelopeError } from '../core/envelope.mjs';

// Defensive cap against a deep / cyclic reveal path — a statePath longer than this is refused
// (→ unreachable) rather than walked. Depth-1 is the first slice; real paths are 1-2 hops.
export const REVEAL_MAX_DEPTH = 10;

// The full ordered path to annotate onto anything the measured act itself reveals: the
// target's own reveal path (empty for a directly-reachable control) plus a final hop for the
// target. Passed to actStep so a modal opened BY this act is stamped with the complete path.
export function revealPathFor(target) {
  const prefix = (target.reveal && target.reveal.statePath) || [];
  return prefix.concat([{ templateId: target.templateId, instanceKey: target.instance.instanceKey }]);
}

// The persistentStep entry point: on an already-navigated page, replay the target's reveal
// path (a no-op for a directly-reachable control) and return the full revealPath to hand to
// actStep. Keeps recon-run.mjs's per-act body to a single call. Throws on an unreachable path.
export async function applyReveal(page, graph, target) {
  if (target.reveal) await replayRevealPath(page, graph, target.reveal);
  return revealPathFor(target);
}

// Replay reveal.statePath on an already-navigated (and overlay-dismissed) page. Throws an
// envelope error — which reconLoop turns into node.unreachable — on staleness / danger / a
// route change. On success the page is left in the revealed state, ready for the measured act.
export async function replayRevealPath(page, graph, reveal) {
  const startRoute = reveal.route;
  const statePath = reveal.statePath || []; // a partial graph (reveal without statePath) must not TypeError
  // Depth cap (L1): a path longer than the cap → unreachable, never walked (deep/cyclic guard).
  if (statePath.length > REVEAL_MAX_DEPTH) {
    throw envelopeError({ code: 'REVEAL_TOO_DEEP', message: `reveal path depth ${statePath.length} exceeds ${REVEAL_MAX_DEPTH}` });
  }
  // Cycle guard: a legit reveal path never re-opens the same template (A→B→A means a mis-recorded
  // reveal or a genuinely cyclic UI). Refuse BEFORE walking rather than loop — depth-N accretion
  // could otherwise stamp a child with a path that revisits its own opener. Checked up front so a
  // cycle is caught even when the duplicated template's instance would still resolve.
  const seenTemplates = new Set();
  for (const step of statePath) {
    if (seenTemplates.has(step.templateId)) {
      throw envelopeError({ code: 'REVEAL_CYCLE', message: `reveal path revisits template ${step.templateId} — cyclic, refused` });
    }
    seenTemplates.add(step.templateId);
  }
  for (const step of statePath) {
    const node = graph.elements[step.templateId];
    const inst = node && node.instances && node.instances.find((i) => i.instanceKey === step.instanceKey);
    const sel = inst && inst.instanceSelector;
    if (!sel) {
      throw envelopeError({ code: 'REVEAL_STALE', message: `reveal step ${step.templateId}/${step.instanceKey} no longer resolves` });
    }
    // Stored-NAME danger gate (graph-record backstop): refuse the whole path if any hop was
    // recorded as a destructive/auth/payment control. Gating only the terminal act would let a
    // DFS fire a floored control on the way in.
    if (REFUSED.has(dangerFloor({ name: node.name, route: node.route }))) {
      throw envelopeError({ code: 'REVEAL_DANGER', message: `reveal step ${step.templateId} is a danger control — path refused`, exit: 'VIOLATION' });
    }
    const handle = await page.$(sel);
    if (!handle) {
      throw envelopeError({ code: 'REVEAL_STALE', message: `reveal step selector ${sel} not present on the page` });
    }
    // PRE-CLICK safety on the LIVE resolved element (H1): the stored name/route can be stale, or
    // an ADAPTIVE server may serve a DIFFERENT (danger/off-origin) element at replay time, so
    // re-derive from the live handle and REFUSE before the click — mirroring actStep. A raw click
    // that first navigates off-origin / to a private host / to /logout would end an authed session
    // (or leave scope) BEFORE any post-hoc abort could catch it.
    const href = await handle.evaluate((el) => (el.tagName === 'A' && el.href) ? el.href : null);
    if (href && isOffOriginHttp(page.url(), href)) {
      throw envelopeError({ code: 'REVEAL_OFFORIGIN', message: `reveal step ${sel} is an off-origin link (${href}) — refusing to follow under the session` });
    }
    if (href && routeRefused(routeKey(href))) {
      throw envelopeError({ code: 'REVEAL_DANGER', message: `reveal step ${sel} links to a danger route (${href}) — path refused`, exit: 'VIOLATION' });
    }
    // Click UNDER __idle__ (NO beginCause): a plain bounded click whose fires carry cause
    // '__idle__' and are excluded by the token filter — the replay never forges a causal edge.
    await handle.click({ timeout: 5000 });
    await waitSettled(page);
    // A reveal step that NAVIGATES broke the stay-on-page contract — reclassify unreachable
    // rather than crawl the wrong page (the route gate is routeRefused's job, not this one's).
    if (routeKey(page.url()) !== startRoute) {
      throw envelopeError({ code: 'REVEAL_NAVIGATED', message: `reveal step changed route to ${routeKey(page.url())} — no longer stay-on-page` });
    }
    resetTrackerVerdicts(page); // clear this step's verdicts before the next step (and the act)
  }
}
