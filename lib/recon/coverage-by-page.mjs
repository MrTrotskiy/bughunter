// coverage-by-page — the PER-PAGE ledger the controller shows: for every page the crawl has touched,
// how many UI elements it holds, how many are already collected (clicked), and how many still remain.
// This is the "the script remembers each page had N elements, we clicked M, so K are still left, go back
// and finish them" view the operator asked for. It never re-derives coverage logic: it slices the ONE
// graph per page and runs the CANONICAL frontier counters over each slice, so a per-page number can never
// drift from the global one (same predicates, same drain rules — just grouped by route).
//
// "Elements" here means INSTANCES (every button, every row, every menu item), because that is what a human
// counts on a page — not templates. A 50-row table is 50 elements, one template. TOTAL = walkable
// (walked + remaining + unreachable); templates.* is carried alongside for the compact secondary view.

import { frontierStats, frontierInstanceStats } from './frontier.mjs';

// CLASSIFICATION — "how many of these do we actually UNDERSTAND?", which is NOT the same question as
// "how many did we click". Clicking drains the frontier; only an `observe` writes `node.semantics`
// ({purpose, danger, effect, acted, stateChange}). The two diverge by design: the deterministic
// node-loop (recon-run) acts without judging, so it can leave a page fully walked yet fully
// unexplained — exactly the state the operator wants surfaced rather than reported as "done".
//
// Buckets (a template is in exactly one):
//   known       — carries semantics: we know what it is and what it did.
//   clicked     — acted on, but nobody wrote down what it is (the node-loop's honest residual).
//   untouched   — never acted on at all.
// Plus a cross-cutting read of the KNOWN ones:
//   inert       — acted, classified, and it caused NO request and revealed NOTHING. The literal
//                 answer to "is this even an element?" — it looked interactive and did nothing.
//   byDanger    — the recorded class histogram (safe / destructive / auth / payment / unknown / …).
// `unknown` in byDanger means the judge looked and could not tell — deliberately distinct from
// `clicked` (nobody looked) and from `untouched` (nobody clicked).
export function classifyStats(elements, triggered) {
  const out = { known: 0, clicked: 0, untouched: 0, inert: 0, byDanger: {} };
  for (const [id, node] of Object.entries(elements || {})) {
    const sem = node.semantics;
    if (sem) {
      out.known++;
      const d = sem.danger || 'unknown';
      out.byDanger[d] = (out.byDanger[d] || 0) + 1;
      // Inert = genuinely acted, yet it moved nothing: no causal request edge, not a proven opener.
      // Restricted to `acted` so a deliberately-skipped control is never miscounted as dead.
      if (sem.acted && !node.opener && !(triggered && triggered.has(String(id)))) out.inert++;
    } else if (node.explored) {
      out.clicked++;
    } else {
      out.untouched++;
    }
  }
  return out;
}

// Template ids that have at least one CAUSAL request edge — the "it did something observable" set.
// Read once per render so classifyStats stays O(elements), not O(elements × edges).
//
// Two shapes must not be confused: a causal trigger edge is `{from:'element:<id>', to:'request:<key>',
// type:'triggers', provenance:'causal'}`, while nav-links.mjs pushes STRUCTURAL page→page edges
// (provenance 'href'/'act') that assert reachability, NOT causation. Counting a nav edge here would
// mark a plain link as "did something", hiding genuinely inert controls — so filter on the causal type.
export function triggeredTemplates(graph) {
  const out = new Set();
  for (const e of graph.edges || []) {
    if (!e || e.type !== 'triggers' || e.provenance !== 'causal') continue;
    const m = /^element:(.+)$/.exec(String(e.from || ''));
    if (m) out.add(m[1]);
  }
  return out;
}

// Group element templates by the page (routeKey) they live on. An element with no route is bucketed under
// '(unknown)' — honest, never silently dropped.
function elementsByRoute(graph) {
  const byRoute = new Map();
  for (const [id, node] of Object.entries(graph.elements || {})) {
    const rk = node.route || '(unknown)';
    if (!byRoute.has(rk)) byRoute.set(rk, {});
    byRoute.get(rk)[id] = node;
  }
  return byRoute;
}

