// The three JOIN KEYS between a recall manifest case and the crawl's graph, isolated so they
// are unit-testable in one place. Imports ONLY read-only helpers from lib — the scorer reads the
// crawl's OUTPUT, it never drives the crawl, so ground truth cannot reach the crawler.
//
//   control  -> node.testid (the crawler captures it BLIND as non-identity metadata) when the case
//               is testid-identified; else a route+role+name match (weaker, for positional/role-name).
//   endpoint -> the request node key. The crawler masks a fired /api/contacts/1 to /api/contacts/:param
//               via toUrlPattern; a declared pattern is normalized the SAME way (instantiate its :params
//               to a concrete id, then mask) so /api/contacts/:id and the crawler's :param join.
//   route    -> a route is COLLECTED when the graph carries an element attributed to it (own content),
//               not merely visited.

import { toUrlPattern } from '../../lib/graph/graph-store.mjs';
import { routeKey } from '../../lib/recon/scope.mjs';

// The request-node pattern a declared endpoint would produce once fired and masked. A declared
// ':id'/':handle' is instantiated to a concrete numeric id, then run through the crawler's own mask.
// NOTE: a string-keyed param (/user/:handle) leaves a word segment unmasked in toUrlPattern, so a
// non-numeric param would need matchParamPattern; the seed endpoints are numeric-id, which this covers.
export function endpointPattern(pattern) {
  return toUrlPattern(pattern.replace(/:[^/]+/g, '1'));
}

// Find the graph element node for a case, or null. testid join for the testid class; a structural
// route+role+name match otherwise (a positional case with an empty name falls back to route+role).
export function findControl(graph, c) {
  const nodes = Object.values(graph.elements || {});
  if (c.identityClass === 'testid' && c.testid) {
    return nodes.find(
      (n) => n.testid === c.testid || (n.instances || []).some((i) => i.testid === c.testid),
    ) || null;
  }
  const wantRoute = routeKey(c.route);
  return nodes.find((n) => {
    if (routeKey(n.route) !== wantRoute) return false;
    // role-name: the NAME is the discriminator (a `<tr>` the crawler classifies role 'generic'
    // must still join the declared role 'row'); positional (empty name): fall back to route+role.
    return c.name ? n.name === c.name : n.role === c.role;
  }) || null;
}

// True iff a causal edge attributes the case's endpoint to THIS control node.
export function endpointAttributed(graph, node, c) {
  if (!node || !c.endpoint) return false;
  const to = `request:${String(c.endpoint.method).toUpperCase()} ${endpointPattern(c.endpoint.pattern)}`;
  const from = `element:${node.templateId}`;
  return (graph.edges || []).some((e) => e.from === from && e.to === to);
}

// True iff the case's endpoint was fired by ANYTHING (the request node exists) — a weaker signal
// than attribution, used to explain a found control whose edge is missing.
export function endpointFired(graph, c) {
  if (!c.endpoint) return false;
  const key = `${String(c.endpoint.method).toUpperCase()} ${endpointPattern(c.endpoint.pattern)}`;
  return !!(graph.requests && graph.requests[key]);
}

// True iff the route rendered its OWN content (some element is attributed to it).
export function routeCollected(graph, route) {
  const want = routeKey(route);
  return Object.values(graph.elements || {}).some((n) => routeKey(n.route) === want);
}
