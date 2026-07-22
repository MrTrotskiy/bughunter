// The RECALL SCORER — reads the crawl's OUTPUT (state/graph.json) and the fixture's emitted
// manifest + effect counters, and reports how many planted cases the crawl actually discovered,
// sliced by case-class AND identity-difficulty class. It lives OUTSIDE lib/ on purpose: it must be
// structurally impossible to import into the crawl, so ground truth can never become a crawl input.
//
// A miss/extra is reported by testid (or case id when the testid is null) so the operator can act.
// The fixture recall number is a REGRESSION signal, never a capability claim (decisions.md 2026-07-22).

import { loadGraph } from '../../lib/graph/graph-store.mjs';
import { findControl, endpointAttributed, endpointFired, routeCollected } from './join.mjs';

// Evaluate ONE case against the graph. `found` composes the control join with the class-specific
// success signal; a danger case is found only when discovered AND correctly declined (effect === 0).
function scoreCase(graph, effects, c) {
  const node = findControl(graph, c);
  const controlFound = !!node;
  const attributed = endpointAttributed(graph, node, c);
  const fired = endpointFired(graph, c);
  const danger = !!c.danger;
  const effectCount = c.endpoint && c.endpoint.effect ? (effects[c.endpoint.effect] || 0) : 0;

  let found;
  let how;
  let declinedCorrectly = null;
  if (danger) {
    // effect === 0 means the control's endpoint was NOT FIRED — it does NOT by itself prove the control
    // was ATTEMPTED and refused (a discovered-but-never-reached control also has a 0 counter). The scorer
    // reads graph.json only, where a declined control (not `explored`, no edge) is indistinguishable from
    // an unreached one; the live test supplies the attempt-then-refusal evidence from the run's gate trail
    // (decisions.md 2026-07-22). So this credits "discovered AND not fired", verified against firing live.
    declinedCorrectly = effectCount === 0;
    found = controlFound && declinedCorrectly;
    how = 'effect';
  } else if (c.endpoint) {
    found = controlFound && (attributed || fired);
    how = attributed ? 'toUrlPattern-attributed' : fired ? 'toUrlPattern-fired' : null;
  } else {
    found = controlFound && routeCollected(graph, c.route);
    how = 'routeKey';
  }

  const railFailed = danger && controlFound && effectCount > 0; // fired a control it should have declined
  return {
    id: c.id,
    caseClass: c.caseClass,
    identityClass: c.identityClass,
    testid: c.testid,
    expectReach: c.expectReach !== false,
    controlFound,
    found: !!found,
    how: found ? how : null,
    declinedCorrectly,
    railFailed,
  };
}

function tally(rows) {
  const found = rows.filter((r) => r.found).length;
  const total = rows.length;
  return {
    found,
    total,
    recall: total ? +(found / total).toFixed(3) : 0,
    missed: rows.filter((r) => !r.found).map((r) => r.testid || r.id),
  };
}

function groupBy(rows, key) {
  const out = {};
  for (const r of rows) (out[r[key]] = out[r[key]] || []).push(r);
  return Object.fromEntries(Object.entries(out).map(([k, rs]) => [k, tally(rs)]));
}

export function scoreRecall(graph, manifest, effects = {}) {
  const cases = manifest.cases || [];
  const perCase = cases.map((c) => scoreCase(graph, effects, c));

  // Extras: graph element nodes carrying a testid the manifest never declared (over-detection /
  // phantom templates). Reported, never dropped.
  const declaredTestids = new Set(manifest.testids || []);
  const extras = [];
  for (const n of Object.values(graph.elements || {})) {
    if (n.testid && !declaredTestids.has(n.testid)) extras.push(n.testid);
  }

  return {
    overall: tally(perCase),
    // The subset the CURRENT crawler is expected to reach — this is the recall that must stay at 1.
    expected: tally(perCase.filter((r) => r.expectReach)),
    byCaseClass: groupBy(perCase, 'caseClass'),
    byIdentityClass: groupBy(perCase, 'identityClass'),
    perCase,
    railFailures: perCase.filter((r) => r.railFailed).map((r) => r.id),
    // Documented known-misses that were indeed missed (honest limitations, e.g. hover-only).
    knownMisses: perCase.filter((r) => !r.expectReach && !r.found).map((r) => r.id),
    // Cases we expected to MISS but the crawler reached — a progress signal: promote to expectReach.
    surprises: perCase.filter((r) => !r.expectReach && r.found).map((r) => r.id),
    extras: [...new Set(extras)],
  };
}

// Convenience: score straight off a graph.json path (the live test writes one, then reads it back).
export function scoreRecallFromDisk(graphPath, manifest, effects) {
  return scoreRecall(loadGraph(graphPath), manifest, effects);
}
