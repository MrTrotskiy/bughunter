// The walker primitive around the causal init-script. beginCause/endCause bracket
// a single control interaction and return exactly the requests THAT control fired,
// with no wall-clock window. Two filters make an attributed request survive:
//   1. token  — f.cause === this control AND f.seq >= the pre-click snapshot
//               (excludes page-load bursts fired earlier under '__idle__').
//   2. initiator — the page-lifetime CDP tracker must not classify the request as
//               timer/parser rooted (excludes a background poll that ticked
//               mid-window and inherited this control's cause token).
//
// The initiator tracker is attached at LAUNCH (attachCausalTracker), NOT here: CDP
// async call stacks must be enabled BEFORE the page schedules its timers, or a
// setInterval scheduled at page-load carries no timer parent and its polls would be
// misclassified as foreground. So the tracker lives for the page's whole lifetime.

import { deriveNetworkSettled } from './probe.mjs';
import { attachInitiatorTracker } from './initiator.mjs';

const IDLE = '__idle__';
// Page-lifetime CDP tracker, keyed by page so the primitives keep the task's
// (page, seq0, cause) signatures without threading a handle through every call.
const trackers = new WeakMap();
// Static assets are never a meaningful causal edge — drop them from the result.
const STATIC_RE = /\.(?:js|mjs|cjs|css|png|jpe?g|gif|svg|webp|avif|ico|woff2?|ttf|otf|eot|map)(?:$|\?)/i;

// Attach the initiator tracker for a page. MUST be called before navigation so CDP
// async call stacks are enabled before the page schedules its timers. Idempotent
// per page. Returns the tracker (also useful for tests).
export async function attachCausalTracker(page) {
  let tracker = trackers.get(page);
  if (tracker) return tracker;
  tracker = await attachInitiatorTracker(page);
  trackers.set(page, tracker);
  return tracker;
}

export async function detachCausalTracker(page) {
  const tracker = trackers.get(page);
  trackers.delete(page);
  try { await (tracker && tracker.detach()); } catch { /* ignore */ }
}

// Poll the probe until the network drains (total > 0 && inflight === 0) or the
// bounded timeout elapses. Persistent-connection apps never settle, hence bounded.
export async function waitSettled(page, { timeout = 3000, interval = 60 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    let probe;
    try {
      probe = await page.evaluate(() => ({
        total: window.__bughuntTotal,
        inflight: window.__bughuntInflight,
      }));
    } catch { return false; }
    if (deriveNetworkSettled(probe)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((r) => setTimeout(r, interval));
  }
}

// Snapshot the fire-ring cursor, then set this control as the active cause. Returns
// seq0 — the ring position to attribute fires from.
export async function beginCause(page, cause) {
  return await page.evaluate((c) => {
    const s = window.__bughuntSeq;
    window.__bughuntCause = c;
    return s;
  }, String(cause));
}

// Reset the active cause to idle WITHOUT reading fires. Used when an action throws after
// beginCause, so a reused page (persistent session) is never left with a stale cause
// token that would mis-tag later background fires.
export async function resetCause(page) {
  try { await page.evaluate((idle) => { window.__bughuntCause = idle; }, IDLE); }
  catch { /* page gone — nothing to reset */ }
}

// Read back the fires this control caused, then reset the cause to idle. Waits for
// the network to settle FIRST so async requests the action triggered have landed.
export async function endCause(page, seq0, cause) {
  await waitSettled(page);
  const fires = await page.evaluate((idle) => {
    const out = window.__bughuntFires.slice();
    window.__bughuntCause = idle;
    return out;
  }, IDLE);
  const tracker = trackers.get(page);
  const causeStr = String(cause);
  const kept = [];
  for (const f of fires) {
    if (!f || typeof f !== 'object') continue;
    if (f.cause !== causeStr) continue;                                  // token: this control
    if (!Number.isFinite(Number(f.seq)) || Number(f.seq) < seq0) continue; // token: after the click
    const verdict = tracker ? tracker.verdictFor(f.url) : null;
    if (verdict && verdict.background) continue;                          // initiator: reject timer/parser
    if (STATIC_RE.test(String(f.url))) continue;                         // ignore static assets
    kept.push(f);
  }
  return kept;
}
