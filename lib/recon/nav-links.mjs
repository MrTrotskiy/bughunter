// nav-links — STRUCTURAL page→page navigation edges (type:'nav', provenance:'href'). This records the
// app's OWN link structure: how you get from one page to another — the connective tissue the connectome
// needs so pages that share NO endpoint are still visibly connected.
//
// DELIBERATELY separate from route-frontier (which stays edge-free) and from causal `triggers` edges:
// harvestLinks NEVER opens a causal window, never calls beginCause/addTrigger, and never touches request
// attribution. It only reads the LANDED page's a[href] set and records deduped route→route edges. Same-
// origin, in-scope, non-danger only — the exact gates route discovery already uses, no bypass.

import { routeKey, sameOrigin, isOffOriginHttp } from './scope.mjs';
import { routeRefused } from './danger-floor.mjs';

// The SINGLE writer of the `nav` edge shape (route→route). Deduped; a self-loop is a no-op. `extra` carries
// provenance ('href' from a link harvest, 'act' from an observed page.url() change during a measured act)
// and, for provenance:'act', the `via` template id — the causal control to CLICK to make the hop, turning
// the edge into a reachability path. NOT a causal `triggers` edge and NOT a causal window: this only
// records structural navigation, never touches request attribution.
export function pushNavEdge(graph, from, to, extra = {}) {
  if (!from || !to || from === to) return false;
  graph.edges = graph.edges || [];
  const f = `route:${from}`, t = `route:${to}`;
  if (graph.edges.some((e) => e.type === 'nav' && e.from === f && e.to === t)) return false;
  graph.edges.push({ from: f, to: t, type: 'nav', ...extra });
  return true;
}

// Read the current page's a[href] set and record deduped route→route `nav` edges from the LANDED route.
// Returns { linked, src }. A no-op-safe read: a page.evaluate failure yields { linked: 0 }.
export async function harvestLinks(page, graph, origin) {
  let hrefs = [];
  const src = routeKey(page.url());
  try { hrefs = await page.evaluate(() => [...document.querySelectorAll('a[href]')].map((a) => a.href)); }
  catch { return { linked: 0, src }; }
  let linked = 0;
  for (const href of hrefs) {
    if (!sameOrigin(origin, href) || isOffOriginHttp(origin, href)) continue; // scope: same-origin http only
    const dst = routeKey(href);
    if (!dst || dst === src) continue;                                        // skip self / same-page anchors
    if (routeRefused(dst)) continue;                                          // never link INTO a danger route
    if (pushNavEdge(graph, src, dst, { provenance: 'href' })) linked++;       // single-source the nav-edge shape
  }
  return { linked, src };
}
