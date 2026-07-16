// report --unreached: classify every NOT-fully-exercised control into a fail-reason bucket —
// the go/no-go artifact. After a crawl an operator needs to see WHY anything is left: budget
// (the loop stopped early) vs a real reach/identity gap (a stale/too-deep/cyclic reveal, a
// cold-start miss, a danger-floor refusal). Pure over (graph, the trail's act.failed events,
// frontierInstanceStats) — no disk, no browser, fully testable.

import { oneLine } from '../core/text.mjs';

// The two COARSE unreachable reasons the AGENT path stamps (observe.mjs UNREACHED). They are a
// closed, low-cardinality set safe to use verbatim as a bucket key; anything else on
// node.unreachable is a NODE-path raw message — tokenized to its leading UPPER_SNAKE code or
// bucketed `other`, so raw error prose never explodes the histogram into unique buckets.
const COARSE_REASONS = new Set(['unreachable-coldstart', 'not-visible']);

// Bucket key for an unreachable template with NO trail code: a known agent coarse reason
// verbatim, else a node-path message's leading UPPER token, else `other`. oneLine-sanitized.
function coarseBucket(unreachable) {
  const raw = typeof unreachable === 'string' ? unreachable : '';
  if (COARSE_REASONS.has(raw)) return oneLine(raw, 40);
  const m = /^[A-Z][A-Z0-9_]+/.exec(raw);
  return oneLine(m ? m[0] : 'other', 40);
}

// Classify each discovered template. Precedence (first match wins):
//   1. danger-floor — explored + observed but semantics.acted===false with a danger set: the
//      danger-floor refused to fire it, so it is NOT covered — surface it distinctly.
//   2. genuine coverage — explored && !unreachable — skip (this is real coverage).
//   3. unreachable — bucket by the LATEST act.failed CODE for this templateId when the trail
//      has one (granular: REVEAL_STALE / NOT_VISIBLE / ...), else the coarse graph reason. The
//      graph reason is COARSE on the agent path, so the trail code is preferred when present.
//   4. unexplored — !explored && !unreachable — the frontier never drained it.
export function buildUnreached(graph, actFailed = [], instanceStats = null, runId = null) {
  const buckets = {};
  const bump = (k) => { buckets[k] = (buckets[k] || 0) + 1; };

  // Latest act.failed CODE per templateId — last matching event wins (the most recent try).
  const lastCode = {};
  for (const f of actFailed) {
    if (f && f.templateId != null && f.code) lastCode[f.templateId] = String(f.code);
  }

  const templates = Object.values(graph.elements);
  for (const n of templates) {
    const sem = n.semantics || {};
    if (n.explored && !n.unreachable && sem.acted === false && sem.danger) { bump('danger-floor'); continue; }
    if (n.explored && !n.unreachable) continue; // genuine coverage
    if (n.unreachable) {
      const code = lastCode[n.templateId];
      bump(code ? oneLine(code, 40) : coarseBucket(n.unreachable));
      continue;
    }
    bump('unexplored'); // !explored && !unreachable
  }

  const uncovered = Object.values(buckets).reduce((a, b) => a + b, 0);
  // Honest location count derived from the already-captured reveal paths (location-key.mjs). Threaded
  // from the instanceStats the caller already computed — no second graph traversal.
  const locations = instanceStats?.locations || { discovered: 0 };
  return {
    ok: true,
    discovered: templates.length,
    uncovered,
    buckets,
    locations,
    // The location split is now REAL for every DISCOVERED location: locationKey (route + the
    // reveal-path opener hops) distinguishes the distinct POST-nav sections a single-URL SPA would
    // otherwise collapse under one routeKey, so an `unexplored` control is honest BUDGET (the loop
    // stopped early), not an unsplittable route-collapse ambiguity. This retires pending-INC.3 for the
    // discovered set — undiscovered locations stay part of the uncountable never-discovered set (below).
    routeCollapse: 'split-by-location',
    instanceCoverage: instanceStats,
    cappedRemainder: instanceStats ? instanceStats.cappedRemainder : 0,
    // Non-opener list-row rows beyond the drilled representative — counted, flagged, never walked (the
    // non-opener analog of cappedRemainder). Threaded from instanceStats so the report never hides them.
    drillSkipped: instanceStats ? instanceStats.drillSkipped : 0,
    runId,
    // We count only what the crawl DISCOVERED. A never-discovered control — AND a POST-nav location
    // the crawl never navigated to (never discovered → no reveal path to key it by) — cannot appear in
    // any denominator; do not invent a fabricated "never-found" number to look complete. Retiring
    // pending-INC.3 splits the DISCOVERED locations, it does NOT claim the undiscovered ones are counted.
    note: 'never-discovered controls AND undiscovered POST-nav locations are structurally uncountable — you cannot enumerate what was never found; only discovered locations are split',
  };
}

// Compact text render of the histogram (the default `report --unreached` surface).
export function renderUnreached(rep) {
  const L = [`Unreached analysis — ${rep.uncovered} of ${rep.discovered} uncovered · run ${rep.runId || 'none'}`];
  // Buckets by count desc, name asc as the tiebreak (stable, scannable).
  const entries = Object.entries(rep.buckets).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const discoveredLocations = rep.locations ? rep.locations.discovered : 0;
  for (const [bucket, count] of entries) {
    // The location-split honesty tag rides ONLY the unexplored line (see routeCollapse above): with the
    // discovered locations now split, this bucket is honest BUDGET across that many known sections.
    const tag = bucket === 'unexplored' ? `  [budget — discovered locations: ${discoveredLocations}]` : '';
    L.push(`  ${oneLine(bucket, 40)} : ${count}${tag}`);
  }
  const ic = rep.instanceCoverage;
  if (ic) {
    L.push(`Instances: ${ic.walked}/${ic.walkable} walked · ${ic.remaining} remaining unexplored · ${rep.cappedRemainder} beyond-cap (flagged) · ${rep.drillSkipped} drill-skipped (flagged)`);
  }
  L.push(`Locations: ${discoveredLocations} discovered`);
  L.push(rep.note);
  return L.join('\n');
}
