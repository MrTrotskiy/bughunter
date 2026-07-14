// The causal substrate — an init-script injected BEFORE navigation plus the two
// pure readiness predicates that read its counters. Ported from bughunt-agents
// readiness.mjs; the init-script is kept EXACTLY (it is correct).
//
// stateProbeInitScript() monkeypatches fetch + XHR to (a) maintain
// window.__bughuntInflight / __bughuntTotal counters and (b) record every request
// into the bounded ring window.__bughuntFires as { cause, method, url, seq } where
// cause = window.__bughuntCause at call time. This is the whole causal channel:
// a request fired while cause is a control's id is bound to that control WITHOUT a
// wall-clock window, and page-load bursts / background polls fired while cause is
// '__idle__' stay uncredited.

export const READY_MIN_TEXT_DEFAULT = 120;

// `state` is the captured DOM snapshot: { textLen, pulses, ariaBusy }. Returns
// true when meaningful text is present AND no loading affordances remain. A
// genuinely stuck page (low textLen / skeletons / aria-busy) returns false.
export function deriveContentReady(state, { minText = READY_MIN_TEXT_DEFAULT } = {}) {
  if (!state || typeof state !== 'object') return false;
  const textLen = Number(state.textLen);
  const pulses = Number(state.pulses);
  const ariaBusy = Number(state.ariaBusy);
  if (!Number.isFinite(textLen) || !Number.isFinite(pulses) || !Number.isFinite(ariaBusy)) return false;
  return textLen >= minText && pulses === 0 && ariaBusy === 0;
}

// The probe is "settled" only AFTER the app has actually fetched something and
// then fully drained it (total > 0 && inflight === 0). The `total > 0` guard
// avoids a FALSE-settled at t0 — before the SPA fires its first request, inflight
// is trivially 0, which must NOT count as "the network drained".
export function deriveNetworkSettled(probe) {
  if (!probe || typeof probe !== 'object') return false;
  const total = Number(probe.total);
  const inflight = Number(probe.inflight);
  if (!Number.isFinite(total) || !Number.isFinite(inflight)) return false;
  return total > 0 && inflight === 0;
}

// State-probe readiness (paper N4) + CAUSAL CHANNEL. Injected BEFORE navigation so
// in-flight network activity is observable (deterministic "settled" for SPAs that
// never reach networkidle) AND every request is recorded against the walker's
// current cause token. Purely OBSERVATIONAL: it counts and records, never alters
// page behaviour, and is idempotent (guarded against re-injection). Every push is
// wrapped so a recording failure can never throw into the page.
export function stateProbeInitScript() {
  return `(() => {
  if (window.__bughuntProbe) return;
  window.__bughuntProbe = true;
  window.__bughuntInflight = 0;
  window.__bughuntTotal = 0;
  window.__bughuntCause = '__idle__';
  window.__bughuntSeq = 0;
  window.__bughuntFires = [];
  var FIRES_CAP = 500;
  var record = function (method, url) {
    try {
      var fires = window.__bughuntFires;
      fires.push({
        cause: window.__bughuntCause,
        method: String(method == null ? 'GET' : method).toUpperCase(),
        url: String(url == null ? '' : url),
        seq: window.__bughuntSeq++,
      });
      if (fires.length > FIRES_CAP) fires.shift();
    } catch (e) { /* recording must never break the page */ }
  };
  var inc = function () { window.__bughuntInflight++; window.__bughuntTotal++; };
  var dec = function () { window.__bughuntInflight = Math.max(0, window.__bughuntInflight - 1); };
  var of = window.fetch;
  if (typeof of === 'function') {
    window.fetch = function (input, init) {
      inc();
      try {
        var url = (input && typeof input === 'object' && 'url' in input) ? input.url : input;
        var method = (init && init.method) || (input && typeof input === 'object' ? input.method : null);
        record(method, url);
      } catch (e) { /* never block the request over a recording error */ }
      try { return of.apply(this, arguments).finally(dec); }
      catch (e) { dec(); throw e; }
    };
  }
  var XP = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XP && typeof XP.send === 'function') {
    var oo = XP.open;
    if (typeof oo === 'function') {
      XP.open = function (method, url) {
        try { this.__bughuntMethod = method; this.__bughuntUrl = url; } catch (e) { /* ignore */ }
        return oo.apply(this, arguments);
      };
    }
    var os = XP.send;
    XP.send = function () {
      inc();
      try { record(this.__bughuntMethod, this.__bughuntUrl); } catch (e) { /* ignore */ }
      try { this.addEventListener('loadend', dec, { once: true }); } catch (e) { dec(); }
      return os.apply(this, arguments);
    };
  }
})();`;
}
