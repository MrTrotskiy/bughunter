// route-frontier — a BREADTH-FIRST URL route queue that lives INSIDE graph.routes. Its job:
// discover every same-origin, in-scope page reachable by an a[href] harvest and visit each ONCE
// with a SNAPSHOT-ONLY step, so a whole-site crawl collects more than the entry page.
//
// Phantom-edge-safe BY CONSTRUCTION: discovery NEVER calls addTrigger / beginCause and NEVER opens
// a causal window. A route node asserts ONLY "exists / reachable" — navigation adds ZERO edges (the
// invariant the causal machinery rests on; request attribution stays token + initiator, never a
// side effect of loading a page). Acting stays in persistentStep's re-nav + causal act.
//
// The queue is NOT a second store: pending / pattern / siblings / unreachable are flags on the ONE
// graph.routes node. A url-PATTERN census bound keeps a 1000-row listing from exploding into 1000
// visits — exactly one representative concrete route per toUrlPattern, the rest tallied as siblings.
// Every gate is REUSED with no bypass: routeRefused (danger), sameOrigin / isOffOriginHttp (scope),
// navigateGated (SSRF), routeKey + toUrlPattern (the ONLY route/pattern maskers, no third normalizer).

import { navigateGated } from '../browser/session.mjs';
import { waitSettled } from '../browser/causal.mjs';
import { snapshotStep } from './step.mjs';
import { routeKey, sameOrigin, isOffOriginHttp } from './scope.mjs';
import { toUrlPattern } from '../graph/graph-store.mjs';
import { routeRefused } from './danger-floor.mjs';
import { dismissOverlays } from './overlays.mjs';

// The existing route node key that already REPRESENTS a url-pattern, or null. The census bound keeps
// ONE concrete route per pattern: a second href matching an existing pattern folds into its
// representative's siblings tally instead of enqueuing another visit. Matches on the stored `pattern`
// OR (for an act-landed route minted by mergeSnapshot with no `pattern` field) the recomputed
// toUrlPattern(url), so a page reached by ACTING still bounds later same-pattern harvests.
function representativeFor(graph, pattern) {
  for (const [rk, node] of Object.entries(graph.routes)) {
    if ((node.pattern || toUrlPattern(node.url)) === pattern) return rk;
  }
  return null;
}

// Read-only href harvest of the CURRENT page: enqueue the in-scope, same-origin, non-danger,
// not-yet-known routes as pending nodes (BFS). Writes graph.routes METADATA only — never elements,
// never edges. Returns { discovered, enqueued }.
export async function harvestRoutes(page, graph, origin) {
  let hrefs = [];
  try {
    hrefs = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.href));
  } catch { return { discovered: 0, enqueued: 0 }; }
  let enqueued = 0;
  for (const href of hrefs) {
    if (!sameOrigin(origin, href) || isOffOriginHttp(origin, href)) continue; // scope: same-origin http only
    const rk = routeKey(href);
    if (routeRefused(rk)) continue;                                           // danger: never enqueue /logout & friends
    if (graph.routes[rk]) continue;                                          // already known (visited or pending)
    const pattern = toUrlPattern(href);
    const rep = representativeFor(graph, pattern);
    if (rep) { graph.routes[rep].siblings = (graph.routes[rep].siblings || 0) + 1; continue; } // census bound
    graph.routes[rk] = { type: 'route', url: rk, pending: true, pattern, siblings: 0 };
    enqueued++;
  }
  return { discovered: hrefs.length, enqueued };
}

// The next pending route in deterministic key order, or null. Deterministic so a resumed / seeded
// drain is reproducible.
export function nextPendingRoute(graph) {
  const keys = Object.keys(graph.routes).filter((rk) => graph.routes[rk].pending === true).sort();
  return keys.length ? keys[0] : null;
}

// Promote a pending route to VISITED (drop the pending flag). Only ever called AFTER snapshotStep,
// so `visited ⟺ snapshotted` holds. No-op if the route is unknown.
export function markRouteVisited(graph, rk) {
  const node = graph.routes[rk];
  if (node) delete node.pending;
}

// Flag a discovered route reached-but-not-visited (404 / redirect / off-scope). Counted
// discovered-but-unreachable, NEVER dropped, never counted covered — the honest denominator.
export function markRouteUnreachable(graph, rk, reason) {
  const node = graph.routes[rk];
  if (!node) return;
  node.unreachable = reason || true;
  delete node.pending;
}

