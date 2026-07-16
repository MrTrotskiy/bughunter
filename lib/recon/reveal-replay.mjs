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
import { toUrlPattern } from '../graph/graph-store.mjs';

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

// Layer-3 replay-time WRITE-FIREWALL. The reveal replay MUST be side-effect-free, but a reveal
// click runs under __idle__ which suppresses only the GRAPH EDGE (selectKept drops the fire) — it
// does NOT abort the outbound network request. A non-GET fired by a reveal click (a mutation, or an
// adaptive server swapping a judged-read POST for a write) would STILL hit the server and mutate the
// LIVE authed account. The firewall (page.route, installed ONLY during replay) aborts any non-GET
// outside the opener path's OWN recorded reads — AND aborts any request (safe method included) that
// is off-origin or hits a danger route (a programmatic fetch('/logout') no <a href> guard can see).
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Mirrors graph-store's (private) reqKey so an allowlist key and a live-request key compare as identical strings.
const reqKey = (method, urlPattern) => `${String(method).toUpperCase()} ${urlPattern}`;

// Build the write-allowlist from the reveal path's OWN openers: for each step, the read-over-POST
// endpoints its template was RECORDED firing (its outgoing `triggers` edges). A judged-read POST is
// the ONLY non-GET class that makes a POST-nav opener replayable (the rawcaster nav class); re-firing
// THOSE to reach the state is the INTENDED reach. ANY OTHER non-GET at replay time is a write we must
// not commit. §8 honest boundary: a same-urlPattern method/body swap of a recorded read is NOT caught.
function buildWriteAllowlist(graph, statePath) {
  const allow = new Set();
  const edges = graph.edges || [];
  const requests = graph.requests || {};
  for (const step of statePath) {
    const from = `element:${step.templateId}`;
    for (const e of edges) {
      if (e.type !== 'triggers' || e.from !== from) continue;
      const key = e.to.replace(/^request:/, '');
      const method = String((requests[key] && requests[key].method) || key.split(' ')[0]).toUpperCase();
      // L2 defense-in-depth: ONLY a read-over-POST is ever re-firable — a PUT/PATCH/DELETE (or any other
      // non-GET) is never a "read", so a mis-judged non-idempotent verb is NEVER allowlisted (always
      // aborted). GET reads are already side-effect-free — continue, no allowlist.
      if (method !== 'POST') continue;
      allow.add(key);
    }
  }
  return allow;
}

// The page.route handler, ordered — mirrors the module's href guards but on EVERY outbound request
// (a reveal opener fires programmatic fetch()es no <a href> check sees); per-site rationale is inline:
//   (1) ANY method — ABORT off-origin OR danger-route (self-logout / GET-side-effect delete): a safe
//       GET is NOT exempt (M2), fetch('/logout') would end an authed session before a post-hoc abort.
//   (2) SAFE method → CONTINUE.  (3) Non-GET → CONTINUE only the opener's OWN recorded reads, else ABORT.
function makeFirewallHandler(page, allowlist, blocked) {
  return async (route) => {
    const req = route.request();
    const method = String(req.method() || '').toUpperCase(); // BEFORE the risky ops — the catch needs it
    try {
      const url = req.url();
      const urlPattern = toUrlPattern(url); // full-url canon — symmetric with step.mjs's allowlist key (H1)
      // (1) off-origin / self-logout / danger guards apply to a programmatic fetch too, any method (M2).
      if (isOffOriginHttp(page.url(), url) || routeRefused(routeKey(url))) {
        blocked.push({ method, urlPattern, reason: 'refused-route' });
        await route.abort();
        return;
      }
      if (SAFE_METHODS.has(method)) { await route.continue(); return; } // (2) in-scope safe read
      // (3) Non-GET → only the opener's OWN recorded reads are re-firable.
      if (allowlist.has(reqKey(method, urlPattern))) { await route.continue(); return; }
      blocked.push({ method, urlPattern, reason: 'write' }); // L1: pattern only, never the raw url
      await route.abort();
    } catch {
      // Internal firewall error (NOT a policy abort). Fail CLOSED for a non-safe method (M1); fail
      // OPEN for a safe read so a bug never crashes the page on a benign GET.
      try { await (SAFE_METHODS.has(method) ? route.continue() : route.abort()); }
      catch { /* request already handled — nothing to fail to */ }
    }
  };
}

// Replay reveal.statePath on an already-navigated (and overlay-dismissed) page. Throws an
// envelope error — which reconLoop turns into node.unreachable — on staleness / danger / a
// route change / a blocked replay-time write. On success the page is left in the revealed state,
// ready for the measured act.
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
  // Layer-3: build the write-allowlist from the openers' own recorded reads and INSTALL the firewall
  // BEFORE the replay loop. Nothing above this fires a request — the depth/cycle guards are pure — so
  // the firewall spans exactly the replay clicks, no more.
  const allowlist = buildWriteAllowlist(graph, statePath);
  const blocked = [];
  const firewall = makeFirewallHandler(page, allowlist, blocked);
  await page.route('**/*', firewall);
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
      const blockedBefore = blocked.length;
      await handle.click({ timeout: 5000 });
      await waitSettled(page);
      // Layer-3: the firewall aborted a non-allowlisted write this step — the reveal cannot proceed
      // side-effect-free, so FAIL honestly (→ reconLoop/whats-new mark the target unreachable, the
      // live account unmutated). Checked before the route-change guard so the write-block reason wins.
      if (blocked.length > blockedBefore) {
        const w = blocked[blocked.length - 1]; // L1: {method,urlPattern,reason} only — no raw url in the message
        throw envelopeError({ code: 'REVEAL_WRITE_BLOCKED', message: `reveal step ${step.templateId} fired a firewall-refused request ${w.method} ${w.urlPattern} (${w.reason}) at replay time — blocked (account unmutated), path refused`, exit: 'VIOLATION' });
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
    await page.unroute('**/*', firewall).catch(() => {});
  }
}
