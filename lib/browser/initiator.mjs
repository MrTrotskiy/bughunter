// Causal attribution — the CDP-initiator half of the walker. The causal token
// (probe.mjs) binds a request to whatever control was set as `cause` when the
// request fired; but window.__bughuntCause is a GLOBAL read at fire time, so a
// background poll that ticks WHILE a control's cause is set inherits that cause.
// The token alone cannot see that. This module classifies each request by its CDP
// initiator stack and REJECTS timer/parser-rooted fires, so page-load bursts and
// background polls stay uncredited even when they land inside a control's window.
//
// Ported from bughunt-agents lib/recon/initiator.mjs. Adaptation: verdicts are
// keyed by URL *pathname*, because the ring records whatever string was passed to
// fetch (often relative, e.g. "/api/ping") while CDP reports the absolute URL —
// matching on pathname joins the two views.

import { makeLedgerTracker } from './response-ledger.mjs';

// A timer/animation async-boundary description as it appears in a CDP stack's
// parent chain (Runtime.StackTrace.description on an async parent frame).
const TIMER_RE = /\b(setInterval|setTimeout|requestAnimationFrame|requestIdleCallback)\b/i;

// Exported so causal.mjs joins in-page fire urls to CDP ledger entries on the SAME pathname
// key — the ring records the (often relative) string fetch got while CDP reports absolute.
// Also imported by response-ledger.mjs to key its per-requestId entries on the same view.
export function pathKey(url) {
  try { return new URL(url, 'http://x').pathname; } catch { return String(url); }
}

// The ORIGIN view of a url — `pathKey`'s sibling, and the EVIDENCE half of every same-origin
// decision (scope.isOffOriginHttp compares exactly this). It exists because the path view is all
// we used to keep: a run's request records carried a host-less `urlPattern`, so a refusal that
// says "off-origin" could not be told apart from a firewall misfire — the log recorded the
// OUTCOME of a decision without its INPUT. Returns null for a RELATIVE url (no base is applied on
// purpose: `pathKey`'s 'http://x' base would mint a fake origin, and a fabricated host is worse
// than an absent one) and for an opaque origin (data:/blob:, where URL.origin is the string "null").
export function originOf(url) {
  try {
    const o = new URL(url).origin;
    return o && o !== 'null' ? o : null;
  } catch { return null; }
}

// True when a CDP initiator positively roots the request in a timer/animation loop
// or the HTML parser — a background poll or a page-load fetch, not a click. Walks
// the async parent chain (bounded) looking for a timer description; a `parser`
// initiator with no script stack is page-load markup. Everything else -> keep
// (background=false), because a false "background" would drop a real control edge
// and async continuations can carry empty callFrames.
export function classifyInitiator(initiator) {
  if (!initiator || typeof initiator !== 'object') return { background: false, reason: 'no-initiator' };
  const stack = initiator.stack;
  if (!stack || typeof stack !== 'object') {
    if (initiator.type === 'parser') return { background: true, reason: 'parser' };
    return { background: false, reason: initiator.type ? `type:${initiator.type}` : 'no-stack' };
  }
  let node = stack;
  let depth = 0;
  let lastTimer = null;
  while (node && typeof node === 'object' && depth < 64) {
    if (typeof node.description === 'string' && TIMER_RE.test(node.description)) {
      lastTimer = node.description;
    }
    node = node.parent;
    depth++;
  }
  if (lastTimer) return { background: true, reason: `timer:${lastTimer}` };
  return { background: false, reason: 'script' };
}

// Attach a CDP tracker that classifies every request's initiator as the walk runs.
// Returns { verdictFor(url), detach() }. verdictFor(url) reports background=true
// only when EVERY request seen for that pathname was background (a url ever fired
// from a click is kept), or null if the pathname was never seen. Best-effort: any
// CDP failure degrades to an inert tracker so attribution falls back to the token.
// The DOUBLE GATE for body capture — a pure predicate over env (unit-testable). OFF unless
// BOTH BUGHUNTER_CAPTURE_BODIES=1 AND a run is active (BUGHUNTER_RUN_ID set). The run-gate means
// login.mjs (which clears both before wiring, and opens no run) can NEVER capture a body — the
// credential exchange is never fetched or retained. Half-open (flag set, no run) → false.
export function bodyCaptureEnabled(env = process.env) {
  return env.BUGHUNTER_CAPTURE_BODIES === '1' && !!env.BUGHUNTER_RUN_ID;
}

