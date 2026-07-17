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
import { attachInitiatorTracker, pathKey } from './initiator.mjs';

const IDLE = '__idle__';
// Bounded wait for a kept fire's response body in endCause: a hung getResponseBody must never
// stall the crawl, so race a short timeout. Never affects WHICH fires are kept.
const BODY_AWAIT_MS = 500;
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

// Clear the page tracker's accumulated per-path verdicts, keeping the CDP arming. MUST be
// called before each act on a REUSED page (persistent session), so a path an earlier act
// click-rooted does not keep a later act's same-path background poll from being rejected.
// No-op if the page has no tracker (inert/failed CDP).
export function resetTrackerVerdicts(page) {
  const tracker = trackers.get(page);
  if (tracker && tracker.reset) tracker.reset();
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
// seq0 — the ring position to attribute fires from. Also stamps the CDP ledger cursor so
// the (later, purely-additive) response join only pairs requests from THIS act's window —
// this stamp does NOT touch seq0 or the token/initiator decision.
export async function beginCause(page, cause) {
  const seq0 = await page.evaluate((c) => {
    const s = window.__bughuntSeq;
    window.__bughuntCause = c;
    return s;
  }, String(cause));
  const tracker = trackers.get(page);
  if (tracker && tracker.markCursor) tracker.markCursor();
  return seq0;
}

// Reset the active cause to idle WITHOUT reading fires. Used when an action throws after
// beginCause, so a reused page (persistent session) is never left with a stale cause
// token that would mis-tag later background fires.
export async function resetCause(page) {
  try { await page.evaluate((idle) => { window.__bughuntCause = idle; }, IDLE); }
  catch { /* page gone — nothing to reset */ }
}

// The KEPT-SET decision — PURE and fully SYNCHRONOUS. Applies the token (cause + seq0), the
// initiator verdict, and the static-asset filter, and returns the surviving fires. It MUST NOT
// await: `verdictFor` reads the LIVE verdicts map, and a yield here would let a CDP
// requestWillBeSent land and flip a path's sticky `anyForeground` latch (false→true), so a
// later background poll could turn from rejected→kept = a phantom causal edge (the bughunt-
// agents failure class). Response metadata/bodies are attached AFTER this, never during it.
export function selectKept(fires, cause, seq0, verdictFor) {
  const causeStr = String(cause);
  const kept = [];
  for (const f of fires) {
    if (!f || typeof f !== 'object') continue;
    if (f.cause !== causeStr) continue;                                  // token: this control
    if (!Number.isFinite(Number(f.seq)) || Number(f.seq) < seq0) continue; // token: after the click
    const verdict = verdictFor ? verdictFor(f.url) : null;
    if (verdict && verdict.background) continue;                          // initiator: reject timer/parser
    if (f.wsRooted) continue;                                            // probe: reject WebSocket-onmessage roots (see probe.mjs)
    if (STATIC_RE.test(String(f.url))) continue;                         // ignore static assets
    kept.push(f);
  }
  return kept;
}

// Await one body promise, bounded so a hung getResponseBody can't stall the crawl. `.catch`
// hardens it: bodyPromise is resolve-only today, but a future rejecting body path must never
// throw out of endCause → actStep → reconLoop marking a successfully-acted control unreachable.
function boundedBody(promise) {
  let to;
  const timeout = new Promise((r) => { to = setTimeout(() => r(undefined), BODY_AWAIT_MS); });
  return Promise.race([promise, timeout]).catch(() => undefined).finally(() => clearTimeout(to));
}

// Read back the fires this control caused, then reset the cause to idle. Waits for the network
// to settle FIRST so async requests the action triggered have landed. TWO PASSES:
//   Pass 1 (selectKept) freezes the kept-set with ZERO await — byte-identical to the metadata-
//     only path, so response capture cannot change WHICH fires are attributed.
//   Pass 2 (below) is purely ADDITIVE on the frozen set: join metadata in fire order, then
//     await all response bodies TOGETHER (bounded per-promise, so the total stall is one window,
//     not N×). None of this can add or drop a fire.
export async function endCause(page, seq0, cause) {
  await waitSettled(page);
  const fires = await page.evaluate((idle) => {
    const out = window.__bughuntFires.slice();
    window.__bughuntCause = idle;
    return out;
  }, IDLE);
  const tracker = trackers.get(page);

  // PASS 1 — the decision. No await between reading fires and freezing `kept`.
  const kept = selectKept(fires, cause, seq0, tracker ? (u) => tracker.verdictFor(u) : null);

  // PASS 2 — enrichment on the FROZEN set. takeResponse runs synchronously in fire order (the
  // ordered ledger join); response bodies are collected and awaited concurrently at the end.
  if (tracker && tracker.takeResponse) {
    const pending = [];
    for (const f of kept) {
      const meta = tracker.takeResponse(f.method, pathKey(f.url));
      if (!meta) continue;
      f.status = meta.status;
      f.mimeType = meta.mimeType;
      f.resourceType = meta.resourceType;
      f.durationMs = meta.durationMs;
      if (meta.reqBody != null) f.reqBody = meta.reqBody; // redacted at store time (sync)
      if (meta.bodyPromise) pending.push(boundedBody(meta.bodyPromise).then((rb) => { if (typeof rb === 'string') f.respBody = rb; }));
    }
    if (pending.length) await Promise.all(pending);
  }
  return kept;
}
