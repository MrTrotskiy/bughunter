// route-coverage — the ROUTE-LEVEL completeness oracle (EXACT, not estimated) over graph.routes. Its
// honest headline is COLLECTED (own content), NOT bare "reached": a section counts as genuinely
// collected only when it is visited AND rendered ≥1 element template of its OWN (an element with
// el.route === the route). A route that SAME-ORIGIN-redirects to another section (/events → /dashboard)
// or renders a Not-Found page is "visited" but carries no controls of its own — it must NOT inflate the
// collected count, or the report lies (the exact trust failure the whole-site investigation named).
//
// Three buckets over the declared+discovered STATIC sections (`:param` patterns stay separate, counted
// apart as they already are): collected (visited, own content) · visited-but-empty (visited, 0 controls —
// Not-Found / content-starved) · unreachable (redirect / 404 / off-origin). Plus pending. Pure read over
// the graph, no browser. The manifest EXPANDS the denominator; "collected" is claimed ONLY from real
// content, never from a visit alone.

import { oneLine } from '../core/text.mjs';

export function routeCoverageOf(graph) {
  const nodes = Object.values(graph.routes || {});
  const sections = nodes.filter((n) => n.unreachable !== 'param-pattern');
  // Routes that rendered their OWN content: ≥1 element template is attributed to the route. This is the
  // honest signal of a genuinely collected section — a redirect target or Not-Found page carries none.
  const withContent = new Set(Object.values(graph.elements || {}).map((el) => el.route).filter(Boolean));
  const visited = sections.filter((n) => !n.pending && !n.unreachable);
  const collected = visited.filter((n) => withContent.has(n.url));
  const empty = visited.filter((n) => !withContent.has(n.url));
  const pending = sections.filter((n) => n.pending).length;
  const unreachable = sections.filter((n) => n.unreachable && n.unreachable !== 'param-pattern').length;
  const paramPatterns = nodes.filter((n) => n.unreachable === 'param-pattern').length;
  const declaredManifest = nodes.filter((n) => n.declared === true && n.unreachable !== 'param-pattern').length;
  // The gap, LISTED so the operator sees exactly which sections are empty or unreachable — never a
  // silent collapsed denominator.
  const visitedEmpty = empty.map((n) => n.url).sort((a, b) => String(a).localeCompare(String(b)));
  const notReached = sections
    .filter((n) => n.pending || (n.unreachable && n.unreachable !== 'param-pattern'))
    .map((n) => ({ route: n.url, reason: n.pending ? 'pending' : (typeof n.unreachable === 'string' ? n.unreachable : 'unreachable') }))
    .sort((a, b) => String(a.route).localeCompare(String(b.route)));
  return {
    declared: sections.length,
    collected: collected.length,     // reached WITH own content — the honest headline
    reached: visited.length,         // visited = collected + visited-but-empty (kept for callers)
    pending, unreachable, paramPatterns, declaredManifest,
    visitedEmpty, notReached,
  };
}

// One-line summary for the normal report header. Leads with COLLECTED so a bare report can never read
// "done" while declared sections are pending, empty, or redirecting.
export function routeCoverageLine(rc) {
  const param = rc.paramPatterns > 0 ? ` · ${rc.paramPatterns} param-pattern(s) (not directly navigated)` : '';
  const empty = rc.visitedEmpty.length > 0 ? ` · ${rc.visitedEmpty.length} visited-but-empty` : '';
  return `Declared sections: ${rc.collected}/${rc.declared} collected (own content)${empty} · ${rc.pending} pending · ${rc.unreachable} unreachable${param}`;
}

// The full --route-coverage view: the honest collected/visited-empty/unreachable/pending breakdown +
// the LISTS of visited-but-empty and not-yet-reached sections, so the gap is visible, never hidden.
export function renderRouteCoverage(rc) {
  const L = [];
  const param = rc.paramPatterns > 0 ? ` · ${rc.paramPatterns} param-pattern(s) (need concrete instances)` : '';
  L.push(`Route coverage: ${rc.collected} of ${rc.declared} declared sections collected (own content) · ${rc.visitedEmpty.length} visited-but-empty (Not-Found/content-starved) · ${rc.unreachable} unreachable (redirect/404) · ${rc.pending} pending${param}`);
  L.push(`(${rc.declaredManifest} of the declared sections came from the app's own route manifest — denominator, never a coverage claim)`);
  if (rc.visitedEmpty.length) {
    L.push('Visited but empty (navigated, rendered no controls — Not-Found / content-starved):');
    for (const r of rc.visitedEmpty) L.push(`  ${oneLine(String(r), 60)}`);
  }
  if (rc.notReached.length) {
    L.push('Not yet reached:');
    for (const n of rc.notReached) L.push(`  ${n.route}  (${oneLine(String(n.reason), 60)})`);
  }
  if (!rc.visitedEmpty.length && !rc.notReached.length) L.push('All declared sections collected their own content.');
  return L.join('\n');
}
