// The Phase-1 recon loop-driver ("perceptron loop"). Each step pulls the frontier's
// next batch of unexplored templates (the receptive field), acts on each via an
// injected step primitive, marks it explored, and records what it caused/revealed.
// The loop stops when the frontier drains OR the step-budget is spent.
//
// Control-flow ONLY. Two collaborators are injected so this stays pure and testable
// without a browser, and so each can be swapped independently:
//   step  — async (graph, target) => { requests?, newElements?, error? }. Acts on
//           target.instance, mutates the graph (merge revealed elements, add trigger
//           edges). Today a cold-start browser step; task 4 swaps in a persistent
//           session so controls behind in-app state become reachable.
//   judge — (batch) => batch. Ranks/filters the receptive field (the LLM's semantic
//           pick). Default identity: act on the whole batch, first-seen order. Templates
//           the judge drops are still marked explored, so the frontier cannot starve.
//   onStep — optional async (graph) run after each step, for incremental persistence.

import { nextBatch, frontierStats } from './frontier.mjs';
import { markInstanceExplored, markInstanceUnreachable } from '../graph/graph-store.mjs';

// The instance a frontier target acts on — its explicit instanceKey, else the representative
// instance's key. Every drain/mark keys on (templateId, instanceKey) so an opener's sibling
// instances are tracked independently (marking template[0] must never drain its siblings).
const keyOf = (t) => (t.instanceKey != null ? t.instanceKey : (t.instance && t.instance.instanceKey));

const identityJudge = (batch) => batch;

// budget.steps — max receptive-field steps (context windows) before stopping; the
//   honest cap. Absent → bounded only by an empty frontier.
// size — receptive-field width per step (templates previewed by the judge).
export async function reconLoop(graph, { step, judge = identityJudge, budget = {}, size, onStep } = {}) {
  // A malformed/NaN budget must NOT silently short-circuit the loop (0 < NaN === false)
  // and then report 'frontier-drained' having done nothing — treat non-finite as unbounded.
  const maxSteps = Number.isFinite(budget.steps) ? budget.steps : Infinity;
  const steps = [];
  while (steps.length < maxSteps) {
    const batch = nextBatch(graph, size ? { size } : undefined);
    if (batch.length === 0) break; // frontier drained → nothing left to explore
    const chosen = judge(batch);
    const chosenKeys = new Set(chosen.map((t) => `${t.templateId}::${keyOf(t)}`));
    const acts = [];
    for (const target of chosen) {
      const instanceKey = keyOf(target);
      let outcome;
      try {
        outcome = await step(graph, target);
      } catch (err) {
        outcome = { error: err?.message || String(err) };
      }
      markInstanceExplored(graph, target.templateId, instanceKey); // drained from the frontier either way
      if (outcome.error) markInstanceUnreachable(graph, target.templateId, instanceKey, outcome.error); // acted but not reached
      acts.push({ templateId: target.templateId, instanceKey, name: target.name, ...outcome });
    }
    // Drain instances the judge dismissed this step, so a filtering judge cannot starve
    // the frontier — the loop must always make forward progress. Keyed on (templateId,
    // instanceKey) so dropping one instance never drains an opener's un-acted siblings.
    for (const target of batch) {
      const instanceKey = keyOf(target);
      if (chosenKeys.has(`${target.templateId}::${instanceKey}`)) continue;
      markInstanceExplored(graph, target.templateId, instanceKey);
      acts.push({ templateId: target.templateId, instanceKey, name: target.name, skipped: true });
    }
    steps.push(acts);
    if (onStep) await onStep(graph); // incremental persistence — a crash keeps prior steps
  }
  return {
    steps,
    stopped: steps.length >= maxSteps ? 'budget' : 'frontier-drained',
    stats: frontierStats(graph),
  };
}
