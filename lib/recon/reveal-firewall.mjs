// Layer-3 replay-time WRITE-FIREWALL (split out of reveal-replay.mjs so both stay < 200 lines). A reveal
// click runs under __idle__ which suppresses only the GRAPH EDGE (selectKept drops the fire) — it does
// NOT abort the outbound network request. A non-GET fired by a reveal click (a mutation, or an adaptive
// server swapping a judged-read POST for a write) would STILL hit the server and mutate the LIVE authed
// account. This firewall (page.route, installed by replayRevealPath ONLY during replay) aborts any non-GET
// outside the opener path's OWN recorded reads — AND aborts any request (safe method included) that is
// off-origin or hits a danger route (a programmatic fetch('/logout') no <a href> guard can see).
//
// A blocked request is HARD or SOFT: a WRITE (any non-safe method) or a DANGER-route hit is HARD and fails
// the whole reveal; a benign OFF-ORIGIN SAFE-method sub-resource (a CDN image/font/pixel the revealed UI
// pulls in) is SOFT — aborted to stop the leak, but the reveal proceeds (a GET has no server side-effect
// and the revealed state is reached without it; failing on it broke reach on every real app with an
// off-origin asset). replayRevealPath fails only on a HARD block.

import { routeKey, isOffOriginHttp } from './scope.mjs';
import { routeRefused } from './danger-floor.mjs';
import { toUrlPattern } from '../graph/graph-store.mjs';
import { originOf } from '../browser/initiator.mjs';

export const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
// Mirrors graph-store's (private) reqKey so an allowlist key and a live-request key compare as identical strings.
const reqKey = (method, urlPattern) => `${String(method).toUpperCase()} ${urlPattern}`;

// Benign infrastructure non-GET fired INCIDENTALLY by a reveal click — analytics beacons, websocket
// transport polling, maps tiles. The abort still fires (no side effect reaches the account), but these
// are telemetry/transport, NOT app mutations, so an incidental one must NOT fail the whole reveal (SOFT,
// the reveal proceeds and the final visibility check decides). Curated + conservative; anything not on
// this list stays HARD. This recovers reveal-reach on real apps that beacon on every panel open.
export const BENIGN_TELEMETRY = /socket\.io|\/g\/collect\b|google-analytics|googletagmanager|\/gtag\b|ga-audiences|doubleclick|\/collect\b|\/beacon\b|\/telemetry\b|\/metrics\b|\bmaps_|\/maps\//i;

// Build the write-allowlist from the reveal path's OWN openers: for each step, the read-over-POST
// endpoints its template was RECORDED firing (its outgoing `triggers` edges). A judged-read POST is
// the ONLY non-GET class that makes a POST-nav opener replayable (the constant-URL SPA class); re-firing
// THOSE to reach the state is the INTENDED reach. ANY OTHER non-GET at replay time is a write we must
// not commit. §8 honest boundary: a same-urlPattern method/body swap of a recorded read is NOT caught.
export function buildWriteAllowlist(graph, statePath) {
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

// The page.route handler on EVERY outbound request (a reveal opener fires programmatic fetch()es no
// <a href> guard sees). Ordered: (1) ABORT off-origin OR danger-route, any method — a safe GET is NOT
// exempt (M2: fetch('/logout') would end an authed session before a post-hoc abort). It is HARD when it
// is a write (any non-safe method) OR a danger-route hit of any method; SOFT when it is a benign
// safe-method OFF-ORIGIN sub-resource. (2) SAFE → CONTINUE. (3) Non-GET → CONTINUE only the opener's OWN
// recorded reads, else ABORT (HARD). `blocked` entries carry {method, urlPattern, reason, hard}.
export function makeFirewallHandler(page, allowlist, blocked) {
  return async (route) => {
    const req = route.request();
    const method = String(req.method() || '').toUpperCase(); // BEFORE the risky ops — the catch needs it
    const safe = SAFE_METHODS.has(method);
    try {
      const url = req.url();
      const urlPattern = toUrlPattern(url); // full-url canon — symmetric with step.mjs's allowlist key (H1)
      const danger = routeRefused(routeKey(url));
      const pageUrl = page.url();
      const offOrigin = isOffOriginHttp(pageUrl, url);
      // The two origins the off-origin verdict is COMPUTED from. Recorded on every blocked entry so
      // a refusal can be audited rather than trusted: with only "(off-origin)" in the message, a
      // genuine cross-subdomain call and a firewall misfire read identically, and the most common
      // failure class of a live run could not be diagnosed at all. Origins only — [L1] still holds
      // (no raw url; the query keys survive masked in `urlPattern`) and an origin carries no query.
      const origins = { origin: originOf(url), pageOrigin: originOf(pageUrl) };
      if (danger || offOrigin) { // (1) HARD unless it is a SAFE-method OR benign-telemetry off-origin sub-resource
        blocked.push({ method, urlPattern, ...origins, reason: danger ? 'danger-route' : 'off-origin', hard: danger || (!safe && !BENIGN_TELEMETRY.test(urlPattern)) });
        await route.abort();
        return;
      }
      if (safe) { await route.continue(); return; } // (2) in-scope safe read
      // (3) Non-GET → only the opener's OWN recorded reads are re-firable.
      if (allowlist.has(reqKey(method, urlPattern))) { await route.continue(); return; }
      const tele = BENIGN_TELEMETRY.test(urlPattern);                    // incidental analytics/transport → SOFT
      blocked.push({ method, urlPattern, ...origins, reason: tele ? 'telemetry' : 'write', hard: !tele }); // L1: pattern + origin, never the raw url
      await route.abort();
    } catch {
      // Internal firewall error (NOT a policy abort). Fail CLOSED for a non-safe method (M1); fail
      // OPEN for a safe read so a bug never crashes the page on a benign GET.
      try { await (safe ? route.continue() : route.abort()); }
      catch { /* request already handled — nothing to fail to */ }
    }
  };
}

// Render ONE blocked entry for the operator-facing refusal message (reveal-replay's
// REVEAL_WRITE_BLOCKED). This is the first — often only — line an operator reads about the single
// largest failure class of a run, so it must name the EVIDENCE, not just the verdict: an
// "off-origin" refusal states the origin refused AND the page origin it was judged against, so
// "the app called its own api subdomain" and "the firewall misfired on its own host" are
// distinguishable at a glance. Live-lived without it: 22 refusals of one run, none diagnosable.
// Degrades to the bare reason when an origin is unknown (a relative/opaque url) — never a fake host.
export function describeBlock(b) {
  if (!b) return 'unknown request';
  const where = b.reason === 'off-origin' && b.origin && b.pageOrigin
    ? `${b.reason} ${b.origin} from ${b.pageOrigin}`
    : (b.origin ? `${b.reason} ${b.origin}` : b.reason);
  return `${b.method} ${b.urlPattern} (${where})`;
}
