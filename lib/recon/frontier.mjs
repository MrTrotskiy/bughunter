// Frontier selection for the Phase-1 recon loop ("perceptron loop"). Pure over the
// graph: pick the next small batch of UNEXPLORED element templates — the receptive
// field the step primitive will act on — and report the honest coverage denominator.
//
// The loop's control-flow half lives here; the semantic half (which of the batch is
// worth acting on, what an action meant) is the LLM judge's job, added separately.
// Acting on a template and calling markExplored is the loop-driver's job, not this
// module's — frontier only decides WHAT to look at next.

export const RECEPTIVE_FIELD = 3; // default number of NEW templates studied per step

// The next up-to-`size` element templates the loop has not yet explored, each paired
// with a representative instance to act on. Deterministic ascending-templateId order
// so a resumed run continues where the last one stopped. Templates with no addressable
// instance are skipped (nothing to click) — they never stall the loop.
export function nextBatch(graph, { size = RECEPTIVE_FIELD } = {}) {
  const out = [];
  const ids = Object.keys(graph.elements).map(Number).sort((a, b) => a - b);
  for (const tid of ids) {
    const node = graph.elements[tid];
    if (node.explored) continue;
    if (!node.instances || node.instances.length === 0) continue;
    out.push({
      templateId: tid,
      role: node.role,
      name: node.name,
      route: node.route,
      // GAP 2 (stay-on-page): the reveal path to reach a control behind an in-page action
      // (null for a control present on direct navigation). The persistentStep replays it
      // before acting. The ONLY frontier change — frontierStats stays template-count.
      reveal: node.reveal || null,
      instance: node.instances[0],
    });
    if (out.length >= size) break;
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
