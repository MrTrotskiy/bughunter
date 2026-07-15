// Frontier selection for the Phase-1 recon loop ("perceptron loop"). Pure over the
// graph: pick the next small batch of UNEXPLORED element templates — the receptive
// field the step primitive will act on — and report the honest coverage denominator.
//
// The loop's control-flow half lives here; the semantic half (which of the batch is
// worth acting on, what an action meant) is the LLM judge's job, added separately.
// Acting on a template and calling markExplored is the loop-driver's job, not this
// module's — frontier only decides WHAT to look at next.

export const RECEPTIVE_FIELD = 3; // default number of NEW templates studied per step
// Per-opener instance cap: how many instances of a proven OPENER template the frontier will hand
// out (a nav bar of 3, a segmented control of 4). Bounds explosion on a homogeneous 50-row opener
// — after the cap, the rest stay un-enumerated (honest: report surfaces the un-walked remainder).
export const OPENER_INSTANCE_CAP = 8;

// The next up-to-`size` UNEXPLORED element INSTANCES the loop should act on (the receptive field),
// each paired with the instance to act on and its reveal path. Deterministic ascending
// (templateId, instance-index) order so a resumed run continues where it stopped.
//   - instance[0] of every template is eligible (the representative — the pre-state-model behavior).
//   - instances[1..] are eligible ONLY for a proven OPENER (acting an instance revealed new controls
//     on the same route), capped at OPENER_INSTANCE_CAP — so a nav bar of instances-of-one-template
//     gets every entry walked (the rawcaster instance-not-template gap), without a 50-row blowup.
// Backward-compat: instance[0] counts explored if EITHER inst.explored OR the template-level
// node.explored is set (the agent path's template-level markExplored still drains a plain control).
export function nextBatch(graph, { size = RECEPTIVE_FIELD } = {}) {
  const out = [];
  const ids = Object.keys(graph.elements).map(Number).sort((a, b) => a - b);
  for (const tid of ids) {
    const node = graph.elements[tid];
    if (!node.instances || node.instances.length === 0) continue;
    const limit = node.opener ? Math.min(node.instances.length, OPENER_INSTANCE_CAP) : 1;
    for (let i = 0; i < limit; i++) {
      const inst = node.instances[i];
      const explored = inst.explored || inst.unreachable || (i === 0 && node.explored);
      if (explored) continue;
      out.push({
        templateId: tid,
        role: node.role,
        name: node.name,
        route: node.route,
        // The reveal path to reach this control behind an in-page action (null for a control present
        // on direct navigation). Instance-level first (the state model), falling back to the
        // template-level annotation for the representative instance. persistentStep replays it.
        reveal: inst.reveal || node.reveal || null,
        instance: inst,
        instanceKey: inst.instanceKey,
      });
      if (out.length >= size) return out;
    }
  }
  return out;
}

// Honest, non-collapsing denominator over discovered templates. `discovered` counts
// every template ever seen and never shrinks. A template that was drained but never
// genuinely reached (`node.unreachable`, e.g. cold-start could not resolve it) is
// counted in `unreachable`, NOT in `explored` — so `explored` reflects real coverage,
// never inflated by the error path. `remaining` = still in the frontier (not yet
// drained). Termination is driven by nextBatch returning [], not by remaining == 0.
export function frontierStats(graph) {
  const ids = Object.keys(graph.elements);
  let exploredFlag = 0;
  let unreachable = 0;
  for (const id of ids) {
    const node = graph.elements[id];
    if (node.explored) exploredFlag++;
    if (node.unreachable) unreachable++;
  }
  const discovered = ids.length;
  return {
    discovered,
    explored: exploredFlag - unreachable,
    unreachable,
    remaining: discovered - exploredFlag,
    // Routes reached and snapshotted so far (grows as nav acts discover new pages, never
    // shrinks). A single-page run reports 1; a multi-route crawl reports the pages mapped.
    routes: graph.routes ? Object.keys(graph.routes).length : 0,
  };
}