export async function attachInitiatorTracker(page) {
  // Read the gate ONCE here (the single wiring point) and thread it as a flag — no env reads
  // scattered downstream.
  const captureBodies = bodyCaptureEnabled();
  // Inert fallback (CDP failed): every method null/no-op, so attribution degrades to the
  // token-only path and response metadata is simply absent — never wrong.
  const inert = {
    verdictFor: () => null, reset: () => {}, detach: async () => {},
    cursor: () => 0, markCursor: () => {}, takeResponse: () => null,
  };
  let session;
  try {
    session = await page.context().newCDPSession(page);
    await session.send('Network.enable').catch(() => {});
    // Async call stacks make a poll's setInterval/setTimeout root visible in the
    // initiator's parent chain — the signal classifyInitiator keys on.
    await session.send('Debugger.enable').catch(() => {});
    await session.send('Debugger.setAsyncCallStackDepth', { maxDepth: 32 }).catch(() => {});
  } catch {
    return inert;
  }
  // pathname -> { anyForeground, lastReason }. A path is "background" only if NO
  // request to it was ever click-rooted, so a poll that shares a path with a real
  // click never suppresses the click's edge.
  const verdicts = new Map();
  // The response ledger rides the SAME session — the attribution VERDICT below is decided
  // exactly as before; the ledger only records metadata for a later, purely-additive join.
  const ledgerT = makeLedgerTracker({ captureBodies });
  const onRequest = (params) => {
    try {
      const url = params && params.request && params.request.url;
      if (!url) return;
      const v = classifyInitiator(params.initiator);
      const key = pathKey(url);
      const prev = verdicts.get(key) || { anyForeground: false, lastReason: null };
      verdicts.set(key, {
        anyForeground: prev.anyForeground || !v.background,
        lastReason: v.reason,
      });
      ledgerT.onRequest(params); // metadata only — never feeds back into the verdict above
    } catch { /* ignore a single malformed event */ }
  };
  const onResponse = (params) => { try { ledgerT.onResponse(params); } catch { /* ignore */ } };
  const onFinished = (params) => {
    try {
      ledgerT.onFinished(params);
      // Body capture (gated). Fetch the response body HERE, at loadingFinished — the CDP
      // buffer is eviction-safe now but may be gone by endCause (up to 3s later after settle).
      // getResponseBody is a PASSIVE read: no page effect, so the kept set (decided by the
      // token + initiator filters) is unchanged. A failed fetch = body simply absent, never a
      // throw into the crawl. The promise is stored so endCause can bound-await it per fire.
      if (captureBodies && ledgerT.wantsBody(params.requestId)) {
        session.send('Network.getResponseBody', { requestId: params.requestId })
          .then((r) => ledgerT.onBody(params.requestId, r))
          .catch(() => ledgerT.onBody(params.requestId, null)); // settle the eager promise null
      }
    } catch { /* ignore */ }
  };
  session.on('Network.requestWillBeSent', onRequest);
  session.on('Network.responseReceived', onResponse);
  session.on('Network.loadingFinished', onFinished);
  return {
    verdictFor(url) {
      const v = verdicts.get(pathKey(url));
      if (!v) return null;
      return { background: !v.anyForeground, reason: v.lastReason };
    },
    // Response-metadata surface — additive, never consulted for attribution.
    cursor: () => ledgerT.cursor(),
    markCursor: () => ledgerT.markCursor(),
    takeResponse: (method, pathname) => ledgerT.takeResponse(method, pathname),
    // Clear accumulated per-path verdicts AND the per-requestId ledger WITHOUT dropping the
    // CDP arming (async stacks stay on). A reused page must reset between acts: the sticky
    // `anyForeground` flag would otherwise let a path a PRIOR act click-rooted suppress the
    // timer-rejection of a LATER act's same-path background poll — a phantom causal edge.
    // Clearing the ledger bounds it per act and restarts the cursor.
    reset() { verdicts.clear(); ledgerT.reset(); },
    async detach() {
      try { session.off('Network.requestWillBeSent', onRequest); } catch { /* ignore */ }
      try { session.off('Network.responseReceived', onResponse); } catch { /* ignore */ }
      try { session.off('Network.loadingFinished', onFinished); } catch { /* ignore */ }
      try { await session.detach(); } catch { /* ignore */ }
    },
  };
}
