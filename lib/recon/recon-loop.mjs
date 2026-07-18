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
//   refill — optional async (graph) => bool, called when the TEMPLATE frontier is empty. It
//           drains one route from the route-frontier (route-frontier.mjs); a true return means it
//           made forward progress (a route visited → possibly new templates) so the loop retries
//           nextBatch instead of stopping. Undefined refill → empty batch stops the loop exactly as
//           before (pure node-loop tests unaffected). Drain ⟺ template frontier AND route queue empty.

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
export async function reconLoop(graph, { step, judge = identityJudge, budget = {}, size, seed, onStep, refill, relogin } = {}) {
  // A malformed/NaN budget must NOT silently short-circuit the loop (0 < NaN === false)
  // and then report 'frontier-drained' having done nothing — treat non-finite as unbounded.
  const maxSteps = Number.isFinite(budget.steps) ? budget.steps : Infinity;
  const steps = [];
  // Set when the run must abandon the drain early for a reason that is NOT frontier exhaustion (today:
  // a re-login that failed after a session-ending act). Reported, never silently swallowed.
  let stopped = null;
  while (steps.length < maxSteps) {
    // GOAL 5: seed re-permutes the emission order so budget-capped re-crawls differ (Chao2 variance).
    const batch = nextBatch(graph, { ...(size ? { size } : {}), seed });
    if (batch.length === 0) {
      // Template frontier empty: give the route-frontier a chance to visit one more page (which may
      // reveal new templates). Forward progress → retry; nothing left → drain. No refill → stop as before.
      if (refill && await refill(graph)) continue;
      break; // frontier drained → nothing left to explore
    }
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
      // SESSION REPAIR (explore-all): the act just ended the session — a Logout control, or a click on a
      // link to an auth route. Under explore-all these are FIRED rather than refused, which is the point;
      // but without re-authenticating here every SUBSEQUENT act would crawl as an anonymous user and the
      // rest of the run would silently collect /login instead of the app. The re-login is injected by the
      // caller (it owns the browser and the credentials), so this module stays driver-pure. A failed
      // re-login is recorded on the act and the loop stops — continuing logged-out would poison coverage
      // with a whole second, wrong surface.
      if (outcome.needsRelogin && relogin) {
        const ok = await relogin().catch(() => false);
        acts[acts.length - 1].reloggedIn = !!ok;
        if (!ok) { stopped = 'relogin-failed'; break; }
      }
    }
    if (stopped === 'relogin-failed') break;
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
    // An early abandon (a failed re-login) must NOT be reported as 'frontier-drained' — that would claim
    // the surface was exhausted when the run actually gave up mid-drain. Honest terminal, checked first.
    stopped: stopped || (steps.length >= maxSteps ? 'budget' : 'frontier-drained'),
    stats: frontierStats(graph),
  };
}
