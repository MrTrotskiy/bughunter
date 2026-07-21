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
  // Sections = the STATIC declared routes: exclude `:param` PATTERN nodes (counted apart) AND the concrete
  // `paramInstanceOf` PROXIES (a visited /item/123 that represents its /item/:param pattern — counting
  // it as its own section would inflate the denominator by every drill-landing; GOAL 2).
  const sections = nodes.filter((n) => n.unreachable !== 'param-pattern' && !n.paramInstanceOf);
  // Routes that rendered their OWN content: ≥1 element template is attributed to the route. This is the
  // honest signal of a genuinely collected section — a redirect target or Not-Found page carries none.
  const withContent = new Set(Object.values(graph.elements || {}).map((el) => el.route).filter(Boolean));
  const visited = sections.filter((n) => !n.pending && !n.unreachable);
  // CLIENT-404 (GOAL 1): a route whose structural contentSig equals the negative-control probe sig
  // (graph.notFoundSig — route-frontier.probeNotFound) rendered the app's shared Not-Found shell and is a
  // dead route. Matched against a KNOWN-DEAD label, not an internal cluster, so there is no "which one
  // survives" pick.
  //
  // This USED to be restricted to visited-but-EMPTY routes, on the reasoning that a Not-Found page carries
  // no controls so the restriction could only ever prevent a false collapse. That assumption does not hold:
  // measured on the live target, the Not-Found shell renders ONE control (18 declared routes — /groups,
  // /feed, /reports, /engine.io … — all carry sig 2110f3b4 with exactly 1 own control). Each therefore had
  // content, landed in `collected`, and never reached the empty-only 404 filter — so 18 dead routes counted
  // as genuinely collected sections and inflated both the numerator and the collectable denominator.
  //
  // The sig is the label, and it is decisive: contentSig is structural (text-free, attr-free), so matching a
  // random nonexistent path byte-for-byte means the same shell rendered. The residual risk runs the other
  // way — a REAL page whose skeleton is identical to the shell would be labelled dead and leave `collectable`,
  // which is the direction the honesty invariant actually forbids. That is why every one is LISTED in
  // `clientNotFound` below: counted, named, checkable by hand, never silently dropped.
  const notFoundSig = graph.notFoundSig;
  const client404 = notFoundSig ? visited.filter((n) => n.contentSig && n.contentSig === notFoundSig) : [];
  const c404 = new Set(client404.map((n) => n.url));
  const collected = visited.filter((n) => withContent.has(n.url) && !c404.has(n.url));
  const trueEmpty = visited.filter((n) => !withContent.has(n.url) && !c404.has(n.url));
  const pending = sections.filter((n) => n.pending).length;
  const unreachable = sections.filter((n) => n.unreachable && n.unreachable !== 'param-pattern').length;
  const paramNodes = nodes.filter((n) => n.unreachable === 'param-pattern');
  const paramPatterns = paramNodes.length;
  const declaredManifest = nodes.filter((n) => n.declared === true && n.unreachable !== 'param-pattern').length;
  // PARAM COLLECTED (GOAL 2): a `:param` pattern counts collected when its representative concrete instance
  // (a node tagged paramInstanceOf this pattern) was GENUINELY visited with own content — not from static
  // analysis, from a real visit. The pattern node never leaves the denominator; it flips 0-collected →
  // collected-via-representative. `collectedTotal`/`collectableTotal` fold param patterns into the headline.
  const paramInsts = nodes.filter((n) => n.paramInstanceOf);
  const paramCollected = paramNodes.filter((pn) => {
    const rep = paramInsts.find((pi) => pi.paramInstanceOf === pn.url);
    return rep && !rep.pending && !rep.unreachable && withContent.has(rep.url);
  });
  const paramCollectedList = paramCollected.map((pn) => {
    const rep = paramInsts.find((pi) => pi.paramInstanceOf === pn.url);
    return { pattern: pn.url, via: rep.url, siblings: rep.siblings || 0 };
  }).sort((a, b) => String(a.pattern).localeCompare(String(b.pattern)));
  // The COLLECTABLE denominator: declared sections MINUS the proven phantoms (redirect/404 unreachable +
  // client-404). It never SHRINKS the declared total (all buckets still sum into `declared` and are
  // listed below) — it is the honest base for the coverage % so "95%" targets the genuinely reachable
  // surface, not an inflated 64 that includes 31 dead routes. A real content-starved section (trueEmpty)
  // STAYS in collectable — it is reachable, just empty (an honest gap), never a phantom.
  const collectable = sections.length - unreachable - client404.length;
  // The gap, LISTED so the operator sees exactly which sections are empty, phantom, or unreachable —
  // never a silent collapsed denominator.
  const visitedEmpty = trueEmpty.map((n) => n.url).sort((a, b) => String(a).localeCompare(String(b)));
  const clientNotFound = client404.map((n) => n.url).sort((a, b) => String(a).localeCompare(String(b)));
  const notReached = sections
    .filter((n) => n.pending || (n.unreachable && n.unreachable !== 'param-pattern'))
    .map((n) => ({ route: n.url, reason: n.pending ? 'pending' : (typeof n.unreachable === 'string' ? n.unreachable : 'unreachable') }))
    .sort((a, b) => String(a.route).localeCompare(String(b.route)));
  return {
    declared: sections.length,
    collectable,                     // static declared minus proven phantoms — the static coverage-% base
    collected: collected.length,     // static sections reached WITH own content — the static numerator
    reached: visited.length,         // visited = collected + visited-but-empty (kept for callers)
    pending, unreachable, paramPatterns, declaredManifest,
    clientNotFound404: client404.length, // constant-URL SPA dead routes (sig === notFoundSig)
    // GOAL 2 unified headline: fold the `:param` patterns collected via a real concrete visit into the
    // numerator + base. Each param pattern is collectable (a concrete instance can be reached).
    paramCollected: paramCollected.length,
    collectedTotal: collected.length + paramCollected.length,
    collectableTotal: collectable + paramPatterns,
    paramCollectedList,
    visitedEmpty, clientNotFound, notReached,
  };
}

