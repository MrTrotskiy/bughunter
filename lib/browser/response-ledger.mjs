// The per-requestId RESPONSE LEDGER — the CDP-free half of the initiator tracker, factored
// out of initiator.mjs so the classifier and the ledger stay single-responsibility and its
// cursor + ordered-take logic is unit-testable with synthetic CDP params (no browser).
// requestWillBeSent → an ORDERED array (the join) + a byId Map (O(1) response updates);
// takeResponse(method, pathname) returns the FIRST unmatched entry from the act's cursor
// onward and marks it taken, so duplicate (method,pathname) fires in one window pair in
// FIRE ORDER. It carries NO attribution weight — causal.mjs joins it onto fires ALREADY
// selected by the token + initiator filters, so response capture is purely additive.
//
// NOTE: same-(method,pathname) pairing is ORDER-APPROXIMATE — it relies on
// Network.requestWillBeSent arriving in fire order to line up the i-th fire with the i-th
// ledger entry. This affects METADATA only (which status/type lands on which duplicate) and
// can NEVER change attribution: the kept set is decided entirely by causal.mjs.

import { pathKey } from './initiator.mjs';
import { bodyAllowed, redactBody } from './redact.mjs';

// Defensive cap on the ledger so a pathological act (thousands of fires in one window)
// cannot grow it unbounded. Deliberately 2x probe.mjs's 500-entry fire-ring — NOT a mirror:
// the ledger must never drop an entry the ring might still hold, so its cap sits above the
// ring's. A shift decrements the act cursor in lock-step so the window boundary stays
// aligned; past 1000 requests in ONE act it degrades to missing metadata, never an
// attribution change (the kept set is decided elsewhere).
const LEDGER_CAP = 1000;

// Read a header value case-insensitively (CDP header keys keep their original casing).
function headerValue(headers, name) {
  if (!headers || typeof headers !== 'object') return null;
  const target = name.toLowerCase();
  for (const k of Object.keys(headers)) if (k.toLowerCase() === target) return headers[k];
  return null;
}

// A request body is captured ONLY for JSON / form-urlencoded / text content-types — an
// off-allowlist, multipart, or UNTYPED postData is SKIPPED (secrets-first: a binary/multipart
// upload is never reconstructed or buffered). Both the `postData` string and the decoded
// `postDataEntries` fall under this one gate.
function requestBodyAllowed(ct) {
  return bodyAllowed(ct) || /^application\/x-www-form-urlencoded\b/i.test(String(ct || ''));
}
function extractPostData(req) {
  if (!req) return null;
  if (!requestBodyAllowed(headerValue(req.headers, 'content-type'))) return null;
  if (typeof req.postData === 'string' && req.postData.length) return req.postData;
  if (Array.isArray(req.postDataEntries) && req.postDataEntries.length) {
    try { return req.postDataEntries.map((e) => (e && e.bytes) ? Buffer.from(e.bytes, 'base64').toString('utf8') : '').join(''); }
    catch { return null; }
  }
  return null;
}