// Per-page coverage rows, sorted by route. Union of pages that HAVE collected elements and pages the
// route-frontier knows about (a page can be pending/visited-but-empty with zero elements yet). Each row
// reuses the canonical counters over a one-page slice of the graph — zero logic duplication.
export function perRouteCoverage(graph) {
  const byRoute = elementsByRoute(graph);
  const routes = graph.routes || {};
  const allRoutes = new Set([...byRoute.keys(), ...Object.keys(routes)]);
  const triggered = triggeredTemplates(graph);   // computed once, shared by every page's classify pass

  const rows = [];
  for (const rk of [...allRoutes].sort()) {
    const elements = byRoute.get(rk) || {};
    const slice = { elements, routes: {} };          // routes:{} → frontierStats.routes is 0 here (unused per-page)
    const t = frontierStats(slice);                  // template-level: discovered / explored / remaining
    const inst = frontierInstanceStats(slice);        // instance-level: walkable / walked / remaining / unreachable
    const rnode = routes[rk];
    rows.push({
      route: rk,
      known: !!rnode,
      pending: !!(rnode && rnode.pending),
      unreachable: !!(rnode && rnode.unreachable),
      // KEEP THE REASON, not just the fact. Collapsing it to a boolean made a param PATTERN
      // (`/<entity>/$id` — counted in the denominator, never navigated, its concrete instances collected
      // separately) render identically to a genuine 404, so the ledger reported the richest page in the
      // application as "unreachable" when it was working exactly as designed.
      unreachableReason: (rnode && rnode.unreachable) || null,
      visited: !!(rnode && !rnode.pending && !rnode.unreachable),
      // "elements" the operator counts — instance level.
      done: inst.walked,
      left: inst.remaining,
      unreach: inst.unreachable,
      total: inst.walkable,
      // Flagged-but-never-walked overflow (opener siblings past the cap, list rows past the drilled one,
      // re-rendered-away feed rows) — surfaced so a page's "left" is honest, never hiding capped work.
      capped: inst.cappedRemainder,
      drillSkipped: inst.drillSkipped,
      churnSkipped: inst.churnSkipped,
      // Template-level companion (a page's distinct control kinds), for the compact secondary column.
      templates: { total: t.discovered, explored: t.explored, remaining: t.remaining },
      // What we UNDERSTAND on this page (template-level, since semantics are recorded per template):
      // known / clicked-but-unexplained / never-touched, plus the inert + danger read of the known ones.
      classify: classifyStats(elements, triggered),
    });
  }
  return rows;
}

// Roll the per-page rows into the global tallies (a cross-check that the per-page sum equals the global
// frontier numbers — same slices, same counters).
export function coverageTotals(rows) {
  return rows.reduce(
    (a, r) => ({
      done: a.done + r.done, left: a.left + r.left, unreach: a.unreach + r.unreach, total: a.total + r.total,
      pagesWithWork: a.pagesWithWork + (r.left > 0 ? 1 : 0),
      pagesPending: a.pagesPending + (r.pending ? 1 : 0),
      // Understanding rolls up alongside coverage, so the summary can never claim a fully-walked site
      // is a fully-understood one.
      known: a.known + (r.classify?.known || 0),
      clicked: a.clicked + (r.classify?.clicked || 0),
      untouched: a.untouched + (r.classify?.untouched || 0),
      inert: a.inert + (r.classify?.inert || 0),
      byDanger: mergeCounts(a.byDanger, r.classify?.byDanger),
    }),
    { done: 0, left: 0, unreach: 0, total: 0, pagesWithWork: 0, pagesPending: 0, known: 0, clicked: 0, untouched: 0, inert: 0, byDanger: {} },
  );
}

function mergeCounts(into, add) {
  if (!add) return into;
  const out = { ...into };
  for (const [k, v] of Object.entries(add)) out[k] = (out[k] || 0) + v;
  return out;
}
