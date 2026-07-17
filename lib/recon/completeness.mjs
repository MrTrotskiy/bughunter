// completeness — the Chao2 mark-recapture COMPLETENESS ORACLE over ≥2 INDEPENDENT crawls. It answers a
// question route-coverage.mjs cannot: how many sections/controls exist that we NEVER discovered at all
// (the "dark matter" beyond the known denominator). route-coverage is EXACT over the KNOWN routes; this
// ESTIMATES the unseen tail from replicated detection.
//
// WHY Chao2, not Chao1 (decisions.md 2026-07-17): a dedup crawler visits each item exactly ONCE per run,
// so within ONE crawl every abundance is 1 → Chao1 (which needs singletons vs doubletons of ABUNDANCE)
// is degenerate. Chao2 is INCIDENCE-based: run the crawl T≥2 times (with a SHUFFLED frontier / capped
// budget so the runs genuinely differ), and for each distinct item count in HOW MANY of the T runs it was
// detected. Items seen in exactly one run (Q1) vs exactly two (Q2) drive the estimate of the undetected
// tail. Two identical exhaustive drains give Q1=0 → f0=0 → 100% (honest: "we converged"); the estimate
// only becomes informative when the re-crawls vary.
//
// Estimator (Chao 1987; Colwell/EstimateS incidence form), T = number of samples:
//   Q1 = #items detected in EXACTLY 1 sample · Q2 = #items detected in EXACTLY 2 samples
//   f0 (undetected) = ((T-1)/T) · Q1²/(2·Q2)          when Q2 > 0
//                   = ((T-1)/T) · Q1·(Q1-1)/2          when Q2 = 0  (bias-corrected form)
//   Ŝ = S_obs + f0 · completeness C = S_obs / Ŝ  (∈ (0,1]; C=1 ⟺ f0=0)
//
// Pure math + pure graph reads, no browser. The item KEY must be STABLE across independent crawls —
// NEVER the incremental templateId (a per-graph counter: id 3 is a different control in each graph).
// Routes key on their routeKey; controls on route + the structural templateSelector (indices normalized,
// framework-noise ids stripped by INC.1), so the SAME physical control carries the SAME key in every run.

// Chao2 over T detection sets. `perSample` is an array (T ≥ 2) of iterables of item keys (Set/array).
// Returns the estimate + its inputs. Throws on T < 2 — mark-recapture is undefined for a single sample
// (the caller surfaces this as an honest refusal, never a faked 100%).
export function chao2(perSample) {
  const samples = perSample.map((s) => new Set(s));
  const T = samples.length;
  if (T < 2) throw new Error('COMPLETENESS_NEEDS_2: Chao2 mark-recapture needs ≥2 independent crawls');
  // Incidence: for each distinct item, in how many of the T samples it was detected.
  const incidence = new Map();
  for (const set of samples) for (const key of set) incidence.set(key, (incidence.get(key) || 0) + 1);
  const sObs = incidence.size;
  let q1 = 0;
  let q2 = 0;
  for (const count of incidence.values()) {
    if (count === 1) q1++;
    else if (count === 2) q2++;
  }
  const corr = (T - 1) / T; // finite-sample correction; → 1 as T grows
  const f0 = q2 > 0 ? corr * (q1 * q1) / (2 * q2) : corr * (q1 * (q1 - 1)) / 2;
  const estimated = sObs + f0;
  // C=1 when nothing is undetected AND when nothing was observed (sObs=0 → vacuously complete).
  const completeness = estimated > 0 ? sObs / estimated : 1;
  return {
    samples: T,
    sampleSizes: samples.map((s) => s.size),
    sObs,
    q1,
    q2,
    undetected: f0,           // estimated # of items present but detected in NO sample
    estimated,                // Ŝ = S_obs + f0
    completeness,             // S_obs / Ŝ
    // Honest guardrail: Q1=0 means the samples agree perfectly — no informative tail. This is TRUE
    // convergence OR the re-crawls were not actually varied (deterministic full drains). Flagged so a
    // trivial 100% is never read as proof of completeness.
    converged: q1 === 0,
  };
}

// Item-key extractor — ROUTE dimension. A detection = a route the crawl actually VISITED (non-pending).
// `:param` PATTERNS are structural denominators, never concrete detections, so they are excluded.
// Pending (discovered-but-not-visited) routes are excluded by default: they are NOT detections of that
// run, and including them would credit a route the run never reached.
export function routeItemKeys(graph, { includePending = false } = {}) {
  const routes = graph.routes || {};
  const keys = new Set();
  for (const [rk, n] of Object.entries(routes)) {
    if (n.unreachable === 'param-pattern') continue;
    if (!includePending && n.pending) continue;
    // GOAL 2/5: a concrete `:param` instance (paramInstanceOf) keys by its PATTERN, so different concretes
    // of the same pattern across SHUFFLED re-crawls (run A lands /nugget/1, run B /nugget/2) count as ONE
    // item — else every distinct concrete reads as a unique detection (Q1) and Chao2 grossly over-estimates
    // the undetected tail. The pattern itself is the honest "one section" the instances represent.
    keys.add(n.paramInstanceOf || rk);
  }
  return keys;
}

// Item-key extractor — CONTROL (template) dimension. Keyed on route + the structural templateSelector
// (falls back to role|name when a selector is absent) — a CROSS-GRAPH-stable identity, never templateId.
// The route prefix disambiguates the same selector appearing on different sections.
export function templateItemKeys(graph) {
  const els = graph.elements || {};
  const keys = new Set();
  for (const n of Object.values(els)) {
    const sig = n.templateSelector || `${n.role || '?'}|${n.name || ''}`;
    keys.add(`${n.route || ''} ${sig}`);
  }
  return keys;
}

// Compute both dimensions from an array of loaded graphs (T ≥ 2). Returns { ok, route, template } or an
// honest refusal object when fewer than 2 graphs are supplied (no faked estimate).
export function completenessOf(graphs) {
  if (!Array.isArray(graphs) || graphs.length < 2) {
    return { ok: false, reason: 'COMPLETENESS_NEEDS_2', message: 'need ≥2 crawl graphs (shuffled re-crawls) for mark-recapture' };
  }
  return {
    ok: true,
    route: chao2(graphs.map((g) => routeItemKeys(g))),
    template: chao2(graphs.map((g) => templateItemKeys(g))),
  };
}

function pct(x) { return `${(x * 100).toFixed(1)}%`; }

function dimensionLine(label, r) {
  const note = r.converged
    ? '  (Q1=0: samples converged — exhaustive, or the re-crawls were not varied; estimate is not informative)'
    : '';
  return [
    `${label}: ${pct(r.completeness)} complete — ${r.sObs} observed, ~${Math.round(r.undetected)} undetected (Ŝ≈${r.estimated.toFixed(1)})`,
    `  ${r.samples} samples, sizes [${r.sampleSizes.join(', ')}] · Q1=${r.q1} (unique) · Q2=${r.q2} (shared-by-2)${note}`,
  ].join('\n');
}

// Full --completeness view: the Chao2 estimate for BOTH the route (section) and control (template)
// dimensions, with the raw Q1/Q2 inputs so the operator can see WHY the estimate is what it is.
export function renderCompleteness(res) {
  if (!res.ok) return `Completeness: cannot estimate — ${res.message}`;
  return [
    'Completeness (Chao2 mark-recapture over independent crawls):',
    dimensionLine('Sections (routes)', res.route),
    dimensionLine('Controls (templates)', res.template),
  ].join('\n');
}