// One-line summary for the normal report header. Leads with COLLECTED over the honest COLLECTABLE base
// (declared minus proven phantoms) so a bare report can never read "done" while sections are pending or
// empty, NOR read falsely-low because dead phantom routes inflate the denominator.
export function routeCoverageLine(rc) {
  const param = rc.paramPatterns > 0 ? ` · ${rc.paramCollected || 0}/${rc.paramPatterns} param-pattern(s) collected (via a concrete instance)` : '';
  const empty = rc.visitedEmpty.length > 0 ? ` · ${rc.visitedEmpty.length} visited-but-empty` : '';
  const dead = (rc.clientNotFound404 || 0) > 0 ? ` · ${rc.clientNotFound404} client-404` : '';
  return `Declared sections: ${rc.collected}/${rc.collectable} collected (own content, of ${rc.declared} declared − phantoms)${empty}${dead} · ${rc.pending} pending · ${rc.unreachable} unreachable${param}`;
}

// The full --route-coverage view: the honest collected/collectable breakdown + the phantom buckets
// (client-404, redirect/404 unreachable) + the LISTS of every empty / phantom / not-reached section,
// so the gap is visible and the denominator is NEVER a silent collapse — only relabelled.
export function renderRouteCoverage(rc) {
  const L = [];
  const param = rc.paramPatterns > 0 ? ` · ${rc.paramCollected || 0}/${rc.paramPatterns} param-pattern(s) collected via a concrete instance` : '';
  const dead = (rc.clientNotFound404 || 0) > 0 ? ` · ${rc.clientNotFound404} client-404 (constant-URL dead routes)` : '';
  L.push(`Route coverage: ${rc.collected} of ${rc.collectable} collectable sections collected (own content) — ${rc.declared} declared − ${rc.unreachable} unreachable − ${rc.clientNotFound404 || 0} client-404 phantoms · ${rc.visitedEmpty.length} visited-but-empty (real, content-starved)${dead} · ${rc.pending} pending${param}`);
  if ((rc.collectedTotal ?? rc.collected) !== rc.collected || rc.paramPatterns > 0) {
    L.push(`Including param patterns: ${rc.collectedTotal}/${rc.collectableTotal} collected (static sections + concrete :param instances)`);
  }
  L.push(`(${rc.declaredManifest} of the declared sections came from the app's own route manifest — denominator, never a coverage claim)`);
  if (rc.paramCollectedList && rc.paramCollectedList.length) {
    L.push('Param patterns collected via a concrete instance (represents that pattern; siblings folded):');
    for (const p of rc.paramCollectedList) L.push(`  ${oneLine(String(p.pattern), 40)}  ← ${oneLine(String(p.via), 40)}${p.siblings ? ` (+${p.siblings} folded)` : ''}`);
  }
  if (rc.clientNotFound && rc.clientNotFound.length) {
    L.push('Client-404 (constant-URL SPA rendered the shared Not-Found shell — a dead route, phantom denominator):');
    for (const r of rc.clientNotFound) L.push(`  ${oneLine(String(r), 60)}`);
  }
  if (rc.visitedEmpty.length) {
    L.push('Visited but empty (real section, navigated, rendered no controls — content-starved):');
    for (const r of rc.visitedEmpty) L.push(`  ${oneLine(String(r), 60)}`);
  }
  if (rc.notReached.length) {
    L.push('Not yet reached:');
    for (const n of rc.notReached) L.push(`  ${n.route}  (${oneLine(String(n.reason), 60)})`);
  }
  if (!rc.visitedEmpty.length && !rc.notReached.length && !(rc.clientNotFound && rc.clientNotFound.length)) {
    L.push('All collectable sections collected their own content.');
  }
  return L.join('\n');
}
