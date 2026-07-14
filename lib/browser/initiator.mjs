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

// A timer/animation async-boundary description as it appears in a CDP stack's
// parent chain (Runtime.StackTrace.description on an async parent frame).
const TIMER_RE = /\b(setInterval|setTimeout|requestAnimationFrame|requestIdleCallback)\b/i;

function pathKey(url) {
  try { return new URL(url, 'http://x').pathname; } catch { return String(url); }
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
export async function attachInitiatorTracker(page) {
  const inert = { verdictFor: () => null, detach: async () => {} };
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
    } catch { /* ignore a single malformed event */ }
  };
  session.on('Network.requestWillBeSent', onRequest);
  return {
    verdictFor(url) {
      const v = verdicts.get(pathKey(url));
      if (!v) return null;
      return { background: !v.anyForeground, reason: v.lastReason };
    },
    async detach() {
      try { session.off('Network.requestWillBeSent', onRequest); } catch { /* ignore */ }
      try { await session.detach(); } catch { /* ignore */ }
    },
  };
}
