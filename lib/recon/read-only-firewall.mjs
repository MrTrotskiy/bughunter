// SESSION-WIDE read-only WRITE-FIREWALL (docs/PHASE1-COLLECTION-PLAN.md §read-only). Distinct from the
// Layer-3 REPLAY firewall (reveal-firewall.mjs), which spans only a reveal-replay prologue: this one is
// installed for the WHOLE crawl session so a READ-ONLY recon walk is STRUCTURALLY unable to commit a write
// on a live authed account — the failure a live stateful rawcaster run just proved real (a `Follow` ICON
// with no English name slipped the name-based danger-floor and fired POST /rawcaster/followandunfollow, a
// real follow/unfollow mutation).
//
// ABORT-BY-DEFAULT (CTO blocker-1). The gate must block mutations WITHOUT breaking apps whose READS go over
// POST — rawcaster serves `listnuggets`, `getothersprofile`, `listevents`, `get_ad`, `getfollowlist` over
// POST and content never loads if those are aborted. The OLD firewall let ANY benign-named non-GET through
// (a POST /api/x123 with no write verb in its path reached the server); the fix INVERTS that. Each request
// classifies:
//   (a) GET / HEAD / OPTIONS                → CONTINUE (a read has no server side-effect).
//   (b) non-GET whose URL PATH matches WRITE_VERB_RE (an OBVIOUS mutation: /followandunfollow, /delete-…)
//                                           → ABORT + record {reason:'write-verb'}. Survives the operator
//                                              override — an obvious mutation is never continued.
//   (c) non-GET in the AGENT-JUDGED read-allowlist (a list/search over POST the agent classified `read`)
//                                           → CONTINUE + record {reason:'read-allowed'}. The ONLY widen.
//   (d) ANY OTHER non-GET                   → ABORT by default + record {reason:'write-blocked'}. A benign-
//                                              named write can no longer reach the server (the closed residual).
// OPERATOR OVERRIDE (--allow-benign-post, recon-run argv only, NEVER the agent): restores the old branch-(c)
// continue for zero-latency reach on a TRUSTED target — a non-GET that is neither a write-verb (b) nor an
// allowlisted read (c) is CONTINUED + recorded {reason:'non-get-allowed'}. Default OFF (abort-by-default).
//
// CAUSAL SAFETY: aborting at the network layer does NOT break causal capture. The probe's fetch/XHR
// monkeypatch records the fire the instant fetch() is CALLED (before the network), and CDP
// requestWillBeSent fires before the abort, so the token + initiator both still see the request — actStep
// records the control→endpoint edge (addTrigger) exactly as if it had completed. Only the SERVER side-
// effect is prevented; the API MAP is preserved (a blocked write still shows in the causal control→endpoint
// map, just with a null status).
//
// HONEST RESIDUAL (documented, not fixed here): an allowlisted READ whose method/body is later SWAPPED to a
// write on the SAME urlPattern (an adaptive server) is not caught — the allowlist keys on method+urlPattern
// (§8, same boundary reveal-firewall documents). The complementary NAME gate (danger-floor mutationFloor,
// opt-in at click time) catches a mutation-NAMED control firing a benign endpoint. Off-origin / danger-route
// are handled elsewhere (actStep, routeRefused, the reveal firewall) — this module is the WRITE gate.
//
// TRANSPORT BOUNDARY (open gap, security review M1): `page.route('**/*')` intercepts only HTTP(S) requests.
// A mutation sent over an OPEN WebSocket frame (`ws.send({action:'follow'})`) or a WebTransport stream is
// NOT seen by this gate — so on an app that mutates over raw WS, the "structurally read-only" contract holds
// only for HTTP(S), not for WS. The name gate (danger-floor) still refuses a mutation-NAMED control before
// the click, so a `Follow` control is stopped upstream regardless of transport; but a benign-named control
// firing a WS mutation is a residual. Closing it needs `page.routeWebSocket` with a read-vs-mutation frame
// policy (which client→server frames to drop without breaking a legit WS read-subscription) — deferred as a
// designed increment, NOT bolted on here. Until then this gate's guarantee is scoped to HTTP(S).

import { toUrlPattern } from '../graph/graph-store.mjs';
import { MUTATION_VERBS } from './danger-floor.mjs';
import { loadReadAllowlist, reqKey } from './read-allowlist.mjs';

// A read has no server side-effect — always continued.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// The write-verb gate over the ENDPOINT urlPattern (path). LEADING word boundary only (`\bverb`, not
// `\bverb\b`): a mutation verb is often a PREFIX of a compound path segment — `/rawcaster/followandunfollow`
// must match `follow` even though `follow` is glued to `and…`. The leading `\b` still spares a read whose
// verb is glued to a PREFIX (`getfollowlist` → `follow` is preceded by `t`, no boundary → NOT matched), so
// the rawcaster read-POST set survives. Built from the ONE curated vocabulary (danger-floor MUTATION_VERBS).
export const WRITE_VERB_RE = new RegExp(`\\b(${MUTATION_VERBS})`, 'i');

