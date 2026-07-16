// location-key — derive a stable LOCATION identifier for a control from its ALREADY-CAPTURED
// reveal path. On a single-URL SPA that swaps content client-side over POST, routeKey(page.url())
// returns the SAME string for every section, so graph.routes holds one entry and the frontier/report
// treat the whole app as one flat location. But the crawl already records, per control, the ordered
// opener hops that reach it (inst.reveal.statePath = [{templateId, instanceKey}]) — two controls
// behind DIFFERENT opener paths sit in DIFFERENT sections. This turns that latent, zero-body-cost
// signal into an honest location key.
//
// FRONTIER/REPORTING HINT ONLY — which section a control lives in. NEVER an identity key or a graph
// edge input (invariant #2, the reference's death trap): it is DERIVED from the reveal path, so it
// adds ZERO id/edge churn. Never stored in a node id, an edge, or a reqKey — only computed on demand.

// Stable deterministic string identifying a LOCATION. Empty statePath → the route itself (the
// root/baseline location); otherwise route + '|' + a JSON-encoded array of [templateId,
// instanceKey] tuples. JSON encoding is collision-safe: an instanceKey is `rowKey` — up to 48
// chars of RAW page textContent — so an ad-hoc `templateId:instanceKey` join joined with '>' let
// a '>'/':'/' |'  inside the text forge a hop boundary (statePath [{1,'2>3:4'}] collided with
// [{1,'2'},{3,'4'}]), silently under-counting locations. Tuple + JSON escaping makes any
// separator char in the data unambiguous. Pure: no I/O, no randomness, order-preserving (a
// different hop order is a different location).
export function locationKey(route, statePath = []) {
  if (!statePath || statePath.length === 0) return route;
  return route + '|' + JSON.stringify(statePath.map((s) => [s.templateId, String(s.instanceKey)]));
}
