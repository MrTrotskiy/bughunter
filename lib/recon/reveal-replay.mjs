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
import { dangerFloor, REFUSED, routeRefused, isAccountDeletion, isDismissControl } from './danger-floor.mjs';
import { exploreAllArmed } from './explore-policy.mjs';
import { resolveHandle } from './resolve-handle.mjs';
import { envelopeError } from '../core/envelope.mjs';
import { buildWriteAllowlist, makeFirewallHandler } from './reveal-firewall.mjs';

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
// route change / a blocked replay-time write. On success the page is left in the revealed state,
// ready for the measured act.
export async function replayRevealPath(page, graph, reveal) {
  const startRoute = reveal.route;
  const statePath = reveal.statePath || []; // a partial graph (reveal without statePath) must not TypeError
  // PROVENANCE IS NOT A ROUTE. The stateful driver records the opener hops acted since the last navigation
  // and stamps them `stateful:true`; its own contract calls that "provenance, NOT replay" — in-session
  // state is ACCUMULATED, never re-walked. Nothing enforced the distinction, so this replayer read such a
  // breadcrumb and walked it as if it were a path. Measured on the live graph: 493 of 494 recorded paths
  // are stateful, and walking them is how a cold act lands somewhere other than where it meant to.
  // Refusing leaves the control HONESTLY unreachable from a cold start — which is what it is.
  if (reveal.stateful) {
    throw envelopeError({ code: 'REVEAL_PROVENANCE_ONLY', message: 'reveal path is stateful provenance, not a replayable route' });
  }
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
  // DISMISS guard: a path that CLOSES what it opened is not a path. Measured live — tpl 933 "Group Name"
  // recorded the path [26, 98, 79, 900 "cancel", 902], so replaying it dismisses the very modal the field
  // lives in and the field then fails to resolve. 22 of the 494 recorded paths contain such a hop. The
  // write-side guard (stateful-step) stops NEW ones being recorded; this stops an already-recorded one
  // being walked.
  for (const step of statePath) {
    const nm = (graph && graph.elements && graph.elements[step.templateId] && graph.elements[step.templateId].name) || '';
    if (isDismissControl({ name: nm })) {
      throw envelopeError({ code: 'REVEAL_DISMISS_IN_PATH', message: `reveal path passes through dismiss control "${nm}" (template ${step.templateId})` });
    }
  }
  // Layer-3: build the write-allowlist from the openers' own recorded reads and INSTALL the firewall
  // BEFORE the replay loop. Nothing above this fires a request — the depth/cycle guards are pure — so
  // the firewall spans exactly the replay clicks, no more.
  //
  // EXPLORE-ALL lifts it entirely (decisions.md 2026-07-18). This was the single largest coverage
  // blocker measured on the live rawcaster crawl: 54 templates failed REVEAL_WRITE_BLOCKED, and the
  // blocked requests were the app's OWN same-origin endpoints (update_online_status / addnuggetview /
  // listnuggets) mislabelled off-origin — `reveal-firewall` reads `page.url()` LIVE per request, and a
  // replay click that commits a navigation makes it transiently '' → `sameOrigin` false → HARD block →
  // the whole reveal dies. Beyond that bug, the firewall fails a reveal whenever ANY non-allowlisted
  // background POST merely ticks inside the replay window — blame assigned by wall-clock window, the
  // exact fallacy the causal-attribution invariant forbids. Under a mode whose contract is "writes
  // commit", the gate has nothing left to protect and is pure coverage loss.
  const exploreAll = exploreAllArmed(process.env);
  const blocked = [];
  let firewall = null;
  if (!exploreAll) {
    const allowlist = buildWriteAllowlist(graph, statePath);
    firewall = makeFirewallHandler(page, allowlist, blocked);
    await page.route('**/*', firewall);
  }
  try {
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
      //
      // EXPLORE-ALL lifts this: a reveal path is a REPLAY of hops the crawl already fired deliberately,
      // so refusing to re-walk them would strand every control that lives behind one — exactly the
      // coverage the mode exists to reach. The foreign-content rail still runs at the terminal act.
      if (!exploreAllArmed(process.env) && REFUSED.has(dangerFloor({ name: node.name, route: node.route }))) {
        throw envelopeError({ code: 'REVEAL_DANGER', message: `reveal step ${step.templateId} is a danger control — path refused`, exit: 'VIOLATION' });
      }
      // DURABLE HOP RESOLUTION. The replay used to use a raw `page.$(sel)` — the exact stored positional
      // path or nothing — while the MEASURED act has had the durable ladder (testid → id → role+name →
      // text) for a while. So a hop whose nth-child path churned killed the whole reveal even though the
      // control was plainly on the page: measured live, every one of the failing hops had a durable handle
      // available (role+name, text, or a stable id) and none of them were tried.
      //
      // A representative hop is a DIFFERENT element than the one recorded, so the live-name gate below is a
      // PRECONDITION, not a follow-up: without it a re-located hop could be a Logout/Delete clicked under an
      // authed session. With it, the worst case degrades to a refused reveal, never a stray mutation.
      const resolved = await resolveHandle(page, inst, node);
      if (!resolved) {
        throw envelopeError({ code: 'REVEAL_STALE', message: `reveal step selector ${sel} not present on the page` });
      }
      const { handle, representative } = resolved;
      // LIVE-NAME GATE (mirrors step.mjs's representative re-check). Only meaningful for a representative:
      // an exact-selector hit is by definition the recorded element. Re-derive the name off the LIVE handle
      // and re-run the floor, so a hop that re-located onto a destructive/auth control is refused BEFORE the
      // click. Under explore-all the blanket floor is lifted, but account-deletion stays decidable by name.
      if (representative) {
        const liveName = await handle.evaluate((el) => {
          const pick = (v) => (v && v.trim() ? v.replace(/\s+/g, ' ').trim().slice(0, 80) : '');
          return pick(el.getAttribute('aria-label')) || pick(el.textContent) || pick(el.getAttribute('title'));
        }).catch(() => null);
        const nm = liveName || node.name;
        if (exploreAllArmed(process.env)) {
          if (isAccountDeletion({ name: nm })) {
            throw envelopeError({ code: 'REVEAL_DANGER', message: `reveal hop re-located onto an account-deletion control "${nm}" — path refused`, exit: 'VIOLATION' });
          }
        } else if (REFUSED.has(dangerFloor({ name: nm }))) {
          throw envelopeError({ code: 'REVEAL_DANGER', message: `reveal hop re-located onto a danger control "${nm}" — path refused`, exit: 'VIOLATION' });
        }
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
      // Off-origin stays refused in EVERY mode (scope, not safety — a foreign site is not our target).
      // The danger-ROUTE gate, by contrast, lifts under explore-all: a /logout hop is fired and the
      // driver re-logins, rather than stranding everything reachable only through it.
      if (href && !exploreAllArmed(process.env) && routeRefused(routeKey(href))) {
        throw envelopeError({ code: 'REVEAL_DANGER', message: `reveal step ${sel} links to a danger route (${href}) — path refused`, exit: 'VIOLATION' });
      }
      // Click UNDER __idle__ (NO beginCause): a plain bounded click whose fires carry cause
      // '__idle__' and are excluded by the token filter — the replay never forges a causal edge.
      const blockedBefore = blocked.length;
      await handle.click({ timeout: 5000 });
      await waitSettled(page);
      // Layer-3: FAIL honestly only on a HARD block this step — a genuine write (non-safe method) or a
      // danger-route hit the firewall aborted (→ reconLoop/whats-new mark the target unreachable, the
      // live account unmutated). A SOFT block (a benign off-origin SAFE-method sub-resource: a CDN
      // image/font/pixel) was aborted to prevent the leak but leaves no side effect and the revealed
      // state is still reached, so it must NOT fail the reveal. Checked before the route-change guard.
      const hardBlock = blocked.slice(blockedBefore).find((b) => b.hard);
      if (hardBlock) { // L1: {method,urlPattern,reason} only — no raw url in the message
        throw envelopeError({ code: 'REVEAL_WRITE_BLOCKED', message: `reveal step ${step.templateId} fired a firewall-refused request ${hardBlock.method} ${hardBlock.urlPattern} (${hardBlock.reason}) at replay time — blocked (account unmutated), path refused`, exit: 'VIOLATION' });
      }
      // A reveal step that NAVIGATES broke the stay-on-page contract — reclassify unreachable
      // rather than crawl the wrong page (the route gate is routeRefused's job, not this one's).
      if (routeKey(page.url()) !== startRoute) {
        throw envelopeError({ code: 'REVEAL_NAVIGATED', message: `reveal step changed route to ${routeKey(page.url())} — no longer stay-on-page` });
      }
      resetTrackerVerdicts(page); // clear this step's verdicts before the next step (and the act)
    }
  } finally {
    // Teardown BEFORE the measured act: applyReveal returns to the caller, which then runs actStep.
    // A firewall left installed would abort the ACT's OWN legitimate non-GET. This teardown-before-
    // the-act ordering is LOAD-BEARING — never move the unroute after actStep.
    if (firewall) await page.unroute('**/*', firewall).catch(() => {});   // null under explore-all (never installed)
  }
}