// Snapshot-only visit of ONE route. Re-navigates the page to rk (reconstructed against origin),
// gates it, snapshots the landed page into the graph (the ONLY graph write — edge-free), promotes
// the route to visited, and harvests its links (BFS). NEVER acts / opens a causal window. A route
// that fails its gates, 404s, or redirects off target is markRouteUnreachable (honest), not dropped.
export async function visitRoute(page, graph, ledger, rk, { origin }) {
  const navUrl = new URL(rk, origin).href;
  // Defense-in-depth (mirrors persistentStep): never navigate off-origin or to a danger route.
  if (!sameOrigin(navUrl, origin) || routeRefused(rk)) {
    markRouteUnreachable(graph, rk, 'refused');
    return { visited: false };
  }
  let response;
  try {
    ({ response } = await navigateGated(page, navUrl));
  } catch {
    markRouteUnreachable(graph, rk, 'nav-error');
    return { visited: false };
  }
  const status = response ? response.status() : 0;
  if (status >= 400) { markRouteUnreachable(graph, rk, 'http-4xx'); return { visited: false }; }
  const landed = page.url();
  // A redirect that LEFT THE ORIGIN — even path-preserving — must NEVER be snapshotted. routeKey is
  // path-only (host/scheme stripped), so a hostile target that 302s a same-origin href to a private or
  // foreign host on the SAME path would otherwise pass the routeKey check below and get the internal
  // response captured into the graph. Mirror actStep's post-nav guard (step.mjs). The blind GET already
  // happened (the accepted DNS-rebind/redirect residual) — this only refuses to CAPTURE the off-origin content.
  if (!sameOrigin(origin, landed) || isOffOriginHttp(origin, landed)) {
    markRouteUnreachable(graph, rk, 'redirect-offorigin');
    return { visited: false };
  }
  if (routeKey(landed) !== rk) { markRouteUnreachable(graph, rk, 'redirect'); return { visited: false }; }
  await waitSettled(page);
  // A CLIENT-SIDE redirect (React-Router <Navigate>, a load/effect-fired location change) lands AFTER
  // domcontentloaded, so the pre-settle `landed` guards above cannot see it. Re-read the SETTLED url
  // and re-apply BOTH guards: an off-origin hop stays redirect-offorigin; a SAME-ORIGIN redirect to a
  // DIFFERENT route (/events → /dashboard) must NOT be snapshotted under rk. The content it landed on
  // is already attributed to its OWN route by the element path — counting rk "reached" here would
  // double-attribute and lie; markRouteUnreachable keeps the denominator honest.
  const settled = page.url();
  if (!sameOrigin(origin, settled) || isOffOriginHttp(origin, settled)) {
    markRouteUnreachable(graph, rk, 'redirect-offorigin');
    return { visited: false };
  }
  if (routeKey(settled) !== rk) { markRouteUnreachable(graph, rk, 'redirect'); return { visited: false }; }
  await dismissOverlays(page);                     // cause is __idle__ — an accept-click forges no edge
  await snapshotStep(page, graph, ledger, rk);     // the ONLY graph write — no addTrigger, edge-free
  markRouteVisited(graph, rk);
  await harvestRoutes(page, graph, origin);        // BFS: enqueue links this page exposes
  return { visited: true };
}

// Seed phase: BFS-drain the discoverable route queue up front (edge-free), bounded by `budget`
// SUCCESSFUL visits. Beyond the budget, remaining pending routes stay flagged (honest — never
// silently dropped). Terminates because every iteration clears one route's pending flag (visited
// OR unreachable), so nextPendingRoute strictly shrinks the queue.
export async function seedRoutes(page, graph, ledger, { origin, budget = 200 } = {}) {
  let visited = 0;
  for (let rk = nextPendingRoute(graph); rk && visited < budget; rk = nextPendingRoute(graph)) {
    const res = await visitRoute(page, graph, ledger, rk, { origin });
    if (res.visited) visited++;
  }
  return { visited };
}

// Honest route-frontier denominator (never collapses). discovered = every route node; visited =
// snapshotted (non-pending, non-unreachable); pending = still queued; unreachable = flagged 404 /
// redirect / off-scope; patterns = distinct toUrlPattern over route nodes; siblingsFolded = census-
// folded concrete routes NOT separately visited (the bound's honesty number).
export function routeFrontierStats(graph) {
  const nodes = Object.values(graph.routes || {});
  let visited = 0; let pending = 0; let unreachable = 0; let siblingsFolded = 0;
  const patterns = new Set();
  for (const n of nodes) {
    patterns.add(toUrlPattern(n.url));
    siblingsFolded += n.siblings || 0;
    if (n.unreachable) unreachable++;
    else if (n.pending) pending++;
    else visited++;
  }
  return { discovered: nodes.length, visited, pending, unreachable, patterns: patterns.size, siblingsFolded };
}
