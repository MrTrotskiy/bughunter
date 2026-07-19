// GROUND TRUTH — score the crawl against what the application ACTUALLY contains, not against what the
// crawl happened to find.
//
// THE PROBLEM THIS ENDS. Every coverage number this project has published was computed over a denominator
// the crawler builds itself: "of the elements we discovered, how many did we understand". That metric
// partly measures itself, and it is why three headline numbers were retracted this session after audits —
// a percentage could rise while absolute understanding fell, simply because the denominator collapsed
// faster than the numerator. With a target whose source we can read, the denominator moves OUTSIDE.
//
// THE MEASURE THAT MATTERS MOST IS NOT THE HEADLINE. A source-derived answer key is only useful while the
// answer key exists, and most targets have no `data-testid` at all — so a tool that quietly starts DEPENDING
// on testids would post excellent numbers here and fail everywhere else. That failure would be invisible in
// a single coverage percentage.
//
// So the headline is deliberately a PAIR, and the number to watch is the gap between them:
//   tagged   — coverage over elements the source marks with a data-testid
//   orphan   — coverage over elements the source calls interactive but leaves UNMARKED (443 of 1757 here)
//
// The orphans are a live proxy for a site with no test attributes whatsoever. Parity means the crawler is
// finding controls by their structure and behaviour, which is what has to keep working elsewhere. A gap
// means it has learned to lean on a crutch, and it says so in the same breath as the good number rather
// than a month later on someone else's application.

// Read the answer key produced by the per-target ground-truth rig (kept out of git under `targets/`).
export function loadGroundTruth(json) {
  const routes = new Map();
  for (const r of json.routes || []) routes.set(r.path, r);
  return { totals: json.totals || {}, routes, confidence: json.confidence || {} };
}

// Every testid the live crawl actually SAW, keyed from the graph. `locator` is the derived per-element
// address dom-snapshot classifies (testid highest-precedence); the raw attribute is the authority when
// present, because the locator may have fallen back to role+name for an element that does carry one.
export function observedTestids(graph) {
  const seen = new Set();
  const acted = new Set();
  for (const node of Object.values(graph?.elements || {})) {
    const id = node.testid || (typeof node.locator === 'string' && (node.locator.match(/\[data-testid=["']?([^"'\]]+)/) || [])[1]);
    if (!id) continue;
    seen.add(id);
    // ACTED, not merely discovered. Presence in a snapshot proves the element exists; only a recorded probe
    // proves we learned anything about it, which is the same distinction the knowledge ladder draws between
    // L1 REACHED and L2 EXERCISED. Scoring discovery alone would re-import "we saw it, therefore it counts".
    if ((node.probes || []).some((p) => p && !p.blocked && p.verdict)) acted.add(id);
  }
  return { seen, acted };
}

// A template testid (`project-row-${p.id}`) can never be matched literally, so it is matched by PREFIX.
// Kept separate from the exact set: conflating them would let one lucky row claim a whole family.
function matchesTemplate(base, observed) {
  const stem = String(base).replace(/\$\{.*$/, '');
  if (stem.length < 4) return false;                 // too short to be evidence of anything
  for (const id of observed) if (id.startsWith(stem)) return true;
  return false;
}

// Score one route, or the whole app when `path` is omitted.
//
// UNFOUND ENTRIES ARE NAMED, never merely counted. A coverage number tells you how much is missing; a list
// tells you what, which is the difference between a metric and a work queue. This is the same honest-
// denominator discipline the ladder applies to BLOCKED.
export function scoreRoute(route, observed, { sample = 12 } = {}) {
  const exact = route.testids || [];
  const templates = route.templateTestids || [];
  const foundExact = exact.filter((id) => observed.acted.has(id));
  const foundTemplate = templates.filter((base) => matchesTemplate(base, observed.acted));
  const declared = exact.length + templates.length;
  const found = foundExact.length + foundTemplate.length;
  return {
    path: route.path,
    declared,
    found,
    pct: declared ? Math.round((found / declared) * 1000) / 10 : null,
    // The elements the source says are here and the crawl never exercised — the work queue.
    missing: exact.filter((id) => !observed.acted.has(id)).slice(0, sample),
    missingCount: declared - found,
    orphansDeclared: route.orphanCount || 0,
  };
}

// The headline PAIR plus the gap. `orphanFound` cannot be derived from testids by definition, so the caller
// supplies the crawl's own count of exercised elements that carry NO testid — the honest, if coarser,
// counterpart. Reporting the gap is the point; reporting only `taggedPct` would hide the dependency this
// whole module exists to detect.
export function overallScore(gt, observed, { orphanFound = null } = {}) {
  let declared = 0;
  let found = 0;
  const worst = [];
  for (const route of gt.routes.values()) {
    const s = scoreRoute(route, observed);
    declared += s.declared;
    found += s.found;
    if (s.declared >= 10) worst.push(s);
  }
  worst.sort((a, b) => (a.pct ?? 101) - (b.pct ?? 101));
  const taggedPct = declared ? Math.round((found / declared) * 1000) / 10 : 0;
  const orphansDeclared = gt.totals.orphans || 0;
  const orphanPct = orphanFound != null && orphansDeclared
    ? Math.round((orphanFound / orphansDeclared) * 1000) / 10 : null;
  return {
    taggedPct,
    found,
    declared,
    orphanPct,
    orphanFound,
    orphansDeclared,
    // POSITIVE means the crawler does better on marked elements than unmarked ones — the dependency signal.
    // Watch this, not the headline: it is what predicts behaviour on a target with no test attributes.
    dependencyGap: orphanPct == null ? null : Math.round((taggedPct - orphanPct) * 10) / 10,
    worstRoutes: worst.slice(0, 8),
  };
}