// The page.route handler on EVERY outbound request. `page` and `origin` are accepted for symmetry with the
// reveal firewall's handler and any future off-origin coupling; the write decision is method + path +
// allowlist only (off-origin/danger are gated elsewhere). `readAllow` is the Set of AGENT-JUDGED read keys
// (reqKey), `opts.allowBenignPost` the operator override. `blocked` accumulates {method, urlPattern, reason}
// for the aborted write-verbs, the allowlisted reads, the default-blocked writes, and (override) the allowed.
export function makeReadOnlyHandler(page, origin, blocked, readAllow = new Set(), opts = {}) {
  const allowBenignPost = !!opts.allowBenignPost;
  // strict.get is a LIVE flag (mutable by the caller between acts, like readAllow) that closes the
  // GET-commit hole for a reveal-opener act (security review H1): the write-firewall nets non-GET only,
  // so a mutation-NAMED control whose NAME-gate reveal-opener strips could still commit over a side-
  // effectful GET (RPC-over-GET, `GET /api/follow?id=42`). While strict.get is on, an OBVIOUS mutation-
  // verb GET is aborted too — so the exemption cannot leak a GET-committed mutation. Default OFF, so a
  // normal read stays byte-identical (a benign mutation-verb-named GET read is only aborted DURING the
  // reveal-opener act it is scoped to — a bounded coverage cost, never a permanent block).
  const strict = opts.strict && typeof opts.strict === 'object' ? opts.strict : { get: false };
  return async (route) => {
    const req = route.request();
    const method = String(req.method() || '').toUpperCase(); // BEFORE the risky ops — the catch needs it
    const safe = SAFE_METHODS.has(method);
    try {
      if (safe) {
        if (strict.get && method === 'GET') {                     // reveal-opener act: gate obvious-mutation GETs too
          const up = toUrlPattern(req.url());
          if (WRITE_VERB_RE.test(up)) { blocked.push({ method, urlPattern: up, reason: 'write-verb-get' }); await route.abort(); return; }
        }
        await route.continue(); return;                           // (a) a read — no side-effect
      }
      const urlPattern = toUrlPattern(req.url());                  // the ONE masker — symmetric with the graph's request keys
      if (WRITE_VERB_RE.test(urlPattern)) {                        // (b) an obvious mutation — ABORT (survives the operator override)
        blocked.push({ method, urlPattern, reason: 'write-verb' });
        await route.abort();
        return;
      }
      if (readAllow.has(reqKey(method, urlPattern))) {             // (c) an AGENT-JUDGED read (a list/search over POST) — CONTINUE
        blocked.push({ method, urlPattern, reason: 'read-allowed' });
        await route.continue();
        return;
      }
      if (allowBenignPost) {                                       // OPERATOR OVERRIDE — restore the old branch-c reach on a TRUSTED target
        blocked.push({ method, urlPattern, reason: 'non-get-allowed' });
        await route.continue();
        return;
      }
      blocked.push({ method, urlPattern, reason: 'write-blocked' }); // (d) DEFAULT: abort every other non-GET — the closed residual
      await route.abort();
    } catch {
      // Internal firewall error (NOT a policy abort). Fail CLOSED for a non-safe method (never let a bug
      // leak a mutation through), fail OPEN for a safe read (a bug must not crash the page on a benign GET).
      try { await (safe ? route.continue() : route.abort()); }
      catch { /* request already handled — nothing to fail to */ }
    }
  };
}

// Install the read-only firewall for the WHOLE session (page.route spans every act until torn down).
// `opts.readAllow` (a Set) overrides the file loader (tests inject one they can mutate live); otherwise the
// agent-populated state/read-allowlist.json is loaded. `opts.allowBenignPost` is the operator override.
// Returns { blocked, readAllow, teardown } — `blocked` is the live ledger, `readAllow` the live Set the
// handler consults (mutable — an appended read takes effect without re-install), `teardown` removes ONLY
// this handler (page.unroute of the exact function), so a co-installed reveal firewall is never disturbed.
export async function installReadOnlyFirewall(page, opts = {}) {
  let origin = '';
  try { origin = new URL(page.url()).origin; } catch { /* pre-navigation: origin unknown, unused by the decision */ }
  const blocked = [];
  const readAllow = opts.readAllow instanceof Set ? opts.readAllow : loadReadAllowlist();
  // The live strict-GET flag (H1): the caller flips strict.get on around a reveal-opener act so an
  // obvious mutation-verb GET is aborted too, then off again — the handler reads it per-request.
  const strict = { get: false };
  const handler = makeReadOnlyHandler(page, origin, blocked, readAllow, { allowBenignPost: !!opts.allowBenignPost, strict });
  await page.route('**/*', handler);
  const teardown = async () => { await page.unroute('**/*', handler).catch(() => {}); };
  return { blocked, readAllow, strict, teardown };
}

// Compact the blocked ledger for the run result (the "would-be-mutations refused" surface). Counts each
// class and dedupes the ABORTED patterns (write-verb + write-blocked) so the operator sees WHAT was refused,
// not N repeats. readAllowed = agent-opened reads; nonGetAllowed = operator-override allowances (0 by default).
export function summarizeBlocked(blocked) {
  // write-verb-get (the reveal-opener strict-GET abort, H1) folds into the write-verb class — both are an
  // OBVIOUS mutation-verb endpoint aborted, surfaced in refusedPatterns so the operator sees it was caught.
  const writeVerb = blocked.filter((b) => b.reason === 'write-verb' || b.reason === 'write-verb-get');
  const writeBlocked = blocked.filter((b) => b.reason === 'write-blocked');
  const readAllowed = blocked.filter((b) => b.reason === 'read-allowed');
  const nonGetAllowed = blocked.filter((b) => b.reason === 'non-get-allowed');
  const refusedPatterns = Array.from(new Set([...writeVerb, ...writeBlocked].map((b) => `${b.method} ${b.urlPattern}`)));
  return {
    writeVerbBlocked: writeVerb.length,
    writeBlocked: writeBlocked.length,
    readAllowed: readAllowed.length,
    nonGetAllowed: nonGetAllowed.length,
    refusedPatterns,
  };
}