// captureBodies is the DOUBLE GATE (BUGHUNTER_CAPTURE_BODIES=1 AND an active run), read ONCE
// where the tracker is wired (initiator.mjs) and passed in — never an env read here. When
// false (the default, and always during the login pre-step, which opens no run) NO body is
// retained: reqBody is never stored, wantsBody is false, onBody is a no-op.
export function makeLedgerTracker({ cap = LEDGER_CAP, captureBodies = false } = {}) {
  const ledger = [];
  const byId = new Map();
  let causeCursor = 0; // ledger index the current act's fires start at (set by markCursor)
  return {
    // Append one requestWillBeSent; status/mimeType/endTs are filled later by the handlers.
    onRequest(params) {
      const url = params && params.request && params.request.url;
      if (!url) return;
      const entry = {
        requestId: params.requestId,
        method: String((params.request && params.request.method) || 'GET').toUpperCase(),
        pathname: pathKey(url),
        resourceType: params.type ?? null,
        status: null,
        mimeType: null,
        startTs: params.timestamp ?? null,
        endTs: null,
        taken: false,
      };
      // Redact + cap the request body AT STORE TIME (gated) so a raw secret never persists,
      // even in memory. mimeType picks the redaction strategy (form/json/text).
      if (captureBodies) {
        const raw = extractPostData(params.request);
        if (raw != null) entry.reqBody = redactBody(raw, headerValue(params.request.headers, 'content-type'));
      }
      ledger.push(entry);
      if (params.requestId != null) byId.set(params.requestId, entry);
      if (ledger.length > cap) {
        const dropped = ledger.shift();
        if (dropped && dropped.requestId != null) byId.delete(dropped.requestId);
        if (causeCursor > 0) causeCursor--; // keep the act-window boundary aligned after a shift
      }
    },
    // Fill status + mime (+ refine resourceType) onto the matching requestId entry.
    onResponse(params) {
      const e = params && byId.get(params.requestId);
      if (!e) return;
      if (params.response) {
        e.status = params.response.status ?? e.status;
        e.mimeType = params.response.mimeType ?? e.mimeType;
      }
      e.resourceType = params.type ?? e.resourceType;
      // Create the response-body promise EAGERLY here: responseReceived reliably precedes the
      // act's endCause join (status joins hard in the metadata test), while loadingFinished —
      // where the body is actually fetched — can LAG it. So endCause always has a promise to
      // bound-await; onBody resolves it once the body lands (or null on a failed fetch).
      if (captureBodies && e.bodyPromise == null && bodyAllowed(e.mimeType)) {
        e.bodyPromise = new Promise((resolve) => { e.bodyResolve = resolve; });
      }
    },
    // Stamp the finish time so a duration can be derived at take time.
    onFinished(params) {
      const e = params && byId.get(params.requestId);
      if (e) e.endTs = params.timestamp ?? e.endTs;
    },
    // Whether the initiator should fetch this response's body: gated ON, entry known, and its
    // mimeType on the allowlist (skip binary / text/html). Called at loadingFinished, where
    // the mimeType is already filled by onResponse.
    wantsBody(requestId) {
      if (!captureBodies) return false;
      const e = byId.get(requestId);
      return !!(e && bodyAllowed(e.mimeType));
    },
    // Store the fetched response body, REDACTED + CAPPED at capture time (skips base64/binary
    // and any entry whose mimeType is not allowed), then SETTLE the eager promise from
    // onResponse so endCause's bound-await unblocks. `result` null (a failed getResponseBody)
    // settles it with null — the body is simply absent, never a throw into the crawl.
    onBody(requestId, result) {
      const e = byId.get(requestId);
      if (!e) return null;
      let redacted = null;
      if (captureBodies && result && !result.base64Encoded && bodyAllowed(e.mimeType) && typeof result.body === 'string') {
        redacted = redactBody(result.body, e.mimeType);
        e.respBody = redacted;
      }
      if (e.bodyResolve) { e.bodyResolve(redacted); e.bodyResolve = null; }
      return redacted;
    },
    cursor() { return ledger.length; },
    markCursor() { causeCursor = ledger.length; },
    // First unmatched entry at index >= the act cursor with this (method, pathname), marked
    // taken so a duplicate fire in the SAME window takes the NEXT entry (fire order).
    takeResponse(method, pathname) {
      const m = String(method || 'GET').toUpperCase();
      for (let i = Math.max(0, causeCursor); i < ledger.length; i++) {
        const e = ledger[i];
        if (e.taken || e.method !== m || e.pathname !== pathname) continue;
        e.taken = true;
        const durationMs = (e.endTs != null && e.startTs != null)
          ? Math.round((e.endTs - e.startTs) * 1000) : null;
        // reqBody is resolved (redacted at store time); bodyPromise is the in-flight response-
        // body fetch endCause bound-awaits. Both are absent unless captureBodies is ON.
        return {
          status: e.status, mimeType: e.mimeType, resourceType: e.resourceType, durationMs,
          reqBody: e.reqBody ?? null, bodyPromise: e.bodyPromise ?? null,
        };
      }
      return null;
    },
    reset() { ledger.length = 0; byId.clear(); causeCursor = 0; },
  };
}
